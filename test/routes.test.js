'use strict';

/* Integrationstests gegen eine echte Instanz auf einem freien Port. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');

const { startTestApp } = require('./helpers/app');
const { createApp } = require('../server');
const { totpAt } = require('../lib/totp');

/* ============================================================ Oeffentlich */

test('Dashboard /admin traegt die Live-Bereiche fuer live-regions.js (Backups, Ticket-Uebersicht, Zaehler)', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const page = async () => (await fetch(app.url('/admin'), {
        headers: { Cookie: cookie, 'X-Idle-Background': '1' },
    })).text();
    const before = await page();
    assert.match(before, /<body data-live-page data-live-url="\/admin">/);
    for (const key of ['nav-count', 'ticket-tab-badge', 'ticket-overview', 'backups', 'backup-settings', 'audit']) {
        assert.match(before, new RegExp(`data-live-region="${key}"`), key);
    }
    assert.match(before, /data-backup-empty/);
    assert.match(before, /name="intervalMinutes"/);
    for (const id of ['usernameInput', 'totpStatusBadge', 'totpSetupButton', 'totpDisableButton']) {
        assert.match(before, new RegExp(`id="${id}"`), id);
    }

    // Eine neue Sicherung (z. B. aus dem Zeitplan) taucht beim naechsten Poll auf.
    const created = await fetch(app.url('/admin/backups'), {
        method: 'POST', headers: { Cookie: cookie, Accept: 'application/json', Origin: app.url('') },
    });
    assert.equal(created.status, 201);
    assert.match(await page(), /data-backup-file="ticket-system-/);
});

test('/partials/nav: Ticket-Zaehler fuer Seiten ohne eigenes Polling, leer fuer Anonyme', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const anonymous = await fetch(app.url('/partials/nav'), { headers: { Accept: 'application/json' } });
    assert.equal(anonymous.status, 200);
    assert.deepEqual(await anonymous.json(), { regions: { 'nav-count': '' } });

    const { cookie } = await app.login();
    const admin = await (await fetch(app.url('/partials/nav'), {
        headers: { Cookie: cookie, Accept: 'application/json', 'X-Idle-Background': '1' },
    })).json();
    assert.equal(typeof admin.regions['nav-count'], 'string');

    // Die statischen Seiten binden live-regions.js dafuer ein (ohne eigenes
    // data-live-page), die Datenschutzerklaerung ist selbst live (Fristen).
    for (const pathname of ['/imprint', '/privacy', '/support']) {
        const html = await (await fetch(app.url(pathname), { headers: { Cookie: cookie } })).text();
        assert.match(html, /\/js\/live-regions\.js/, pathname);
        assert.match(html, /data-live-region="nav-count"/, pathname);
    }
    const privacy = await (await fetch(app.url('/privacy'))).text();
    assert.match(privacy, /<body data-live-page>/);
    assert.match(privacy, /data-live-region="retention"/);
});

test('pollLimiter: angemeldete Sitzungen hinter derselben IP teilen sich kein Kontingent', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie: first } = await app.login();
    const { cookie: second } = await app.login();
    const nav = cookie => fetch(app.url('/partials/nav'), { headers: { Cookie: cookie, Accept: 'application/json' } });

    let status = 200;
    for (let i = 0; i < 61 && status === 200; i += 1) status = (await nav(first)).status;
    assert.equal(status, 429, 'die erste Sitzung erreicht ihr Limit');
    assert.equal((await nav(second)).status, 200, 'die zweite Sitzung pollt unbeeindruckt weiter');
});

test('/healthz antwortet ohne Verzeichnis-Listing', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const res = await fetch(app.url('/healthz'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.uptime, 'number');
});

/* ================================================================= Login */

test('Login: falsches Passwort 401, richtiges setzt eine Sitzung', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const bad = await app.login('falsch');
    assert.equal(bad.res.status, 401);

    const good = await app.login();
    assert.equal(good.res.status, 302);
    assert.equal(good.res.headers.get('location'), '/admin');
    assert.match(good.cookie, /ts\.sid=/);

    const admin = await fetch(app.url('/admin'), {
        headers: { Cookie: good.cookie },
    });
    assert.equal(admin.status, 200);
    assert.match(await admin.text(), /Verwaltung/);
});

