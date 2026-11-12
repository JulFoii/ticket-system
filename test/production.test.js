'use strict';

/*
 * Tests fuer die Produktionsreife: Konfigurationspruefung, Schema-
 * Migrationen, Speicherplatzpruefung bei Uploads, Aufraeumen verwaister
 * Temp-Dateien, Logging, geordnetes Herunterfahren, Loeschfristen,
 * /healthz + /metrics und die Deployment-Dateien.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const { once, EventEmitter } = require('events');
const { DatabaseSync } = require('node:sqlite');

const { startTestApp } = require('./helpers/app');
const { createApp } = require('../server');
const { checkConfig, assertConfig } = require('../lib/config-check');
const {
    openDatabase, applyMigrations, schemaVersion, maintainDatabase, SCHEMA_VERSION,
} = require('../lib/db');
const { defaultDiskInfo, sweepTmpDir, sha256OfFile } = require('../lib/disk');
const { createLogger, requestLogger } = require('../lib/logger');
const { createShutdown, installProcessHandlers } = require('../lib/lifecycle');
const { createRetention } = require('../lib/retention');
const { createCustomerStore } = require('../lib/customer-store');
const { createTicketStore } = require('../lib/ticket-store');
const { createAttachmentStore } = require('../lib/attachment-store');
const { createAuditLog } = require('../lib/audit-log');
const { createEventStore } = require('../lib/event-store');

const QUIET = { log() {}, info() {}, warn() {}, error() {} };
const ROOT = path.join(__dirname, '..');
const DAY_MS = 24 * 60 * 60 * 1000;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

async function tempDir(prefix = 'ticket-system-prod-') {
    return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

/* ======================================================== config-check */

test('config-check: im Produktivbetrieb sind fehlender Proxy und fehlende PUBLIC_URL fatal', () => {
    const { errors } = checkConfig({ isProd: true, mailEnabled: true, trustProxy: null, publicUrl: null });
    assert.equal(errors.length, 2);
    assert.ok(errors.some(message => message.includes('TRUST_PROXY')));
    assert.ok(errors.some(message => message.includes('PUBLIC_URL')));
});

test('config-check: http:// und localhost als PUBLIC_URL sind in production Fehler, sonst Warnungen', () => {
    const prod = checkConfig({ isProd: true, trustProxy: '1', publicUrl: 'http://localhost:3000', metricsToken: 'x' });
    assert.equal(prod.errors.length, 2);
    const dev = checkConfig({ isProd: false, publicUrl: 'http://localhost:3000' });
    assert.equal(dev.errors.length, 0);
    assert.equal(dev.warnings.length, 2);
});

test('config-check: eine korrekte Produktivkonfiguration ist fehler- und warnungsfrei', () => {
    const result = checkConfig({
        isProd: true, trustProxy: '1', publicUrl: 'https://support.example.com', mailEnabled: true,
        inboundEnabled: true, metricsToken: 'geheim', attachmentMaxMb: 10,
        mailAttachmentMaxMb: 10, imapAuthservId: 'mx.example.com',
    });
    assert.deepEqual(result, { errors: [], warnings: [] });
});

test('config-check: IMAP ohne IMAP_AUTHSERV_ID warnt, eine ungueltige authserv-id oder negatives Mail-Anhang-Limit ist ein Fehler', () => {
    const missing = checkConfig({ inboundEnabled: true, mailEnabled: true });
    assert.ok(missing.warnings.some(message => message.includes('IMAP_AUTHSERV_ID')));
    const invalid = checkConfig({ imapAuthservId: 'mx.example.com; dkim=pass', mailAttachmentMaxMb: -1 });
    assert.ok(invalid.errors.some(message => message.includes('IMAP_AUTHSERV_ID')));
    assert.ok(invalid.errors.some(message => message.includes('MAIL_ATTACHMENT_MAX_MB')));
    assert.equal(checkConfig({ mailAttachmentMaxMb: 0 }).errors.length, 0);
});

test('config-check: ungueltige URL und ungueltige Groessen sind immer Fehler, auch ausserhalb production', () => {
    const { errors } = checkConfig({
        publicUrl: 'ftp://example.com', attachmentMaxMb: Number.NaN,
    });
    assert.equal(errors.length, 2);
    assert.ok(checkConfig({ publicUrl: 'https://x.example/?a=1' }).errors[0].includes('Query'));
});

