'use strict';

/* Einheitentests der Module unter lib/ — kein Server, kein Netz. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');

const { openDatabase } = require('../lib/db');
const { SqliteSessionStore } = require('../lib/session-store');
const { createWebauthnStore } = require('../lib/webauthn-store');
const { createSessionSecretStore } = require('../lib/session-secret-store');
const { createPasswordStore } = require('../lib/password-store');
const { createUsernameStore } = require('../lib/username-store');
const { createSupportUserStore } = require('../lib/support-user-store');
const {
    safeCredentialId, safePasskeyLabel, safeUsername, safeBackupName,
} = require('../lib/safe-name');
const {
    generateSecret, base32Encode, base32Decode, totpAt, verifyTotp, buildOtpauthUri,
} = require('../lib/totp');
const { createTotpStore } = require('../lib/totp-store');
const { createAuditLog } = require('../lib/audit-log');
const { createEventStore } = require('../lib/event-store');
const { createBackupStore } = require('../lib/backup-store');

async function tempDir() {
    return fsp.mkdtemp(path.join(os.tmpdir(), 'ticket-system-unit-'));
}

/* Eine In-Memory-DB je Test — schnell, kein Aufraeumen noetig. Fuer Tests,
   die einen Neustart simulieren (dieselbe Datenbank, neue Store-Instanz),
   braucht es stattdessen eine echte Datei, siehe restartDb() unten. */
function memoryDb() {
    return openDatabase(':memory:');
}

/* Audit-Log ueber einen Event-Store im Speicher (siehe lib/audit-log.js) */
function memoryAuditLog() {
    return createAuditLog({ events: createEventStore({ file: ':memory:' }) });
}