test('Admin-Idle-Timeout: Sitzung wird nach Inaktivitaet verworfen und muss sich neu anmelden', async t => {
    const app = await startTestApp({ adminIdleTimeoutMs: 1500 });
    t.after(() => app.close());

    const { cookie } = await app.login();

    const stillActive = await fetch(app.url('/admin'), {
        headers: { Cookie: cookie },
    });
    assert.equal(stillActive.status, 200, 'innerhalb des Idle-Fensters bleibt die Sitzung gueltig');

    await new Promise(resolve => setTimeout(resolve, 1700));

    const idled = await fetch(app.url('/admin'), {
        headers: { Cookie: cookie },
        redirect: 'manual',
    });
    assert.equal(idled.status, 302);
    assert.equal(idled.headers.get('location'), '/login?idle=1');

    // Die verworfene Sitzung darf auch nach einer erneuten Anmeldung nicht
    // wieder gueltig werden.
    const stale = await fetch(app.url('/admin'), {
        headers: { Cookie: cookie },
        redirect: 'manual',
    });
    assert.equal(stale.status, 302);

    const { cookie: freshCookie } = await app.login();
    assert.notEqual(freshCookie, cookie, 'Neuanmeldung muss eine neue Session-ID vergeben');
    const reAuthed = await fetch(app.url('/admin'), {
        headers: { Cookie: freshCookie },
    });
    assert.equal(reAuthed.status, 200);
});

test('/logout?idle=1 (clientseitig durch idle-timer.js erkannter Ablauf) landet auf /login?idle=1 mit Meldung', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const { cookie } = await app.login();

    const loggedOut = await fetch(app.url('/logout?idle=1'), {
        headers: { Cookie: cookie },
        redirect: 'manual',
    });
    assert.equal(loggedOut.status, 302);
    assert.equal(loggedOut.headers.get('location'), '/login?idle=1');

    const loginPage = await fetch(app.url('/login?idle=1'));
    assert.match(await loginPage.text(), /Wegen Inaktivität abgemeldet/);

    // Die Sitzung ist tatsaechlich verworfen, nicht nur weitergeleitet.
    const afterLogout = await fetch(app.url('/admin'), {
        headers: { Cookie: cookie },
        redirect: 'manual',
    });
    assert.equal(afterLogout.status, 302);
    assert.equal(afterLogout.headers.get('location'), '/login');
});

test('Normales /logout (ohne idle=1) landet weiterhin auf der oeffentlichen Startseite', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const { cookie } = await app.login();

    const loggedOut = await fetch(app.url('/logout'), {
        headers: { Cookie: cookie },
        redirect: 'manual',
    });
    assert.equal(loggedOut.status, 302);
    assert.equal(loggedOut.headers.get('location'), '/');
});

test('/admin/ping verlaengert den Idle-Timeout, ein Poll mit X-Idle-Background nicht', async t => {
    // Grosszuegige Abstaende: auf langsamen CI-Runnern dauert allein der Login
    // mehrere hundert ms, ein enges Fenster liess die Sitzung vor dem Ping ablaufen.
    const app = await startTestApp({ adminIdleTimeoutMs: 1500 });
    t.after(() => app.close());

    const { cookie } = await app.login();

    // Ein als Hintergrund markierter Poll (wie ihn live-regions.js schickt)
    // darf die Sitzung nicht ueber das Idle-Fenster hinaus retten.
    await new Promise(resolve => setTimeout(resolve, 500));
    const heartbeatPoll = await fetch(app.url('/admin'), {
        headers: { Cookie: cookie, 'X-Idle-Background': '1' },
    });
    assert.equal(heartbeatPoll.status, 200);

    await new Promise(resolve => setTimeout(resolve, 1100));
    const idledDespitePolling = await fetch(app.url('/admin'), {
        headers: { Cookie: cookie },
        redirect: 'manual',
    });
    assert.equal(idledDespitePolling.status, 302,
        'Hintergrund-Polling ohne echte Nutzeraktivitaet darf den Idle-Timeout nicht aushebeln');

    // Ein echter Keepalive-Ping (wie ihn idle-timer.js bei Aktivitaet
    // schickt) verlaengert die Sitzung dagegen wirklich.
    const { cookie: freshCookie } = await app.login();
    await new Promise(resolve => setTimeout(resolve, 750));
    const ping = await fetch(app.url('/admin/ping'), {
        headers: { Cookie: freshCookie },
    });
    assert.equal(ping.status, 204);

    await new Promise(resolve => setTimeout(resolve, 1100));
    const stillAliveAfterPing = await fetch(app.url('/admin'), {
        headers: { Cookie: freshCookie },
        redirect: 'manual',
    });
    assert.equal(stillAliveAfterPing.status, 200,
        'ein echter Ping muss lastActivity erneuern und die Sitzung ueber das urspruengliche Fenster hinaus verlaengern');
});

test('Sitzung ueberlebt einen Neustart des Servers', async t => {
    const app = await startTestApp();
    const { cookie } = await app.login();
    const root = app.root;

    // Gleiche Verzeichnisse, neue Instanz — wie ein `docker restart`.
    // shutdown() statt close(), sonst raeumt der Test den Sitzungsordner weg,
    // den er gleich noch braucht.
    await app.shutdown();
    const restarted = await startTestApp({
        tmpDir: path.join(root, 'tmp-uploads'),
        dataDir: path.join(root, 'data'),
    });
    t.after(() => restarted.close());

    const res = await fetch(restarted.url('/admin'), {
        headers: { Cookie: cookie },
        redirect: 'manual',
    });
    assert.equal(res.status, 200, 'Cookie muss nach dem Neustart noch gelten');
});