test('config-check: ohne METRICS_TOKEN in production nur eine Warnung', () => {
    const { errors, warnings } = checkConfig({ isProd: true, trustProxy: '1' });
    assert.equal(errors.length, 0);
    assert.ok(warnings.some(message => message.includes('METRICS_TOKEN')));
});

test('config-check: assertConfig wirft mit allen Fehlern gesammelt und loggt Warnungen', () => {
    const warned = [];
    assert.throws(
        () => assertConfig({ isProd: true, mailEnabled: true }, { warn: message => warned.push(message) }),
        err => err.code === 'invalid_config' && err.configErrors.length === 2
            && err.message.includes('TRUST_PROXY') && err.message.includes('PUBLIC_URL')
    );
    assert.ok(warned.some(message => message.includes('METRICS_TOKEN')));
});

test('createApp bricht bei ungueltiger Produktivkonfiguration ab, bevor die DB angelegt wird', async () => {
    const root = await tempDir();
    try {
        assert.throws(() => createApp({
            tmpDir: path.join(root, 'tmp'),
            dataDir: path.join(root, 'data'),
            isProd: true,
            trustProxy: null,
            log: QUIET,
        }), err => err.code === 'invalid_config');
        assert.equal(fs.existsSync(path.join(root, 'data', 'ticket-system.db')), false);
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

/* ========================================================== migrationen */

test('db: frische Datenbank steht auf der aktuellen Schema-Version, Pragmas sind gesetzt', async () => {
    const root = await tempDir();
    const db = openDatabase(path.join(root, 'a.db'));
    try {
        assert.equal(schemaVersion(db), SCHEMA_VERSION);
        assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
        assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
        assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 1); // NORMAL
        assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
        maintainDatabase(db); // darf auf einer frischen DB nicht werfen
    } finally {
        db.close();
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test('db: zweites Oeffnen wendet keine Migration erneut an', async () => {
    const root = await tempDir();
    const file = path.join(root, 'b.db');
    openDatabase(file).close();
    const db = openDatabase(file);
    try {
        assert.deepEqual(applyMigrations(db), []);
    } finally {
        db.close();
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test('db: eine Datenbank einer neueren App-Version wird abgelehnt statt weiterbenutzt', async () => {
    const root = await tempDir();
    const file = path.join(root, 'future.db');
    const future = new DatabaseSync(file);
    future.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
    future.close();
    try {
        assert.throws(() => openDatabase(file), err => err.code === 'schema_too_new');
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test('db: eine fehlschlagende Migration wird komplett zurueckgerollt, die Version bleibt stehen', () => {
    const db = new DatabaseSync(':memory:');
    const migrations = [
        { version: 1, name: 'ok', up: d => d.exec('CREATE TABLE a (x INTEGER)') },
        {
            version: 2,
            name: 'kaputt',
            up(d) {
                d.exec('CREATE TABLE b (x INTEGER)');
                throw new Error('absichtlich');
            },
        },
    ];
    assert.throws(() => applyMigrations(db, migrations), /Migration 2 \(kaputt\).*absichtlich/);
    assert.equal(schemaVersion(db), 1);
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(row => row.name);
    assert.ok(tables.includes('a'));
    assert.ok(!tables.includes('b'));
    db.close();
});

/* ========================================================== lib/disk.js */

test('disk: echter statfs liefert freien Platz und Geraet, fehlendes Verzeichnis null', async () => {
    const info = await defaultDiskInfo(os.tmpdir());
    assert.ok(info === null || (info.free > 0 && info.device !== undefined));
    assert.equal(await defaultDiskInfo(path.join(os.tmpdir(), 'gibt-es-nicht-' + Date.now())), null);
});

test('disk: sweepTmpDir entfernt alte Multer-Reste, laesst frische Dateien und Ordner stehen', async () => {
    const root = await tempDir();
    try {
        const old = path.join(root, 'a1b2c3d4e5f6');
        const fresh = path.join(root, 'f6e5d4c3b2a1');
        const folder = path.join(root, 'unterordner');
        await fsp.writeFile(old, 'alt');
        await fsp.writeFile(fresh, 'neu');
        await fsp.mkdir(folder);
        const longAgo = new Date(Date.now() - 2 * DAY_MS);
        await fsp.utimes(old, longAgo, longAgo);
        await fsp.utimes(folder, longAgo, longAgo);

        assert.equal(await sweepTmpDir(root), 1);
        assert.equal(fs.existsSync(old), false);
        assert.equal(fs.existsSync(fresh), true);
        assert.equal(fs.existsSync(folder), true);
        assert.equal(await sweepTmpDir(path.join(root, 'fehlt')), 0);
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test('disk: sha256OfFile entspricht dem Hash des Inhalts', async () => {
    const root = await tempDir();
    try {
        const file = path.join(root, 'x.bin');
        await fsp.writeFile(file, 'abc');
        assert.equal(await sha256OfFile(file), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

/* =============================================================== Logger */

function capture() {
    const out = [];
    const err = [];
    return {
        out, err,
        stdout: { write: chunk => out.push(chunk) },
        stderr: { write: chunk => err.push(chunk) },
    };
}

test('logger: JSON-Format schreibt eine Zeile je Eintrag mit Feldern und serialisiertem Fehler', () => {
    const c = capture();
    const log = createLogger({ format: 'json', stdout: c.stdout, stderr: c.stderr, now: () => new Date(0) });
    log.info('hallo', 'welt', { reqId: 'r1' });
    log.error('kaputt:', new Error('boom'));

    const info = JSON.parse(c.out[0]);
    assert.deepEqual(info, { time: '1970-01-01T00:00:00.000Z', level: 'info', msg: 'hallo welt', reqId: 'r1' });
    const error = JSON.parse(c.err[0]);
    assert.equal(error.level, 'error');
    assert.equal(error.msg, 'kaputt:');
    assert.equal(error.err.message, 'boom');
    assert.match(error.err.stack, /Error: boom/);
    assert.ok(c.out[0].endsWith('\n') && !c.out[0].slice(0, -1).includes('\n'));
});

test('logger: Level-Schwelle filtert, warn/error gehen nach stderr, log() ist ein Alias fuer info', () => {
    const c = capture();
    const log = createLogger({ format: 'pretty', level: 'warn', stdout: c.stdout, stderr: c.stderr });
    log.debug('d');
    log.info('i');
    log.log('l');
    log.warn('w');
    assert.equal(c.out.length, 0);
    assert.deepEqual(c.err, ['w\n']);

    const c2 = capture();
    createLogger({ format: 'pretty', level: 'debug', stdout: c2.stdout, stderr: c2.stderr }).log('x', { a: 1 });
    assert.deepEqual(c2.out, ['x {"a":1}\n']);
});

test('requestLogger: Request-ID wird uebernommen oder erzeugt, Query-String nie geloggt, /healthz ausgelassen', async t => {
    const entries = [];
    const log = {
        info: (msg, fields) => entries.push({ level: 'info', msg, ...fields }),
        warn: (msg, fields) => entries.push({ level: 'warn', msg, ...fields }),
        error: (msg, fields) => entries.push({ level: 'error', msg, ...fields }),
    };
    const app = await startTestApp({ log: { ...QUIET, ...log } });
    t.after(() => app.close());

    const own = await fetch(app.url('/account/verify?token=GEHEIM123'), { headers: { 'X-Request-Id': 'abc-123' } });
    assert.equal(own.headers.get('x-request-id'), 'abc-123');
    const bad = await fetch(app.url('/'), { headers: { 'X-Request-Id': 'bad id with spaces' } });
    assert.match(bad.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
    await fetch(app.url('/healthz'));
    await fetch(app.url('/gibt-es-nicht'));
    // 'finish' feuert nach dem Senden — kurz warten, bis alle Eintraege da sind
    await new Promise(resolve => setTimeout(resolve, 50));

    const requests = entries.filter(entry => entry.msg === 'request');
    assert.ok(!JSON.stringify(entries).includes('GEHEIM123'), 'Token aus dem Query-String darf nie im Log stehen');
    const verify = requests.find(entry => entry.path === '/account/verify');
    assert.equal(verify.reqId, 'abc-123');
    assert.equal(verify.method, 'GET');
    assert.equal(typeof verify.durationMs, 'number');
    assert.ok(!requests.some(entry => entry.path === '/healthz'));
    const notFound = requests.find(entry => entry.path === '/gibt-es-nicht');
    assert.equal(notFound.status, 404);
    // 4xx sind auf der Konsole kein warn mehr (nur noch 5xx als error) —
    // Details gehoeren ins Event-Log, nicht in die Konsole
    assert.equal(notFound.level, 'info');
});

test('requestLogger funktioniert auch mit einem Logger ohne info()', () => {
    const lines = [];
    const middleware = requestLogger({ log: (...args) => lines.push(args), warn() {}, error() {} }, { randomId: () => 'id1' });
    const res = new EventEmitter();
    const headers = {};
    res.set = (key, value) => { headers[key] = value; };
    res.get = () => undefined;
    res.statusCode = 200;
    res.writableFinished = true;
    let called = false;
    middleware({ get: () => undefined, path: '/x', method: 'GET', ip: '1.2.3.4' }, res, () => { called = true; });
    res.emit('finish');
    assert.ok(called);
    assert.equal(headers['X-Request-Id'], 'id1');
    assert.equal(lines[0][0], 'request');
});

/* =========================================================== Lifecycle */

async function slowServer(delayMs) {
    const server = http.createServer((req, res) => {
        setTimeout(() => res.end('fertig'), delayMs);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

test('lifecycle: laufende Requests duerfen vor dem Beenden zu Ende laufen', async () => {
    const { server, url } = await slowServer(150);
    const events = [];
    const shutdown = createShutdown({
        server,
        stop: async () => { events.push('stop'); },
        exit: code => events.push(`exit:${code}`),
        log: QUIET,
        timeoutMs: 2000,
    });

    const pending = fetch(url).then(res => res.text());
    await new Promise(resolve => setTimeout(resolve, 30));
    const done = shutdown('SIGTERM');
    assert.equal(shutdown('SIGTERM'), done, 'zweites Signal startet kein zweites Herunterfahren');

    assert.equal(await pending, 'fertig');
    await done;
    assert.deepEqual(events, ['stop', 'exit:0']);
});

test('lifecycle: haengende Verbindungen werden nach dem Timeout getrennt', async () => {
    const { server, url } = await slowServer(10_000);
    const events = [];
    const shutdown = createShutdown({
        server, stop: async () => events.push('stop'), exit: code => events.push(`exit:${code}`),
        log: QUIET, timeoutMs: 100,
    });
    const pending = fetch(url).then(() => 'antwort', () => 'abgebrochen');
    await new Promise(resolve => setTimeout(resolve, 30));
    const started = Date.now();
    await shutdown('SIGTERM');
    assert.ok(Date.now() - started < 2000);
    assert.equal(await pending, 'abgebrochen');
    assert.deepEqual(events, ['stop', 'exit:0']);
});

test('lifecycle: Fehler beim Stoppen fuehrt zu Exit-Code 1, Prozess-Handler loesen Herunterfahren aus', async () => {
    const { server } = await slowServer(0);
    const exits = [];
    const shutdown = createShutdown({
        server, stop: async () => { throw new Error('db kaputt'); }, exit: code => exits.push(code),
        log: QUIET, timeoutMs: 100,
    });
    await shutdown('SIGTERM');
    assert.deepEqual(exits, [1]);

    const proc = new EventEmitter();
    const reasons = [];
    installProcessHandlers({ shutdown: (reason, code) => reasons.push([reason, code]), log: QUIET, proc });
    proc.emit('SIGTERM');
    proc.emit('SIGTERM'); // once
    proc.emit('unhandledRejection', 'nur ein String');
    proc.emit('uncaughtException', new Error('x'));
    assert.deepEqual(reasons, [['SIGTERM', undefined], ['unhandledRejection', 1], ['uncaughtException', 1]]);
});

/* =========================================================== Retention */

async function retentionFixture(policy) {
    const dir = await tempDir();
    const db = openDatabase(':memory:');
    const customerStore = createCustomerStore({ db });
    const ticketStore = createTicketStore({ db });
    const attachmentStore = createAttachmentStore({ db, dir, maxBytes: 1024 });
    const events = createEventStore({ file: ':memory:' });
    const auditLog = createAuditLog({ events });
    const forgotten = { tickets: [], addresses: [] };
    const outbox = {
        forgetTicket: id => forgotten.tickets.push(id),
        forgetAddress: address => forgotten.addresses.push(address),
    };
    const destroyed = [];
    const sessionStore = { destroyForCustomer: id => destroyed.push(id) };
    const retention = createRetention({
        db, ticketStore, attachmentStore, customerStore, sessionStore, outbox, auditLog, log: QUIET, policy,
    });
    return {
        db, dir, customerStore, ticketStore, attachmentStore, auditLog, events, retention, forgotten, destroyed,
        async cleanup() {
            db.close();
            events.close();
            await fsp.rm(dir, { recursive: true, force: true });
        },
    };
}

test('Event-Log: Audit-Eintraege aelter als die Audit-Frist werden geloescht, juengere bleiben', async () => {
    const events = createEventStore({ file: ':memory:', auditDays: 30 });
    try {
        const now = Date.now();
        events.record({ event: 'alt', audit: true, ts: now - 31 * DAY_MS, ip: '1.2.3.4' });
        events.record({ event: 'jung', audit: true, ts: now - 29 * DAY_MS });

        const result = await events.purge();
        assert.equal(result.audit, 1);
        const names = events.readAudit({ limit: Infinity }).map(entry => entry.event);
        assert.deepEqual(names, ['jung']);
    } finally {
        events.close();
    }
});

test('retention: nur alte, unbestaetigte Konten werden still entfernt', async () => {
    const fx = await retentionFixture({ auditLogDays: 0, unverifiedAccountDays: 30, closedTicketDays: 0 });
    try {
        const oldUnverified = await fx.customerStore.createCustomer({ email: 'alt@example.com', name: 'A', password: 'x'.repeat(12) });
        const oldVerified = await fx.customerStore.createCustomer({ email: 'ok@example.com', name: 'B', password: 'x'.repeat(12) });
        const young = await fx.customerStore.createCustomer({ email: 'neu@example.com', name: 'C', password: 'x'.repeat(12) });
        fx.customerStore.markVerified(oldVerified.id);
        fx.db.prepare('UPDATE customers SET created_at = ? WHERE id IN (?, ?)')
            .run(Date.now() - 40 * DAY_MS, oldUnverified.id, oldVerified.id);

        const result = await fx.retention.runOnce();
        assert.equal(result.accounts, 1);
        assert.equal(fx.customerStore.getCustomer(oldUnverified.id), null);
        assert.ok(fx.customerStore.getCustomer(oldVerified.id));
        assert.ok(fx.customerStore.getCustomer(young.id));
        assert.deepEqual(fx.destroyed, [oldUnverified.id]);
        assert.deepEqual(fx.forgotten.addresses, ['alt@example.com']);
    } finally {
        await fx.cleanup();
    }
});

test('retention: alte geschlossene Tickets samt Anhang-Dateien werden geloescht, geloeste und junge bleiben', async () => {
    const fx = await retentionFixture({ auditLogDays: 0, unverifiedAccountDays: 0, closedTicketDays: 90 });
    try {
        const customer = await fx.customerStore.createCustomer({ email: 'k@example.com', name: 'K', password: 'x'.repeat(12) });
        fx.customerStore.markVerified(customer.id);
        const full = fx.customerStore.getCustomer(customer.id);
        const make = subject => fx.ticketStore.createTicket({ customer: full, subject, body: 'x' });

        const old = make('alt');
        const [saved] = await fx.attachmentStore.storeAll(
            fx.attachmentStore.inspectBuffers([{ filename: 'a.png', content: PNG }]),
            { ticketId: old.ticket.id, messageId: old.message.id }
        );
        const recent = make('jung');
        const resolved = make('geloest');
        const longAgo = Date.now() - 100 * DAY_MS;
        const set = fx.db.prepare('UPDATE tickets SET status = ?, closed_at = ? WHERE id = ?');
        set.run('closed', longAgo, old.ticket.id);
        set.run('closed', Date.now() - DAY_MS, recent.ticket.id);
        set.run('resolved', null, resolved.ticket.id);

        const result = await fx.retention.runOnce();
        assert.equal(result.tickets, 1);
        assert.equal(fx.ticketStore.getTicket(old.ticket.id), null);
        assert.ok(fx.ticketStore.getTicket(recent.ticket.id));
        assert.ok(fx.ticketStore.getTicket(resolved.ticket.id));
        assert.equal(fs.existsSync(fx.attachmentStore.filePath(saved.id)), false);
        assert.deepEqual(fx.forgotten.tickets, [old.ticket.id]);
    } finally {
        await fx.cleanup();
    }
});

test('retention: Frist 0 schaltet ab, ein Lauf ohne Treffer schreibt keinen Audit-Eintrag', async () => {
    const fx = await retentionFixture({ auditLogDays: 0, unverifiedAccountDays: 0, closedTicketDays: 0 });
    try {
        await fx.auditLog.log('uralt', {});
        const result = await fx.retention.runOnce();
        assert.deepEqual(result, { accounts: 0, tickets: 0 });
        assert.deepEqual((await fx.auditLog.read()).map(entry => entry.event), ['uralt']);
    } finally {
        await fx.cleanup();
    }
});

test('retention laeuft beim Start der App mit den konfigurierten Fristen', async t => {
    // Erste Instanz legt ein unbestaetigtes Konto an, das danach kuenstlich
    // gealtert wird; die neu gestartete App muss es beim Start entfernen
    const first = await startTestApp();
    t.after(() => fsp.rm(first.root, { recursive: true, force: true }));
    const customer = await first.services.customerStore.createCustomer({
        email: 'alt@example.com', name: 'Alt', password: 'lang-genug-123',
    });
    await first.shutdown();
    const dbFile = path.join(first.root, 'data', 'ticket-system.db');
    const raw = new DatabaseSync(dbFile);
    raw.prepare('UPDATE customers SET created_at = ? WHERE id = ?').run(Date.now() - 10 * DAY_MS, customer.id);
    raw.close();

    const policy = { auditLogDays: 90, unverifiedAccountDays: 1, closedTicketDays: 0 };
    const instance = createApp({
        tmpDir: path.join(first.root, 'tmp-uploads'),
        dataDir: path.join(first.root, 'data'),
        adminPassword: 'x'.repeat(16), sessionSecret: 's', sweepTmpUploads: false,
        startMailWorkers: false, minFreeDiskMb: 0, requestLog: false, log: QUIET,
        maintenanceIntervalMs: 60 * 60 * 1000, retentionPolicy: policy,
    });
    await instance.start();
    try {
        assert.deepEqual(instance.services.retention.policy, policy);
        assert.equal(instance.services.customerStore.getCustomer(customer.id), null);
        const events = (await instance.services.auditLog.read()).map(entry => entry.event);
        assert.ok(events.includes('retention_purge'));
    } finally {
        await instance.stop();
    }
});

test('Datenschutzerklaerung nennt die tatsaechlich konfigurierten Loeschfristen', async t => {
    const app = await startTestApp({
        retentionPolicy: { auditLogDays: 45, unverifiedAccountDays: 14, closedTicketDays: 0 },
    });
    t.after(() => app.close());
    const html = await (await fetch(app.url('/privacy'))).text();
    assert.match(html, /nach 45 Tagen automatisch gelöscht/);
    assert.match(html, /innerhalb von 14 Tagen bestätigt/);
    assert.doesNotMatch(html, /Geschlossene Tickets werden/);
});

/* ===================================================== healthz/metrics */

test('/healthz prueft die Datenbank und meldet 503, wenn sie nicht erreichbar ist', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const ok = await fetch(app.url('/healthz'));
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).db, 'ok');

    app.services.db.close();
    const broken = await fetch(app.url('/healthz'));
    assert.equal(broken.status, 503);
    assert.equal((await broken.json()).status, 'error');
});

test('/metrics enthaelt Betriebswerte (Outbox, Backups, Speicher, Version)', async t => {
    const app = await startTestApp({ diskInfo: async () => ({ free: 12345, device: 1 }) });
    t.after(() => app.close());
    await app.services.backupStore.createBackup('manual');

    const res = await fetch(app.url('/metrics'));
    assert.equal(res.status, 200);
    const body = await res.text();
    const version = require('../package.json').version;
    assert.ok(body.includes(`ticket_system_build_info{version="${version}",schema="${SCHEMA_VERSION}"`));
    assert.match(body, /^ticket_system_mail_outbox\{status="failed"\} 0$/m);
    assert.match(body, /^ticket_system_backups 1$/m);
    assert.match(body, /^ticket_system_backup_last_timestamp_seconds [1-9]\d*(\.\d+)?$/m);
    assert.match(body, /^ticket_system_disk_free_bytes\{volume="data"\} 12345$/m);
    assert.match(body, /^ticket_system_ticket_attachments 0$/m);
    assert.match(body, /^ticket_system_db_bytes [1-9]\d*$/m);
    const eventLoopLag = body.match(
        /^ticket_system_event_loop_lag_seconds\{quantile="0\.95"\} (\S+)$/m,
    );
    assert.ok(eventLoopLag, 'p95 event-loop lag metric is missing');
    assert.ok(Number.isFinite(Number(eventLoopLag[1])), 'p95 event-loop lag must be a finite number');
});

test('/metrics verlangt mit gesetztem METRICS_TOKEN ein passendes Bearer-Token', async t => {
    const app = await startTestApp({ metricsToken: 'scrape-geheim' });
    t.after(() => app.close());

    const none = await fetch(app.url('/metrics'));
    assert.equal(none.status, 401);
    assert.match(none.headers.get('www-authenticate'), /Bearer/);
    const wrong = await fetch(app.url('/metrics'), { headers: { Authorization: 'Bearer falsch' } });
    assert.equal(wrong.status, 401);
    const right = await fetch(app.url('/metrics'), { headers: { Authorization: 'Bearer scrape-geheim' } });
    assert.equal(right.status, 200);
    assert.match(await right.text(), /ticket_system_tickets/);
});

/* ======================================================== Deployment */

test('.dockerignore haelt Datenbank, Temp-Uploads und Secrets aus dem Image', async () => {
    const lines = (await fsp.readFile(path.join(ROOT, '.dockerignore'), 'utf8'))
        .split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    for (const entry of ['data', 'tmp-uploads', '.env', '.env.*', '*.db', 'node_modules', '.git', 'test']) {
        assert.ok(lines.includes(entry), `${entry} fehlt in .dockerignore`);
    }
});

test('docker-compose bindet die App nur lokal, setzt TRUST_PROXY und eine Stop-Frist ueber dem Shutdown-Timeout', async () => {
    const compose = await fsp.readFile(path.join(ROOT, 'docker-compose.yml'), 'utf8');
    assert.match(compose, /"127\.0\.0\.1:3000:3000"/);
    assert.doesNotMatch(compose, /^\s*- "3000:3000"/m);
    assert.match(compose, /TRUST_PROXY=\$\{TRUST_PROXY:-1\}/);
    const grace = Number(/stop_grace_period:\s*(\d+)s/.exec(compose)[1]) * 1000;
    const shutdownMs = Number(/SHUTDOWN_TIMEOUT_MS:-(\d+)/.exec(compose)[1]);
    assert.ok(grace > shutdownMs + 5000, 'stop_grace_period muss ueber SHUTDOWN_TIMEOUT_MS + Notausgang liegen');
    assert.match(compose, /max-size/);
});

test('Dockerfile laeuft als node-User mit gepinntem Basis-Image und Healthcheck', async () => {
    const dockerfile = await fsp.readFile(path.join(ROOT, 'Dockerfile'), 'utf8');
    assert.match(dockerfile, /^FROM node:\d+\.\d+-alpine@sha256:[a-f0-9]{64}$/m);
    assert.doesNotMatch(dockerfile, /apk upgrade/);
    assert.match(dockerfile, /^USER node$/m);
    assert.match(dockerfile, /^HEALTHCHECK .*\r?\n?.*\/healthz/m);
    assert.match(dockerfile, /npm ci --omit=dev/);
});
