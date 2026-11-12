'use strict';

const crypto = require('crypto');
const fsp = require('fs/promises');
const { monitorEventLoopDelay } = require('perf_hooks');

const { SCHEMA_VERSION } = require('../db');
const { defaultDiskInfo } = require('../disk');
const { SEVERITY } = require('../event-catalog');

function metricLine(name, type, help, value) {
    return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name} ${value}`;
}

function labelled(name, type, help, samples) {
    const lines = samples.map(([labels, value]) => {
        const rendered = Object.entries(labels)
            .map(([key, val]) => `${key}="${String(val).replace(/["\\\n]/g, '_')}"`)
            .join(',');
        return `${name}{${rendered}} ${value}`;
    });
    return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${lines.join('\n')}`;
}

async function fileSizeOrZero(file) {
    try {
        return (await fsp.stat(file)).size;
    } catch {
        return 0;
    }
}

function eventLoopSamples(histogram) {
    const seconds = value => Number.isFinite(value) ? value / 1e9 : 0;
    return [
        [{ quantile: '0.50' }, seconds(histogram.percentile(50))],
        [{ quantile: '0.95' }, seconds(histogram.percentile(95))],
        [{ quantile: '0.99' }, seconds(histogram.percentile(99))],
        [{ quantile: 'max' }, seconds(histogram.max)],
    ];
}

function registerOpsRoutes({
    app, db, events, metricsToken, appVersion, dataDir, dbPath, diskInfo,
    backupStore, outbox, ticketStore, customerStore, attachmentStore,
    imapPoller, inboundProcessor,
}) {
    const eventLoop = monitorEventLoopDelay({ resolution: 20 });
    eventLoop.enable();

    /* Eine echte DB-Abfrage erkennt geschlossene oder defekte Datenbanken. */
    app.get('/healthz', (req, res) => {
        let dbOk = true;
        try {
            db.prepare('SELECT 1').get();
        } catch (err) {
            dbOk = false;
            events.record({
                event: 'healthcheck_failed', module: 'database', severity: SEVERITY.CRITICAL,
                message: 'Datenbank nicht nutzbar', error: err,
            });
        }
        res.status(dbOk ? 200 : 503).json({
            status: dbOk ? 'ok' : 'error',
            db: dbOk ? 'ok' : 'error',
            uptime: Math.round(process.uptime()),
        });
    });

    const metricsTokenHash = metricsToken
        ? crypto.createHash('sha256').update(String(metricsToken)).digest()
        : null;

    function metricsAuthorized(req) {
        if (!metricsTokenHash) return true;
        const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
        if (!match) return false;
        const candidate = crypto.createHash('sha256').update(match[1].trim()).digest();
        return crypto.timingSafeEqual(candidate, metricsTokenHash);
    }

    app.get('/metrics', async (req, res, next) => {
        if (!metricsAuthorized(req)) {
            res.set('WWW-Authenticate', 'Bearer realm="metrics"');
            return res.status(401).type('text/plain').send('Nicht autorisiert');
        }
        try {
            const diskInfoFn = diskInfo || defaultDiskInfo;
            const [backups, dataDisk, dbBytes, walBytes] = await Promise.all([
                backupStore.listBackups().catch(() => []),
                diskInfoFn(dataDir),
                fileSizeOrZero(dbPath),
                fileSizeOrZero(dbPath + '-wal'),
            ]);
            const mailCounts = outbox.counts();
            const regularBackups = backups.filter(backup => !backup.preRestore);
            const lastBackup = regularBackups.length > 0
                ? Math.max(...regularBackups.map(backup => backup.createdAt)) / 1000 : 0;
            const views = ticketStore.countViews();
            const attachmentTotals = attachmentStore.totals();
            const countEvents = (...names) => events.countAudit(names);

            const lines = [
                metricLine('ticket_system_uptime_seconds', 'gauge',
                    'Sekunden seit Prozessstart.', process.uptime()),
                labelled('ticket_system_build_info', 'gauge', 'Version der laufenden App und des DB-Schemas.',
                    [[{ version: appVersion, schema: SCHEMA_VERSION, node: process.version }, 1]]),
                labelled('ticket_system_tickets', 'gauge', 'Tickets je Ansicht des Admin-Posteingangs.',
                    ['new', 'open', 'pending', 'overdue', 'snoozed', 'unread']
                        .filter(view => views[view] !== undefined)
                        .map(view => [{ view }, views[view]])),
                metricLine('ticket_system_customers', 'gauge', 'Anzahl der Kundenkonten.', customerStore.countCustomers()),
                metricLine('ticket_system_ticket_attachments', 'gauge',
                    'Anzahl gespeicherter Ticket-Anhaenge.', attachmentTotals.count),
                metricLine('ticket_system_ticket_attachments_bytes', 'gauge',
                    'Gesamtgroesse der Ticket-Anhaenge (DATA_DIR/ticket-attachments).', attachmentTotals.bytes),
                metricLine('ticket_system_login_failures_total', 'counter',
                    'Fehlgeschlagene Admin-Anmeldeversuche ueber Passwort, TOTP oder Passkey (aus dem Audit-Log).',
                    countEvents('login_failed', 'totp_login_failed', 'passkey_login_failed')),
                metricLine('ticket_system_login_successes_total', 'counter',
                    'Erfolgreiche Admin-Anmeldungen (aus dem Audit-Log).',
                    countEvents('login_success', 'totp_login_success', 'passkey_login_success')),
                labelled('ticket_system_mail_outbox', 'gauge',
                    'Mails in der Outbox je Status (failed = endgueltig fehlgeschlagen).',
                    ['pending', 'failed'].map(status => [{ status }, mailCounts[status] ?? 0])),
                metricLine('ticket_system_mail_enabled', 'gauge',
                    '1 wenn SMTP konfiguriert ist.', outbox.enabled ? 1 : 0),
                metricLine('ticket_system_backups', 'gauge',
                    'Anzahl regulaerer Datenbank-Sicherungen (ohne pre-restore).', regularBackups.length),
                metricLine('ticket_system_backup_last_timestamp_seconds', 'gauge',
                    'Zeitpunkt der juengsten regulaeren Sicherung (Unix-Sekunden, 0 = keine).', lastBackup),
                metricLine('ticket_system_db_bytes', 'gauge',
                    'Groesse der SQLite-Datenbank inklusive WAL-Datei.', dbBytes + walBytes),
                labelled('ticket_system_event_loop_lag_seconds', 'gauge',
                    'Event-Loop-Verzoegerung seit dem letzten Metrikabruf.', eventLoopSamples(eventLoop)),
            ];
            eventLoop.reset();

            if (imapPoller.enabled) {
                const inbound = inboundProcessor.stats();
                if (Object.keys(inbound).length > 0) {
                    lines.push(labelled('ticket_system_mail_inbound_total', 'counter',
                        'Eingehende Mails seit Prozessstart je Ergebnis (added/created/duplicate/abgelehnt mit Grund).',
                        Object.entries(inbound).map(([result, value]) => [{ result }, value])));
                }
                const { lastRunAt, lastError } = imapPoller.status;
                lines.push(
                    metricLine('ticket_system_imap_last_poll_ok', 'gauge',
                        '1 wenn der letzte IMAP-Abruf fehlerfrei war.', lastRunAt && !lastError ? 1 : 0),
                    metricLine('ticket_system_imap_last_poll_timestamp_seconds', 'gauge',
                        'Zeitpunkt des letzten IMAP-Abrufs (Unix-Sekunden).', (lastRunAt ?? 0) / 1000),
                );
            }
            if (dataDisk) {
                lines.push(labelled('ticket_system_disk_free_bytes', 'gauge',
                    'Freier Speicher auf dem Volume des jeweiligen Verzeichnisses.',
                    [[{ volume: 'data' }, dataDisk.free]]));
            }
            const state = events.status();
            lines.push(
                metricLine('ticket_system_events_queued', 'gauge',
                    'Ereignisse in der Schreib-Queue des Event-Logs.', state.queued),
                metricLine('ticket_system_events_written_total', 'counter',
                    'Seit Prozessstart ins Event-Log geschriebene Ereignisse.', state.written),
                metricLine('ticket_system_events_dropped_total', 'counter',
                    'Wegen voller Queue verworfene DEBUG/INFO-Ereignisse.', state.dropped),
                metricLine('ticket_system_events_write_failures_total', 'counter',
                    'Fehlgeschlagene Schreibvorgaenge des Event-Logs.', state.writeFailures),
            );

            res.type('text/plain; version=0.0.4; charset=utf-8');
            res.send(`${lines.join('\n\n')}\n`);
        } catch (err) {
            next(err);
        }
    });

    return {
        close() {
            eventLoop.disable();
        },
    };
}

module.exports = { registerOpsRoutes, metricLine, labelled, eventLoopSamples };