test('Sitzung ueberlebt einen Neustart auch ohne gesetztes SESSION_SECRET (DB-Bootstrap statt fluechtigem Zufallswert)', async t => {
    const app = await startTestApp({ sessionSecret: undefined });
    const { cookie } = await app.login();
    const root = app.root;

    await app.shutdown();
    const restarted = await startTestApp({
        tmpDir: path.join(root, 'tmp-uploads'),
        dataDir: path.join(root, 'data'),
        sessionSecret: undefined,
    });
    t.after(() => restarted.close());

    const res = await fetch(restarted.url('/admin'), {
        headers: { Cookie: cookie },
        redirect: 'manual',
    });
    assert.equal(res.status, 200,
        'ohne persistierten Session-Secret wuerde die neue Instanz mit einem anderen Zufallswert signieren und das Cookie waere ungueltig');
});

test('geschuetzte Routen ohne Sitzung: Redirect bzw. 401 fuer JSON', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const html = await fetch(app.url('/admin'), { redirect: 'manual' });
    assert.equal(html.status, 302);
    assert.equal(html.headers.get('location'), '/login');

    const json = await fetch(app.url('/admin/backups'), {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: '{}',
    });
    assert.equal(json.status, 401);
    assert.equal((await json.json()).error, 'Nicht angemeldet.');
});

test('Cross-Origin-POST wird abgelehnt', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const res = await fetch(app.url('/login'), {
        method: 'POST',
        redirect: 'manual',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Origin: 'http://angreifer.example',
        },
        body: new URLSearchParams({ password: 'korrekt-horse-battery' }).toString(),
    });
    assert.equal(res.status, 403);
});

test('Login-Versuche werden pro IP gedrosselt', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    let last = 0;
    // Limit ist 10 Fehlversuche je 15 Minuten
    for (let i = 0; i < 12; i++) {
        const res = await app.login('falsch');
        last = res.res.status;
    }
    assert.equal(last, 429);

    // Auch das richtige Passwort kommt jetzt nicht mehr durch
    assert.equal((await app.login()).res.status, 429);
});

/* ======================================================= Admin-Passwort */

test('POST /admin-password ohne Sitzung wird abgewiesen', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const res = await fetch(app.url('/admin-password'), {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password: 'neues-passwort', confirmPassword: 'neues-passwort' }).toString(),
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login');
});

test('zu kurzes Passwort wird abgelehnt, altes bleibt gueltig', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const res = await fetch(app.url('/admin-password'), {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password: 'kurz', confirmPassword: 'kurz' }).toString(),
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /mindestens 8 Zeichen/);

    assert.equal((await app.login()).res.status, 302, 'altes Passwort muss weiterhin gelten');
});

test('abweichende Passwortbestaetigung wird abgelehnt, altes bleibt gueltig', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const res = await fetch(app.url('/admin-password'), {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password: 'neues-passwort-1', confirmPassword: 'neues-passwort-2' }).toString(),
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /stimmen nicht überein/);

    assert.equal((await app.login()).res.status, 302, 'altes Passwort muss weiterhin gelten');
});

test('/admin-password mit Accept: application/json liefert JSON statt Redirect/Render', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const tooShort = await fetch(app.url('/admin-password'), {
        method: 'POST',
        headers: {
            Cookie: cookie,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
        },
        body: new URLSearchParams({ password: 'kurz', confirmPassword: 'kurz' }).toString(),
    });
    assert.equal(tooShort.status, 400);
    assert.match((await tooShort.json()).error, /mindestens 8 Zeichen/);

    const success = await fetch(app.url('/admin-password'), {
        method: 'POST',
        headers: {
            Cookie: cookie,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
        },
        body: new URLSearchParams({ password: 'per-json-gesetzt', confirmPassword: 'per-json-gesetzt' }).toString(),
    });
    assert.equal(success.status, 200);
    assert.deepEqual(await success.json(), { ok: true });

    assert.equal((await app.login('per-json-gesetzt')).res.status, 302);
});

test('erfolgreiche Passwortaenderung: altes schlaegt fehl, neues funktioniert', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const res = await fetch(app.url('/admin-password'), {
        method: 'POST',
        redirect: 'manual',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password: 'ganz-neues-passwort', confirmPassword: 'ganz-neues-passwort' }).toString(),
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/admin#tab-account');

    assert.equal((await app.login()).res.status, 401, 'altes Passwort darf nicht mehr gelten');
    assert.equal((await app.login('ganz-neues-passwort')).res.status, 302);
});

