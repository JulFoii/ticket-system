'use strict';

/* Betriebsnahe Unit-Tests fuer Fehler- und Fallback-Pfade, die von den
 * HTTP-Integrationstests absichtlich nicht ausgeloest werden. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { promisify } = require('util');

const { openDatabase } = require('../lib/db');
const { createMailer } = require('../lib/mailer');
const { moveFile } = require('../lib/move-file');
const { createRuntimeJobs } = require('../lib/runtime-jobs');
const { suppressUnusedWebauthnExperimentalWarnings } = require('../lib/runtime-warnings');
const { SqliteSessionStore } = require('../lib/session-store');

test('mailer: deaktivierter Versand meldet Zustand und lehnt send ab', async () => {
    const warnings = [];
    const mailer = createMailer({ from: 'Support <help@example.test>', log: { warn: value => warnings.push(value) } });

    assert.equal(mailer.enabled, false);
    assert.equal(mailer.domain, 'example.test');
    assert.equal(warnings.length, 1);
    await assert.rejects(mailer.send({}), /SMTP_HOST fehlt/);
    assert.deepEqual(await mailer.verify(), { ok: false, error: 'SMTP_HOST ist nicht gesetzt.' });
});

test('mailer: Transport bekommt Thread-Header und optionale Inhalte korrekt', async () => {
    const sent = [];
    const transport = {
        async sendMail(message) { sent.push(message); return { messageId: 'sent-1' }; },
        async verify() {},
    };
    const mailer = createMailer({ secure: true, port: 2465, from: 'help@example.test', transport });
    const result = await mailer.send({
        to: 'customer@example.test', subject: 'Antwort', text: 'Hallo', html: '',
        headers: {
            messageId: '<new@example.test>', inReplyTo: '<old@example.test>',
            references: '<old@example.test>', replyTo: 'reply@example.test', 'X-Ticket': '1001',
        },
    });

    assert.equal(mailer.security, 'SMTPS (TLS, Port 2465)');
    assert.equal(result.messageId, 'sent-1');
    assert.deepEqual(sent[0], {
        from: 'help@example.test', to: 'customer@example.test', subject: 'Antwort', text: 'Hallo',
        html: undefined, messageId: '<new@example.test>', inReplyTo: '<old@example.test>',
        references: '<old@example.test>', replyTo: 'reply@example.test',
        headers: { 'X-Ticket': '1001' }, attachments: undefined,
    });
    assert.deepEqual(await mailer.verify(), { ok: true });
});

test('mailer: verify normalisiert fehlende Funktion und Transportfehler', async () => {
    const withoutVerify = createMailer({ transport: { sendMail() {} } });
    assert.deepEqual(await withoutVerify.verify(), { ok: true });

    const failing = createMailer({ transport: { sendMail() {}, async verify() { throw new Error('TLS kaputt'); } } });
    assert.deepEqual(await failing.verify(), { ok: false, error: 'TLS kaputt' });
});

test('moveFile: EXDEV kopiert ueber Mount-Grenzen und entfernt die Quelle', async t => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ticket-system-move-'));
    t.after(() => fsp.rm(dir, { recursive: true, force: true }));
    const source = path.join(dir, 'source.txt');
    const target = path.join(dir, 'target.txt');
    await fsp.writeFile(source, 'inhalt');
    t.mock.method(fsp, 'rename', async () => { const err = new Error('cross device'); err.code = 'EXDEV'; throw err; });

    await moveFile(source, target);

    assert.equal(await fsp.readFile(target, 'utf8'), 'inhalt');
    await assert.rejects(fsp.access(source), { code: 'ENOENT' });
});

test('moveFile: andere rename-Fehler werden unveraendert weitergereicht', async t => {
    const expected = Object.assign(new Error('keine Rechte'), { code: 'EACCES' });
    t.mock.method(fsp, 'rename', async () => { throw expected; });
    await assert.rejects(moveFile('quelle', 'ziel'), err => err === expected);
});

test('runtime-warnings unterdrueckt nur bekannte WebAuthn-Probes und ist idempotent', () => {
    const forwarded = [];
    const fakeProcess = { emitWarning: (...args) => forwarded.push(args) };
    suppressUnusedWebauthnExperimentalWarnings(fakeProcess);
    const filtered = fakeProcess.emitWarning;
    suppressUnusedWebauthnExperimentalWarnings(fakeProcess);

    fakeProcess.emitWarning('Web Crypto API ist experimentell', 'ExperimentalWarning');
    fakeProcess.emitWarning(new Error('ML-DSA capability'), { type: 'ExperimentalWarning' });
    fakeProcess.emitWarning('andere Warnung', 'ExperimentalWarning');
    fakeProcess.emitWarning('Web Crypto API Fehler', 'Warning');

    assert.equal(fakeProcess.emitWarning, filtered);
    assert.deepEqual(forwarded, [
        ['andere Warnung', 'ExperimentalWarning'],
        ['Web Crypto API Fehler', 'Warning'],
    ]);
});

test('runtime-jobs: Wartung fuehrt alle Jobs aus und isoliert Einzelfehler', async () => {
    const calls = [];
    const errors = [];
    const infos = [];
    const events = {
        async job(name, task) { calls.push(name); if (name === 'retention') throw new Error('retention kaputt'); return task(); },
        purge() { throw new Error('purge kaputt'); },
        maintain() { calls.push('events-maintain'); },
    };
    const jobs = createRuntimeJobs({
        db: openDatabase(':memory:'), events,
        log: { error: (...args) => errors.push(args), info: (...args) => infos.push(args) },
        tmpDir: '.', sweepTmpUploads: false, tmpSweepIntervalMs: 1000,
        backupStore: { readSettings: () => ({ enabled: false }) }, startMailWorkers: false,
        outbox: {}, imapPoller: {}, ticketAutomation: {}, ticketAutomationIntervalMs: 1000,
        customerStore: {}, retention: { runOnce() {} },
        attachmentStore: { async sweepOrphans() { return 2; } }, inboundStore: { prune() { return 3; } },
        maintenanceIntervalMs: 0,
    });

    await jobs.runMaintenance();
    jobs.armBackupTimer();
    jobs.stop();

    assert.deepEqual(calls, ['retention', 'mail-inbound-cleanup', 'event-log-purge', 'db-maintenance', 'events-maintain']);
    assert.equal(errors.length, 2);
    assert.match(errors[0][0], /Löschfristen/);
    assert.match(errors[1][0], /Event-Logs/);
    assert.equal(infos.length, 1);
    assert.equal(infos[0][1].orphans, 2);
});

test('session-store: clear, length, touch und kundenweises Abmelden', async t => {
    const db = openDatabase(':memory:');
    const store = new SqliteSessionStore({ db, ttlMs: 60_000 });
    t.after(() => { store.close(); db.close(); });
    const set = promisify(store.set).bind(store);
    const get = promisify(store.get).bind(store);
    const touch = promisify(store.touch).bind(store);
    const length = promisify(store.length).bind(store);
    const clear = promisify(store.clear).bind(store);

    await set('a', { customerId: 7, value: 'alt', cookie: {} });
    await set('b', { customerId: 7, cookie: {} });
    await set('c', { customerId: 8, cookie: {} });
    await touch('a', { customerId: 7, value: 'neu', cookie: { expires: new Date(Date.now() + 120_000) } });
    assert.equal((await get('a')).value, 'alt');
    assert.equal(store.destroyForCustomer(7, 'a'), 1);
    assert.equal(await length(), 2);
    await clear();
    assert.equal(await length(), 0);
});

test('session-store: kaputtes JSON wird beim Lesen entfernt', async t => {
    const db = openDatabase(':memory:');
    const store = new SqliteSessionStore({ db });
    t.after(() => { store.close(); db.close(); });
    db.prepare('INSERT INTO sessions (sid, expires, data_json) VALUES (?, ?, ?)')
        .run('kaputt', Date.now() + 60_000, '{kein json');

    assert.equal(await promisify(store.get).bind(store)('kaputt'), null);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});