async function restartDb() {
    const dir = await tempDir();
    const file = path.join(dir, 'test.db');
    return { file, open: () => openDatabase(file), cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

/* ============================================================ safe-name */

test('safeCredentialId akzeptiert nur base64url', () => {
    assert.equal(safeCredentialId('abcDEF012_-'), 'abcDEF012_-');
    for (const input of ['../x', 'abc+def', 'abc/def', 'abc=', '', null, 'a'.repeat(513)]) {
        assert.equal(safeCredentialId(input), null, `haette ${JSON.stringify(input)} ablehnen muessen`);
    }
});

test('safePasskeyLabel trimmt und begrenzt', () => {
    assert.equal(safePasskeyLabel('  Windows Hello  '), 'Windows Hello');
    assert.equal(safePasskeyLabel('YubiKey (Büro)'), 'YubiKey (Büro)');
    for (const input of ['', '   ', null, 'a'.repeat(65), '<script>']) {
        assert.equal(safePasskeyLabel(input), null, `haette ${JSON.stringify(input)} ablehnen muessen`);
    }
});

test('safeUsername akzeptiert Identifier ohne Leerzeichen', () => {
    assert.equal(safeUsername('  admin  '), 'admin');
    assert.equal(safeUsername('julian.foitzik'), 'julian.foitzik');
    assert.equal(safeUsername('admin@example.com'), 'admin@example.com');
    for (const input of ['', '   ', null, 'a'.repeat(65), 'mit leerzeichen', '<script>']) {
        assert.equal(safeUsername(input), null, `haette ${JSON.stringify(input)} ablehnen muessen`);
    }
});

/* ========================================================= session-store */

test('Session-Store haelt Sitzungen ueber Instanzen (Neustarts) hinweg', async () => {
    const { open, cleanup } = await restartDb();

    const firstDb = open();
    const first = new SqliteSessionStore({ db: firstDb });
    await promisify(first.set).bind(first)('sid-eins', {
        loggedIn: true,
        cookie: { expires: new Date(Date.now() + 60_000), maxAge: 60_000 },
    });
    first.close();
    firstDb.close();

    // Neue DB-Verbindung zur selben Datei = simulierter Neustart.
    const secondDb = open();
    const second = new SqliteSessionStore({ db: secondDb });
    const session = await promisify(second.get).bind(second)('sid-eins');
    assert.equal(session.loggedIn, true);
    second.close();
    secondDb.close();

    await cleanup();
});

test('Session-Store verwirft Abgelaufenes und unbekannte IDs', async () => {
    const store = new SqliteSessionStore({ db: memoryDb() });
    const get = promisify(store.get).bind(store);
    const set = promisify(store.set).bind(store);

    await set('abgelaufen', { cookie: { expires: new Date(Date.now() - 1000) } });
    assert.equal(await get('abgelaufen'), null);
    // get() entsorgt die Zeile gleich mit
    assert.equal(store.countStmt.get().n, 0);

    assert.equal(await get('nicht-vorhanden'), null);

    store.close();
});

test('prune entfernt abgelaufene Sitzungen', async () => {
    const store = new SqliteSessionStore({ db: memoryDb() });
    const set = promisify(store.set).bind(store);

    await set('lebt', { cookie: { expires: new Date(Date.now() + 60_000) } });
    await set('totA', { cookie: { expires: new Date(Date.now() - 1) } });
    await set('totB', { cookie: { expires: new Date(Date.now() - 1) } });

    assert.equal(store.prune(), 2);
    assert.equal(await promisify(store.length).bind(store)(), 1);

    store.close();
});

/* ========================================================= webauthn-store */

test('getOrCreateUserId ist stabil, auch ueber Instanzen (Neustarts) hinweg', async () => {
    const { open, cleanup } = await restartDb();

    const firstDb = open();
    const store = createWebauthnStore({ db: firstDb });
    const id = await store.getOrCreateUserId();
    assert.equal(await store.getOrCreateUserId(), id);
    firstDb.close();

    const secondDb = open();
    const restarted = createWebauthnStore({ db: secondDb });
    assert.equal(await restarted.getOrCreateUserId(), id);
    secondDb.close();

    await cleanup();
});

test('addCredential/findCredential geben alle Felder unveraendert zurueck', async () => {
    const store = createWebauthnStore({ db: memoryDb() });

    await store.addCredential({
        credentialId: 'cred-1',
        publicKey: 'cHVia2V5',
        counter: 0,
        transports: ['internal'],
        label: 'Windows Hello',
    });

    const found = await store.findCredential('cred-1');
    assert.equal(found.credentialId, 'cred-1');
    assert.equal(found.publicKey, 'cHVia2V5');
    assert.equal(found.counter, 0);
    assert.deepEqual(found.transports, ['internal']);
    assert.equal(found.label, 'Windows Hello');
    assert.equal(typeof found.createdAt, 'number');
});

test('addCredential wirft bei doppelter credentialId', async () => {
    const store = createWebauthnStore({ db: memoryDb() });
    await store.addCredential({ credentialId: 'x', publicKey: 'k', counter: 0, label: 'A' });
    await assert.rejects(() =>
        store.addCredential({ credentialId: 'x', publicKey: 'k', counter: 0, label: 'B' })
    );
});

test('listCredentials enthaelt nie den publicKey', async () => {
    const store = createWebauthnStore({ db: memoryDb() });
    await store.addCredential({ credentialId: 'x', publicKey: 'geheim', counter: 0, label: 'A' });

    const list = await store.listCredentials();
    assert.equal(list.length, 1);
    assert.equal(list[0].credentialId, 'x');
    assert.equal('publicKey' in list[0], false);
});

test('updateCounter persistiert, removeCredential entfernt', async () => {
    const store = createWebauthnStore({ db: memoryDb() });
    await store.addCredential({ credentialId: 'x', publicKey: 'k', counter: 0, label: 'A' });

    await store.updateCounter('x', 5);
    assert.equal((await store.findCredential('x')).counter, 5);

    assert.equal(await store.removeCredential('nicht-vorhanden'), false);
    assert.equal(await store.removeCredential('x'), true);
    assert.equal(await store.findCredential('x'), null);
    assert.deepEqual(await store.listCredentials(), []);
});

test('keine Passkeys ist der Ausgangszustand einer frischen DB', async () => {
    const store = createWebauthnStore({ db: memoryDb() });
    assert.deepEqual(await store.listCredentials(), []);
    assert.equal(typeof (await store.getOrCreateUserId()), 'string');
});

test('parallele addCredential-Aufrufe landen beide', async () => {
    const store = createWebauthnStore({ db: memoryDb() });

    await Promise.all([
        store.addCredential({ credentialId: 'a', publicKey: 'k', counter: 0, label: 'A' }),
        store.addCredential({ credentialId: 'b', publicKey: 'k', counter: 0, label: 'B' }),
    ]);

    const list = await store.listCredentials();
    assert.deepEqual(list.map(c => c.credentialId).sort(), ['a', 'b']);
});

/* ==================================================== session-secret-store */

test('ensure() persistiert den Kandidaten beim ersten Aufruf und liefert ihn danach zurueck', async () => {
    const store = createSessionSecretStore({ db: memoryDb() });

    assert.equal(store.read(), null);
    assert.equal(store.ensure('erster-kandidat'), 'erster-kandidat');
    assert.equal(store.read(), 'erster-kandidat');

    // Ein zweiter Kandidat (z. B. eine geaenderte Env-Var) darf den
    // persistierten Wert nicht mehr ueberschreiben.
    assert.equal(store.ensure('zweiter-kandidat'), 'erster-kandidat');
    assert.equal(store.read(), 'erster-kandidat');
});

test('session-secret ueberlebt eine neue Store-Instanz (simulierter Neustart)', async () => {
    const { open, cleanup } = await restartDb();

    const firstDb = open();
    const first = createSessionSecretStore({ db: firstDb });
    first.ensure('bootstrap-secret');
    firstDb.close();

    const secondDb = open();
    const second = createSessionSecretStore({ db: secondDb });
    // Ein Neustart ohne gesetzte Env-Var wuerde hier sonst einen neuen
    // Kandidaten anbieten — der persistierte Wert muss trotzdem gewinnen.
    assert.equal(second.ensure('anderer-kandidat-nach-neustart'), 'bootstrap-secret');
    secondDb.close();

    await cleanup();
});

/* ========================================================== password-store */

test('setPassword/verify: richtiges Passwort true, falsches false', async () => {
    const store = createPasswordStore({ db: memoryDb() });

    const record = await store.setPassword('korrekt-horse-battery');
    assert.equal(await store.verify('korrekt-horse-battery', record), true);
    assert.equal(await store.verify('falsch', record), false);
});

test('read() liefert null, solange kein Passwort gesetzt wurde', async () => {
    const store = createPasswordStore({ db: memoryDb() });
    assert.equal(await store.read(), null);
});

test('Passwort-Hash ueberlebt eine neue Store-Instanz (simulierter Neustart)', async () => {
    const { open, cleanup } = await restartDb();

    const firstDb = open();
    const first = createPasswordStore({ db: firstDb });
    await first.setPassword('neues-passwort');
    firstDb.close();

    const secondDb = open();
    const second = createPasswordStore({ db: secondDb });
    const record = await second.read();
    assert.notEqual(record, null);
    assert.equal(await second.verify('neues-passwort', record), true);
    secondDb.close();

    await cleanup();
});

/* ========================================================== username-store */

test('support-user-store: Owner-Migration, Rollen, Passwoerter und Deaktivierung', async () => {
    const db = memoryDb();
    const passwords = createPasswordStore({ db });
    await passwords.setPassword('owner-passwort');
    const store = createSupportUserStore({ db });
    const owner = await store.ensureOwner({ username: 'admin', passwordRecord: await passwords.read() });
    assert.equal(owner.isOwner, true);
    assert.equal(owner.role, 'admin');

    const created = await store.create({
        username: 'agent', displayName: 'Alex Support', role: 'agent', password: 'agent-passwort',
    });
    assert.equal(created.user.displayName, 'Alex Support');
    assert.equal((await store.create({
        username: 'AGENT', displayName: 'Doppelt', role: 'agent', password: 'agent-passwort',
    })).error, 'Dieser Benutzername ist bereits vergeben.');
    assert.equal(await store.verifyPassword('agent-passwort', store.findByUsername('Agent')), true);
    assert.equal(await store.verifyPassword('falsch', store.findByUsername('agent')), false);
    assert.equal(await store.verifyPassword('falsch', null), false);

    const updated = store.update(created.user.id, {
        username: 'alex', displayName: 'Alex Neu', role: 'admin', disabled: true,
    }).user;
    assert.equal(updated.disabled, true);
    assert.equal(updated.role, 'admin');
    await store.setPassword(updated.id, 'neues-passwort');
    assert.equal(await store.verifyPassword('neues-passwort', store.findByUsername('alex')), true);
    store.recordLogin(updated.id);
    assert.ok(store.get(updated.id).lastLoginAt);
    assert.equal(store.remove(owner.id), false);
    assert.equal(store.remove(updated.id), true);
    assert.equal(store.get(updated.id), null);
    db.close();
});

test('write/read: Roundtrip liefert genau den gespeicherten Benutzernamen', async () => {
    const store = createUsernameStore({ db: memoryDb() });

    assert.equal(await store.read(), null);
    await store.write('julian');
    assert.equal(await store.read(), 'julian');
});

test('Benutzername ueberlebt eine neue Store-Instanz (simulierter Neustart)', async () => {
    const { open, cleanup } = await restartDb();

    const firstDb = open();
    const first = createUsernameStore({ db: firstDb });
    await first.write('neuer-name');
    firstDb.close();

    const secondDb = open();
    const second = createUsernameStore({ db: secondDb });
    assert.equal(await second.read(), 'neuer-name');
    secondDb.close();

    await cleanup();
});

/* ================================================================== totp */

test('base32Encode/base32Decode: Roundtrip fuer beliebige Bytelaengen', () => {
    for (const length of [1, 5, 10, 16, 20, 33]) {
        const original = crypto.randomBytes(length);
        const encoded = base32Encode(original);
        assert.match(encoded, /^[A-Z2-7]+$/);
        assert.ok(base32Decode(encoded).equals(original));
    }
});

test('totpAt liefert einen 6-stelligen Code, stabil innerhalb eines 30s-Schritts', () => {
    const secret = generateSecret();
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const code = totpAt(secret, now);
    assert.match(code, /^\d{6}$/);
    // Innerhalb desselben 30s-Fensters identisch
    assert.equal(totpAt(secret, now + 5000), code);
    // Verschiedene Sekunden ergeben typischerweise verschiedene Codes ueber
    // ein ganzes 30s-Fenster hinweg betrachtet
    assert.notEqual(totpAt(secret, now + 30000), code);
});

test('verifyTotp akzeptiert den aktuellen Code und toleriert +/- 1 Schritt', () => {
    const secret = generateSecret();
    const now = Date.now();
    const code = totpAt(secret, now);

    assert.equal(verifyTotp(secret, code, { time: now }), true);
    assert.equal(verifyTotp(secret, code, { time: now + 30000 }), true, 'ein Schritt spaeter noch gueltig');
    assert.equal(verifyTotp(secret, code, { time: now - 30000 }), true, 'ein Schritt frueher noch gueltig');
    assert.equal(verifyTotp(secret, code, { time: now + 90000 }), false, 'drei Schritte weiter nicht mehr gueltig');
});

test('verifyTotp weist falsche und falsch formatierte Codes ab', () => {
    const secret = generateSecret();
    assert.equal(verifyTotp(secret, '000000'), false);
    assert.equal(verifyTotp(secret, 'abcdef'), false);
    assert.equal(verifyTotp(secret, ''), false);
    assert.equal(verifyTotp(secret, null), false);
});

test('buildOtpauthUri enthaelt Secret, Label und Issuer', () => {
    const uri = buildOtpauthUri({ secret: 'ABCDEFGH', label: 'admin', issuer: 'Mein Support' });
    assert.match(uri, /^otpauth:\/\/totp\//);
    assert.match(uri, /secret=ABCDEFGH/);
    assert.match(uri, /issuer=Mein\+Support/);
});

/* ============================================================ totp-store */

test('totp-store: isEnabled/getSecret vor dem Aktivieren', async () => {
    const store = createTotpStore({ db: memoryDb() });

    assert.equal(await store.isEnabled(), false);
    assert.equal(await store.getSecret(), null);
});

test('totp-store: enable() persistiert und liefert 8 einmalige Recovery-Codes', async () => {
    const store = createTotpStore({ db: memoryDb() });

    const codes = await store.enable('JBSWY3DPEHPK3PXP');
    assert.equal(codes.length, 8);
    assert.ok(codes.every(code => /^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/.test(code)));
    assert.equal(new Set(codes).size, 8, 'Codes muessen sich unterscheiden');

    assert.equal(await store.isEnabled(), true);
    assert.equal(await store.getSecret(), 'JBSWY3DPEHPK3PXP');
});

test('totp-store: consumeRecoveryCode verbraucht einen Code genau einmal', async () => {
    const store = createTotpStore({ db: memoryDb() });
    const [firstCode] = await store.enable('JBSWY3DPEHPK3PXP');

    assert.equal(await store.consumeRecoveryCode('nicht-vorhanden'), false);
    assert.equal(await store.consumeRecoveryCode(firstCode), true);
    assert.equal(await store.consumeRecoveryCode(firstCode), false, 'derselbe Code darf kein zweites Mal gelten');
});

test('totp-store: enable() ist alles-oder-nichts, wenn ein Recovery-Code-Insert mittendrin fehlschlaegt', async () => {
    // Statements werden beim createTotpStore()-Aufruf selbst vorbereitet, das
    // Patchen muss also vorher an der rohen db ansetzen, nicht erst am
    // zurueckgegebenen Store.
    const db = memoryDb();
    const originalPrepare = db.prepare.bind(db);
    let codeInserts = 0;
    db.prepare = sql => {
        const stmt = originalPrepare(sql);
        if (sql.includes('INSERT INTO totp_recovery_codes')) {
            const originalRun = stmt.run.bind(stmt);
            stmt.run = (...args) => {
                codeInserts += 1;
                // Simuliert einen Fehler beim Schreiben eines Recovery-Codes
                // (z. B. Platte voll) — ohne Transaktion bliebe TOTP als
                // "aktiviert" stehen, obwohl nur ein Teil der Codes existiert.
                if (codeInserts === 4) throw new Error('simulierter Fehler beim Schreiben');
                return originalRun(...args);
            };
        }
        return stmt;
    };
    const store = createTotpStore({ db });

    await assert.rejects(() => store.enable('JBSWY3DPEHPK3PXP'));

    assert.equal(await store.isEnabled(), false, 'ein fehlgeschlagener enable() darf TOTP nicht halb aktiviert lassen');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM totp_recovery_codes').get().n, 0);
});

test('totp-store: disable() entfernt den Datensatz vollstaendig', async () => {
    const store = createTotpStore({ db: memoryDb() });
    await store.enable('JBSWY3DPEHPK3PXP');
    await store.disable();

    assert.equal(await store.isEnabled(), false);
});

/* ============================================================= audit-log */

test('audit-log: log()/read() liefern die juengsten Eintraege zuerst', async () => {
    const auditLog = memoryAuditLog();

    await auditLog.log('login_success', { ip: '127.0.0.1' });
    await auditLog.log('ticket_created', { ticket: 1001 });

    const entries = await auditLog.read();
    assert.equal(entries.length, 2);
    assert.equal(entries[0].event, 'ticket_created');
    assert.equal(entries[1].event, 'login_success');
    assert.equal(entries[0].ticket, 1001);
    assert.equal(typeof entries[0].ts, 'number');
});

test('audit-log: read() liefert die id mit, aufsteigend vergeben (fuer das Dashboard)', async () => {
    const auditLog = memoryAuditLog();

    await auditLog.log('login_success', { ip: '127.0.0.1' });
    await auditLog.log('ticket_created', { ticket: 1001 });

    const entries = await auditLog.read();
    assert.equal(typeof entries[0].id, 'number');
    assert.ok(entries[0].id > entries[1].id, 'neueste Eintraege haben die groessere id');
});

test('audit-log: read() ohne Eintraege liefert eine leere Liste', async () => {
    const auditLog = memoryAuditLog();
    assert.deepEqual(await auditLog.read(), []);
});

test('audit-log: read({limit: Infinity}) liefert alle Eintraege', async () => {
    const auditLog = memoryAuditLog();
    for (let i = 0; i < 5; i++) await auditLog.log('ereignis', { i });
    assert.equal((await auditLog.read({ limit: Infinity })).length, 5);
});

test('audit-log: ip wandert in die eigene Spalte, read() liefert sie im alten Format zurueck', async () => {
    const events = createEventStore({ file: ':memory:' });
    const auditLog = createAuditLog({ events });
    await auditLog.log('login_failed', { ip: '203.0.113.9', username: 'admin' });

    const [entry] = await auditLog.read();
    assert.equal(entry.ip, '203.0.113.9');
    assert.equal(entry.username, 'admin');
    const [event] = events.list({}).events;
    assert.equal(event.ip, '203.0.113.9');
    assert.equal(event.module, 'auth');
    assert.equal(event.severityLabel, 'WARNING');
    assert.equal(event.outcome, 'failure');
    assert.equal(event.audit, true);
    assert.equal(event.payload.ip, undefined);
});

/* ============================================================ safeBackupName */

test('safeBackupName akzeptiert nur das serverseitig erzeugte Format', () => {
    assert.equal(
        safeBackupName('ticket-system-20260922T140305Z-a1b2c3.db'),
        'ticket-system-20260922T140305Z-a1b2c3.db'
    );
    assert.equal(
        safeBackupName('pre-restore-ticket-system-20260922T140305Z-a1b2c3.db'),
        'pre-restore-ticket-system-20260922T140305Z-a1b2c3.db'
    );
});

test('safeBackupName weist Traversal und Freitext ab', () => {
    for (const input of [
        '../../../etc/passwd',
        'ticket-system.db',
        'ticket-system-20260922.db',
        'ticket-system-20260922T140305Z.db',       // ohne Zufalls-Suffix
        'ticket-system-20260922T140305Z-a1b2c3.db; rm -rf',
        '', null, undefined,
    ]) {
        assert.equal(safeBackupName(input), null, `haette ${JSON.stringify(input)} ablehnen muessen`);
    }
});

/* ============================================================ backup-store */

test('createBackup erzeugt eine Datei mit passender Checksumme, listBackups findet sie', async () => {
    const db = memoryDb();
    db.exec('CREATE TABLE probe (x INTEGER)');
    db.prepare('INSERT INTO probe (x) VALUES (1)').run();

    const dir = await tempDir();
    const store = createBackupStore({ db, backupDir: dir });

    const backup = await store.createBackup('manual');
    const filePath = path.join(dir, backup.file);
    const actualHash = crypto.createHash('sha256').update(await fsp.readFile(filePath)).digest('hex');
    assert.equal(backup.sha256, actualHash);
    assert.equal((await fsp.readFile(filePath + '.sha256', 'utf8')).trim(), actualHash);

    const list = await store.listBackups();
    assert.equal(list.length, 1);
    assert.equal(list[0].file, backup.file);
    assert.equal(list[0].sha256, actualHash);
    assert.equal(list[0].preRestore, false);

    await fsp.rm(dir, { recursive: true, force: true });
});

test('writeSettings klemmt Grenzwerte und lehnt nicht-numerische Eingaben ab', async () => {
    const dir = await tempDir();
    const store = createBackupStore({ db: memoryDb(), backupDir: dir });

    assert.equal(store.writeSettings({ intervalMinutes: 'x', retentionCount: 10, enabled: true }), null);

    const clamped = store.writeSettings({ intervalMinutes: 999999, retentionCount: -5, enabled: false });
    assert.equal(clamped.intervalMinutes, 1440);
    assert.equal(clamped.retentionCount, 1);
    assert.equal(clamped.enabled, false);
    assert.deepEqual(store.readSettings(), clamped);

    await fsp.rm(dir, { recursive: true, force: true });
});

test('createBackup kuerzt alte Sicherungen auf retentionCount, laesst pre-restore-Sicherungen aber unangetastet', async () => {
    const dir = await tempDir();
    const store = createBackupStore({ db: memoryDb(), backupDir: dir });
    store.writeSettings({ intervalMinutes: 60, retentionCount: 2, enabled: true });

    await store.createBackup('pre-restore');
    await store.createBackup('manual');
    await store.createBackup('manual');
    await store.createBackup('manual');

    const list = await store.listBackups();
    assert.equal(list.filter(b => !b.preRestore).length, 2, 'nur die 2 juengsten regulaeren Sicherungen bleiben');
    assert.equal(list.filter(b => b.preRestore).length, 1, 'pre-restore-Sicherung wird von der Kuerzung nicht angefasst');

    await fsp.rm(dir, { recursive: true, force: true });
});

test('deleteBackup entfernt Datei und Sidecar, verifyBackup erkennt eine manipulierte Sicherung', async () => {
    const dir = await tempDir();
    const store = createBackupStore({ db: memoryDb(), backupDir: dir });
    const backup = await store.createBackup('manual');

    assert.equal((await store.verifyBackup(backup.file)).ok, true);

    await fsp.appendFile(path.join(dir, backup.file), 'garbage');
    const mismatch = await store.verifyBackup(backup.file);
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.reason, 'mismatch');

    assert.equal(await store.deleteBackup(backup.file), true);
    assert.equal(await store.deleteBackup(backup.file), false, 'zweites Loeschen findet nichts mehr');
    assert.equal((await fsp.readdir(dir)).length, 0);
    assert.equal(await store.deleteBackup('../../etc/passwd'), false, 'ungueltiger Name wird abgelehnt');

    await fsp.rm(dir, { recursive: true, force: true });
});

test('restoreBackup ersetzt die Live-Datenbank durch die gewaehlte Sicherung und legt vorher eine Sicherheitskopie an', async () => {
    const { file: dbPath, open, cleanup } = await restartDb();
    const db = open();
    db.exec('CREATE TABLE probe (x TEXT)');
    db.prepare('INSERT INTO probe (x) VALUES (?)').run('original');

    const backupDir = await tempDir();
    const store = createBackupStore({ db, backupDir });
    const backup = await store.createBackup('manual'); // sichert den 'original'-Stand

    db.prepare('DELETE FROM probe').run();
    db.prepare('INSERT INTO probe (x) VALUES (?)').run('veraendert');

    const result = await store.restoreBackup(backup.file, { dbPath });
    assert.equal(result.restoredFrom, backup.file);
    assert.match(result.safetySnapshot, /^pre-restore-/);

    // db wurde von restoreBackup geschlossen — frisch oeffnen und pruefen
    const reopened = open();
    assert.deepEqual(reopened.prepare('SELECT x FROM probe').all().map(row => ({ ...row })), [{ x: 'original' }]);
    reopened.close();

    // Die pre-restore-Sicherheitskopie haelt den 'veraendert'-Stand von unmittelbar vor der Wiederherstellung fest
    const safetyDb = openDatabase(path.join(backupDir, result.safetySnapshot));
    assert.deepEqual(
        safetyDb.prepare('SELECT x FROM probe').all().map(row => ({ ...row })), [{ x: 'veraendert' }]
    );
    safetyDb.close();

    await fsp.rm(backupDir, { recursive: true, force: true });
    await cleanup();
});

test('restoreBackup lehnt eine Sicherung mit falscher Checksumme ab, ohne die Live-DB anzufassen', async () => {
    const { file: dbPath, open, cleanup } = await restartDb();
    const db = open();
    db.exec('CREATE TABLE probe (x TEXT)');
    db.prepare('INSERT INTO probe (x) VALUES (?)').run('unangetastet');

    const backupDir = await tempDir();
    const store = createBackupStore({ db, backupDir });
    const backup = await store.createBackup('manual');
    await fsp.appendFile(path.join(backupDir, backup.file), 'garbage');

    await assert.rejects(() => store.restoreBackup(backup.file, { dbPath }), /Checksumme/);
    assert.deepEqual(db.prepare('SELECT x FROM probe').all().map(row => ({ ...row })), [{ x: 'unangetastet' }]);

    db.close();
    await fsp.rm(backupDir, { recursive: true, force: true });
    await cleanup();
});

test('createBackup lehnt eine gleichzeitige zweite Sicherung mit code backup_in_progress ab', async () => {
    const dir = await tempDir();
    const store = createBackupStore({ db: memoryDb(), backupDir: dir });

    const [a, b] = await Promise.allSettled([store.createBackup('manual'), store.createBackup('manual')]);
    const fulfilled = [a, b].filter(r => r.status === 'fulfilled');
    const rejected = [a, b].filter(r => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'genau eine der beiden gleichzeitigen Sicherungen darf durchgehen');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, 'backup_in_progress');

    await fsp.rm(dir, { recursive: true, force: true });
});

test('restoreBackup lehnt eine gleichzeitige zweite Wiederherstellung ab, statt db.close() doppelt anzustossen', async () => {
    const { file: dbPath, open, cleanup } = await restartDb();
    const db = open();
    db.exec('CREATE TABLE probe (x TEXT)');
    db.prepare('INSERT INTO probe (x) VALUES (?)').run('erste-zeile');

    const backupDir = await tempDir();
    const store = createBackupStore({ db, backupDir });
    const backupA = await store.createBackup('manual');
    db.prepare('INSERT INTO probe (x) VALUES (?)').run('zweite-zeile');
    const backupB = await store.createBackup('manual');

    const [resultA, resultB] = await Promise.allSettled([
        store.restoreBackup(backupA.file, { dbPath }),
        store.restoreBackup(backupB.file, { dbPath }),
    ]);

    const fulfilled = [resultA, resultB].filter(r => r.status === 'fulfilled');
    const rejected = [resultA, resultB].filter(r => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'genau eine der beiden gleichzeitigen Restores darf db.close() erreichen');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, 'backup_in_progress');
    assert.equal(
        'dbClosed' in rejected[0].reason, false,
        'die abgelehnte Anfrage darf db.close() nie erreicht haben'
    );

    // Die Datei muss trotz der Race unbeschaedigt und wieder oeffenbar sein.
    open().close();

    await fsp.rm(backupDir, { recursive: true, force: true });
    await cleanup();
});

test('restoreBackup markiert einen Fehler nach db.close() mit dbClosed, statt ihn wie einen normalen Validierungsfehler zu behandeln', async () => {
    const { open, cleanup } = await restartDb();
    const db = open();
    db.exec('CREATE TABLE probe (x TEXT)');
    db.prepare('INSERT INTO probe (x) VALUES (?)').run('original');

    const backupDir = await tempDir();
    const store = createBackupStore({ db, backupDir });
    const backup = await store.createBackup('manual');

    // dbPath zeigt bewusst auf ein Verzeichnis statt eine Datei, damit
    // fsp.copyFile() ERST NACH dem db.close() scheitert (EISDIR) — steht
    // stellvertretend fuer z.B. eine volle Platte oder fehlende Schreib-
    // rechte an derselben Stelle.
    const bogusDbPath = await tempDir();

    await assert.rejects(
        () => store.restoreBackup(backup.file, { dbPath: bogusDbPath }),
        err => {
            assert.equal(err.dbClosed, true, 'ein Fehler nach db.close() muss dbClosed tragen');
            return true;
        }
    );

    await fsp.rm(backupDir, { recursive: true, force: true });
    await fsp.rm(bogusDbPath, { recursive: true, force: true });
    await cleanup();
});