test('geaendertes Passwort ueberlebt einen Neustart, ADMIN_PASSWORD der alten Instanz nicht mehr', async t => {
    const app = await startTestApp();
    const { cookie } = await app.login();
    const root = app.root;

    await fetch(app.url('/admin-password'), {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password: 'persistiertes-passwort', confirmPassword: 'persistiertes-passwort' }).toString(),
    });

    await app.shutdown();
    const restarted = await startTestApp({
        tmpDir: path.join(root, 'tmp-uploads'),
        dataDir: path.join(root, 'data'),
        // andere adminPassword-Option als beim ersten Start — darf keine
        // Rolle mehr spielen, sobald einmal ueber die UI geaendert wurde
        adminPassword: 'ignoriert-weil-persistiert',
    });
    t.after(() => restarted.close());

    assert.equal((await restarted.login('ignoriert-weil-persistiert')).res.status, 401);
    assert.equal((await restarted.login('persistiertes-passwort')).res.status, 302);
});

test('gesetztes ADMIN_PASSWORD wird schon beim ersten Start persistiert, eine spaeter geaenderte Env-Var wirkt nicht mehr', async t => {
    const app = await startTestApp({ adminPassword: 'erster-start-passwort' });
    const root = app.root;

    // Schon nach dem ersten Start liegt ein Hash in der DB — nicht erst nach
    // einer expliziten Aenderung ueber /admin-password.
    assert.ok(await app.services.passwordStore.read());
    await app.shutdown();

    const restarted = await startTestApp({
        tmpDir: path.join(root, 'tmp-uploads'),
        dataDir: path.join(root, 'data'),
        adminPassword: 'andere-env-var-danach',
    });
    t.after(() => restarted.close());

    assert.equal((await restarted.login('andere-env-var-danach')).res.status, 401,
        'die beim zweiten Start abweichende Env-Var darf nicht mehr gelten');
    assert.equal((await restarted.login('erster-start-passwort')).res.status, 302,
        'das beim ersten Start bootstrappede Passwort muss weiter gelten');
});

/* ======================================================= Admin-Benutzername */

test('falscher Benutzername mit richtigem Passwort wird generisch abgelehnt', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const res = await app.login('korrekt-horse-battery', 'jemand-anderes');
    assert.equal(res.res.status, 401);
    const body = await res.res.text();
    assert.match(body, /Benutzername oder Passwort falsch/);
    assert.doesNotMatch(body, /Falsches Passwort/);
});

test('richtiger Benutzername mit falschem Passwort wird generisch abgelehnt', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const res = await app.login('falsch', 'admin');
    assert.equal(res.res.status, 401);
    assert.match(await res.res.text(), /Benutzername oder Passwort falsch/);
});

test('POST /admin-username ohne Sitzung wird abgewiesen', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const res = await fetch(app.url('/admin-username'), {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: 'neuer-name' }).toString(),
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login');
});

test('ungueltiger Benutzername wird abgelehnt, alter bleibt gueltig', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    for (const bad of ['', '   ', 'mit leerzeichen', 'a'.repeat(65)]) {
        const res = await fetch(app.url('/admin-username'), {
            method: 'POST',
            headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ username: bad }).toString(),
        });
        assert.equal(res.status, 400, `"${bad}" haette 400 ergeben muessen`);
    }

    assert.equal((await app.login()).res.status, 302, 'alter Benutzername muss weiterhin gelten');
});

test('/admin-username mit Accept: application/json liefert JSON statt Redirect/Render', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const invalid = await fetch(app.url('/admin-username'), {
        method: 'POST',
        headers: {
            Cookie: cookie,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
        },
        body: new URLSearchParams({ username: '' }).toString(),
    });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /Ungültiger Benutzername/);

    const success = await fetch(app.url('/admin-username'), {
        method: 'POST',
        headers: {
            Cookie: cookie,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
        },
        body: new URLSearchParams({ username: 'per-json-gesetzt' }).toString(),
    });
    assert.equal(success.status, 200);
    assert.deepEqual(await success.json(), { ok: true });

    assert.equal((await app.login('korrekt-horse-battery', 'per-json-gesetzt')).res.status, 302);
});

test('erfolgreiche Benutzernamensaenderung: alter schlaegt fehl, neuer funktioniert', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const res = await fetch(app.url('/admin-username'), {
        method: 'POST',
        redirect: 'manual',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: 'ganz-neuer-name' }).toString(),
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/admin#tab-account');

    assert.equal((await app.login()).res.status, 401, 'alter Benutzername darf nicht mehr gelten');
    assert.equal((await app.login('korrekt-horse-battery', 'ganz-neuer-name')).res.status, 302);
});

test('geaenderter Benutzername ueberlebt einen Neustart', async t => {
    const app = await startTestApp();
    const { cookie } = await app.login();
    const root = app.root;

    await fetch(app.url('/admin-username'), {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: 'persistierter-name' }).toString(),
    });

    await app.shutdown();
    const restarted = await startTestApp({
        tmpDir: path.join(root, 'tmp-uploads'),
        dataDir: path.join(root, 'data'),
    });
    t.after(() => restarted.close());

    assert.equal((await restarted.login()).res.status, 401, 'alter Default-Benutzername darf nicht mehr gelten');
    assert.equal(
        (await restarted.login('korrekt-horse-battery', 'persistierter-name')).res.status,
        302
    );
});

test('der Default-Benutzername wird schon beim ersten Start in die DB geschrieben', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    // Kein POST /admin-username noetig — start() bootstrappt den Default
    // direkt in die DB, damit dort nicht "leer" steht.
    assert.equal(await app.services.usernameStore.read(), 'admin');
});

test('ohne ADMIN_PASSWORD wird beim ersten Start genau einmal ein Passwort erzeugt und persistiert', async t => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ticket-system-bootstrap-'));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));

    const warnings = [];
    const log = { log() {}, warn: msg => warnings.push(msg), error() {} };
    const dirs = {
        tmpDir: path.join(root, 'tmp-uploads'),
        dataDir: path.join(root, 'data'),
        sessionSecret: 'test-secret',
        scanOnStart: false,
        sweepStaleUploads: false,
        log,
    };

    async function loginWith(instance, password) {
        const server = instance.app.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const base = `http://127.0.0.1:${server.address().port}`;
        const res = await fetch(`${base}/login`, {
            method: 'POST',
            redirect: 'manual',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ username: 'admin', password }).toString(),
        });
        server.close();
        server.closeAllConnections();
        await once(server, 'close');
        return res.status;
    }

    const first = createApp(dirs);
    await first.start();

    // [^)]* statt [^:]* bis zum Ende der Klammer: der Pfad selbst enthaelt
    // unter Windows ein Colon (z. B. "C:\...\ticket-system.db").
    const match = warnings.join('\n').match(/Einmalig generiertes Passwort \([^)]*\):\n\s+(\S+)/);
    assert.ok(match, 'Passwort haette geloggt werden muessen');
    const generated = match[1];
    assert.ok(await first.services.passwordStore.read(), 'Passwort haette persistiert werden muessen');
    assert.equal(await loginWith(first, generated), 302);
    await first.stop();

    // Zweiter Start, gleiche Verzeichnisse: kein neues Passwort erzeugt
    warnings.length = 0;
    const second = createApp(dirs);
    await second.start();
    assert.equal(
        warnings.some(w => w.includes('Einmalig generiertes Passwort')),
        false,
        'zweiter Start darf kein neues Passwort erzeugen'
    );
    assert.equal(await loginWith(second, generated), 302,
        'urspruenglich generiertes Passwort muss weiterhin gelten');
    await second.stop();
});

/* ===================================================== WebAuthn/Passkeys
   Kein echter WebAuthn-Roundtrip hier — der braucht einen echten
   Authenticator (siehe manueller Testpass im Plan). Getestet wird die
   HTTP-Oberflaeche: Auth-Gating, geteiltes Rate-Limit mit /login,
   Eingabevalidierung und dass die Challenge ueber die Session transportiert
   wird. */

test('WebAuthn-Routen verlangen eine Sitzung', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const routes = [
        ['POST', '/webauthn/register/options'],
        ['POST', '/webauthn/register/verify'],
        ['GET', '/webauthn/credentials'],
        ['DELETE', '/webauthn/credentials/abc'],
    ];
    for (const [method, path_] of routes) {
        const res = await fetch(app.url(path_), {
            method,
            headers: { Accept: 'application/json' },
        });
        assert.equal(res.status, 401, `${method} ${path_} haette 401 liefern muessen`);
    }
});

test('POST /webauthn/login/options ist oeffentlich erreichbar', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const res = await fetch(app.url('/webauthn/login/options'), {
        method: 'POST',
        headers: { Accept: 'application/json' },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.challenge, 'string');
});

test('Passkey-Login-Versuche teilen sich das Rate-Limit mit /login', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    let last = 0;
    // Limit ist 10 Fehlversuche je 15 Minuten, geteilt ueber beide Routen
    for (let i = 0; i < 12; i++) {
        if (i % 2 === 0) {
            last = (await app.login('falsch')).res.status;
        } else {
            const res = await fetch(app.url('/webauthn/login/verify'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ credential: { id: 'unbekannt' } }),
            });
            last = res.status;
        }
    }
    assert.equal(last, 429);
    assert.equal((await app.login()).res.status, 429,
        'ein Angreifer darf sein Budget nicht durch Routenwechsel verdoppeln');
});

test('DELETE mit ungueltiger Credential-ID liefert 400', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const res = await fetch(app.url('/webauthn/credentials/..%2F..%2Fetc'), {
        method: 'DELETE',
        headers: { Cookie: cookie, Accept: 'application/json' },
    });
    assert.equal(res.status, 400);
});

test('register/verify ohne vorherige register/options liefert 400', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const res = await fetch(app.url('/webauthn/register/verify'), {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ credential: {} }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'Keine offene Registrierung.');
});

test('login/verify mit unbekannter Credential-ID liefert 401 statt zu werfen', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    // Erst die Ceremony beginnen, damit eine Challenge in der Session liegt
    const options = await fetch(app.url('/webauthn/login/options'), {
        method: 'POST',
        headers: { Accept: 'application/json' },
    });
    const cookie = (options.headers.getSetCookie() || [])
        .map(value => value.split(';')[0]).join('; ');

    const res = await fetch(app.url('/webauthn/login/verify'), {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ credential: { id: 'niemals-registriert' } }),
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'Unbekannter Passkey.');
});

test('login/verify: Challenge kommt ueber die Session, nicht ueber den Body', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    // Einen Passkey direkt im Store anlegen — der eigentliche Verify-Aufruf
    // bleibt trotzdem ohne echten Authenticator: eine kaputte Assertion
    // landet im catch-Zweig, aber NACH der "unbekannter Passkey"-Pruefung.
    await app.services.webauthnStore.addCredential({
        credentialId: 'seeded',
        publicKey: Buffer.from('dummy-key').toString('base64url'),
        counter: 0,
        transports: ['internal'],
        label: 'Test-Passkey',
    });

    const options = await fetch(app.url('/webauthn/login/options'), {
        method: 'POST',
        headers: { Accept: 'application/json' },
    });
    const cookie = (options.headers.getSetCookie() || [])
        .map(value => value.split(';')[0]).join('; ');

    const res = await fetch(app.url('/webauthn/login/verify'), {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
            credential: {
                id: 'seeded',
                rawId: 'seeded',
                type: 'public-key',
                response: {
                    clientDataJSON: 'x', authenticatorData: 'x', signature: 'x',
                },
                clientExtensionResults: {},
            },
        }),
    });
    // 401 (Verifikation fehlgeschlagen), nicht 400 (keine offene Anmeldung)
    // — belegt, dass die Challenge ueber die Session transportiert wurde.
    assert.equal(res.status, 401);
    assert.notEqual((await res.json()).error, 'Keine offene Anmeldung.');
});

test('Cross-Origin-POST auf /webauthn/login/verify wird abgelehnt', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const res = await fetch(app.url('/webauthn/login/verify'), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Origin: 'http://angreifer.example',
        },
        body: JSON.stringify({ credential: { id: 'x' } }),
    });
    assert.equal(res.status, 403);
});

test('GET /webauthn/credentials liefert nie den publicKey', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    await app.services.webauthnStore.addCredential({
        credentialId: 'sichtbar',
        publicKey: 'geheim',
        counter: 0,
        label: 'Test-Passkey',
    });

    const res = await fetch(app.url('/webauthn/credentials'), {
        headers: { Cookie: cookie, Accept: 'application/json' },
    });
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].credentialId, 'sichtbar');
    assert.equal('publicKey' in list[0], false);
});

/* ==================================================================== TOTP */

test('TOTP: Einrichtung erzwingt beim naechsten Login den zweiten Faktor', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const setupRes = await fetch(app.url('/totp/setup'), {
        method: 'POST',
        headers: { Cookie: cookie, Accept: 'application/json' },
    });
    assert.equal(setupRes.status, 200);
    const { secret, otpauthUrl } = await setupRes.json();
    assert.match(otpauthUrl, /^otpauth:\/\/totp\//);

    const confirmRes = await fetch(app.url('/totp/confirm'), {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ token: totpAt(secret) }),
    });
    assert.equal(confirmRes.status, 200);
    const { recoveryCodes } = await confirmRes.json();
    assert.equal(recoveryCodes.length, 8);

    // Passwort allein reicht jetzt nicht mehr
    const login = await app.login();
    assert.equal(login.res.status, 302);
    assert.equal(login.res.headers.get('location'), '/login/totp');

    const stillLocked = await fetch(app.url('/admin'), {
        headers: { Cookie: login.cookie },
        redirect: 'manual',
    });
    assert.equal(stillLocked.status, 302);
    assert.equal(stillLocked.headers.get('location'), '/login/totp');

    const wrongCode = await fetch(app.url('/login/totp'), {
        method: 'POST',
        redirect: 'manual',
        headers: { Cookie: login.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: '000000' }).toString(),
    });
    assert.equal(wrongCode.status, 401);

    const rightCode = await fetch(app.url('/login/totp'), {
        method: 'POST',
        redirect: 'manual',
        headers: { Cookie: login.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: totpAt(secret) }).toString(),
    });
    assert.equal(rightCode.status, 302);
    assert.equal(rightCode.headers.get('location'), '/admin');

    const admin = await fetch(app.url('/admin'), { headers: { Cookie: login.cookie } });
    assert.equal(admin.status, 200);
});

test('TOTP: ein Recovery-Code gilt genau einmal, /totp/disable entfernt den zweiten Faktor', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const { secret } = await (await fetch(app.url('/totp/setup'), {
        method: 'POST',
        headers: { Cookie: cookie, Accept: 'application/json' },
    })).json();
    const { recoveryCodes } = await (await fetch(app.url('/totp/confirm'), {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ token: totpAt(secret) }),
    })).json();

    const login = await app.login();
    const usedOnce = await fetch(app.url('/login/totp'), {
        method: 'POST',
        redirect: 'manual',
        headers: { Cookie: login.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: recoveryCodes[0] }).toString(),
    });
    assert.equal(usedOnce.status, 302, 'Recovery-Code muss beim ersten Mal funktionieren');

    const secondLogin = await app.login();
    const usedTwice = await fetch(app.url('/login/totp'), {
        method: 'POST',
        redirect: 'manual',
        headers: { Cookie: secondLogin.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: recoveryCodes[0] }).toString(),
    });
    assert.equal(usedTwice.status, 401, 'derselbe Recovery-Code darf kein zweites Mal gelten');

    // Zweiten Faktor wieder deaktivieren — braucht eine voll angemeldete Sitzung
    const disableRes = await fetch(app.url('/totp/disable'), {
        method: 'POST',
        headers: { Cookie: cookie, Accept: 'application/json' },
    });
    assert.equal(disableRes.status, 200);

    const plainLogin = await app.login();
    assert.equal(plainLogin.res.status, 302);
    assert.equal(plainLogin.res.headers.get('location'), '/admin');
});

test('TOTP-Setup-Routen verlangen eine Sitzung', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const res = await fetch(app.url('/totp/setup'), {
        method: 'POST',
        redirect: 'manual',
        headers: { Accept: 'application/json' },
    });
    assert.equal(res.status, 401);
});

/* ================================================================ Metrics */

test('/metrics liefert Prometheus-Textformat mit Ticket- und Aktivitaets-Zaehlern', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    await fetch(app.url('/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: 'admin', password: 'falsch' }),
    });

    const res = await fetch(app.url('/metrics'));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/plain/);

    const body = await res.text();
    assert.match(body, /# TYPE ticket_system_tickets gauge/);
    assert.match(body, /^ticket_system_tickets\{view="new"\} 0$/m);
    assert.match(body, /^ticket_system_customers 0$/m);
    assert.match(body, /^ticket_system_login_failures_total 1$/m);
    assert.match(body, /^ticket_system_mail_enabled 0$/m);
});

/* ============================================================== Header */

test('Sicherheits-Header sitzen', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const res = await fetch(app.url('/'));
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'same-origin');
    assert.equal(res.headers.get('x-powered-by'), null);
});

test('unbekannte Route liefert 404 ohne Stacktrace', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const res = await fetch(app.url('/gibt-es-nicht'));
    assert.equal(res.status, 404);
    const body = await res.text();
    assert.equal(body, 'Nicht gefunden');
    assert.doesNotMatch(body, /at .*\.js:\d+/);
});

/* =============================================================== Backups
   Der eigentliche Erfolgspfad von POST /admin/backups/:filename/restore
   (der den Prozess absichtlich mit process.exit(1) beendet, siehe
   lib/backup-store.js/server.js) wird hier bewusst NICHT ausgeloest — das
   wuerde den Test-Runner-Prozess selbst beenden. Der Datei-Tausch-Teil
   (restoreBackup() ohne den process.exit-Aufruf) ist stattdessen in
   test/units.test.js isoliert getestet; hier nur die Route drumherum:
   Auth, Validierung, Checksum-Ablehnung. */

test('Backup-Routen sind ohne Sitzung nicht erreichbar', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const jsonHeaders = { Accept: 'application/json' };
    const placeholder = 'ticket-system-20260101T000000Z-abcdef.db';

    assert.equal(
        (await fetch(app.url('/admin/backups'), { method: 'POST', headers: jsonHeaders })).status, 401
    );
    assert.equal(
        (await fetch(app.url(`/admin/backups/${placeholder}`), { method: 'DELETE', headers: jsonHeaders })).status,
        401
    );
    assert.equal(
        (await fetch(app.url('/admin/backup-settings'), {
            method: 'POST', headers: { ...jsonHeaders, 'Content-Type': 'application/json' }, body: '{}',
        })).status,
        401
    );
    assert.equal(
        (await fetch(app.url(`/admin/backups/${placeholder}/restore`), {
            method: 'POST', headers: { ...jsonHeaders, 'Content-Type': 'application/json' }, body: '{}',
        })).status,
        401
    );
});

test('POST /admin/backups legt eine Sicherung an, GET .../download liefert sie, DELETE entfernt sie wieder', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const create = await fetch(app.url('/admin/backups'), {
        method: 'POST',
        headers: { Cookie: cookie, Accept: 'application/json' },
    });
    assert.equal(create.status, 201);
    const backup = await create.json();
    assert.match(backup.file, /^ticket-system-.+\.db$/);
    assert.equal(typeof backup.sha256, 'string');

    assert.deepEqual((await app.services.backupStore.listBackups()).map(b => b.file), [backup.file]);

    const download = await fetch(app.url(`/admin/backups/${backup.file}/download`), {
        headers: { Cookie: cookie },
    });
    assert.equal(download.status, 200);
    const downloaded = Buffer.from(await download.arrayBuffer());
    assert.equal(crypto.createHash('sha256').update(downloaded).digest('hex'), backup.sha256);

    const del = await fetch(app.url(`/admin/backups/${backup.file}`), {
        method: 'DELETE', headers: { Cookie: cookie },
    });
    assert.equal(del.status, 204);
    assert.deepEqual(await app.services.backupStore.listBackups(), []);

    const delAgain = await fetch(app.url(`/admin/backups/${backup.file}`), {
        method: 'DELETE', headers: { Cookie: cookie },
    });
    assert.equal(delAgain.status, 404);
});

test('Backup-Routen mit ungueltigem :filename lehnen ab, statt das Dateisystem anzufassen', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    for (const bad of ['../../etc/passwd', 'nicht-ticket-system.db', 'ticket-system.db']) {
        const del = await fetch(app.url(`/admin/backups/${encodeURIComponent(bad)}`), {
            method: 'DELETE', headers: { Cookie: cookie },
        });
        assert.equal(del.status, 400, `"${bad}" haette 400 ergeben muessen`);

        const dl = await fetch(app.url(`/admin/backups/${encodeURIComponent(bad)}/download`), {
            headers: { Cookie: cookie },
        });
        assert.equal(dl.status, 400, `"${bad}" haette 400 ergeben muessen`);
    }
});

test('POST /admin/backup-settings validiert, klemmt Grenzwerte und plant den Timer sofort neu', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const invalid = await fetch(app.url('/admin/backup-settings'), {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ intervalMinutes: 'nicht-numerisch', retentionCount: 5, enabled: true }),
    });
    assert.equal(invalid.status, 400);

    const res = await fetch(app.url('/admin/backup-settings'), {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ intervalMinutes: 999999, retentionCount: -1, enabled: false }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.intervalMinutes, 1440, 'wird auf das Maximum geklemmt');
    assert.equal(body.retentionCount, 1, 'wird auf das Minimum geklemmt');
    assert.equal(body.enabled, false);

    assert.deepEqual(app.services.backupStore.readSettings(), body);
});

test(
    'POST /admin/backups/:filename/restore lehnt falsche Bestaetigung und manipulierte Checksumme ab, ' +
    'ohne die Live-DB anzufassen',
    async t => {
        const app = await startTestApp();
        t.after(() => app.close());
        const { cookie } = await app.login();
        await app.services.kbStore.create({ title: 'Vorher', body: 'Text', published: true });

        const create = await fetch(app.url('/admin/backups'), {
            method: 'POST', headers: { Cookie: cookie, Accept: 'application/json' },
        });
        const backup = await create.json();

        const wrongConfirm = await fetch(app.url(`/admin/backups/${backup.file}/restore`), {
            method: 'POST',
            headers: { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ confirm: 'falscher-dateiname.db' }),
        });
        assert.equal(wrongConfirm.status, 400);

        // Backup-Datei nachtraeglich manipulieren, damit die Checksumme nicht mehr passt
        const backupPath = path.join(app.root, 'data', 'backups', backup.file);
        await fsp.appendFile(backupPath, 'garbage');

        const badChecksum = await fetch(app.url(`/admin/backups/${backup.file}/restore`), {
            method: 'POST',
            headers: { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ confirm: backup.file }),
        });
        assert.equal(badChecksum.status, 400);
        assert.match((await badChecksum.json()).error, /Checksumme/);

        // App laeuft unbeeintraechtigt weiter -- der zuvor angelegte Artikel ist noch da
        assert.deepEqual(app.services.kbStore.list({ publishedOnly: true }).map(a => a.title), ['Vorher']);
    }
);
