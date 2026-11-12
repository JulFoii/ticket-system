'use strict';

const { maintainDatabase } = require('./db');
const { sweepTmpDir } = require('./disk');

function createRuntimeJobs({
    db, events, log, tmpDir, sweepTmpUploads, tmpSweepIntervalMs,
    backupStore, startMailWorkers, outbox, imapPoller, ticketAutomation,
    ticketAutomationIntervalMs, customerStore, retention, attachmentStore,
    inboundStore, maintenanceIntervalMs, webhookService,
}) {
    const timers = [];
    let backupTimer = null;

    function every(intervalMs, task) {
        const timer = setInterval(task, intervalMs);
        timer.unref?.();
        timers.push(timer);
        return timer;
    }

    if (sweepTmpUploads) {
        every(tmpSweepIntervalMs, () => {
            events.job('tmp-cleanup', () => sweepTmpDir(tmpDir), { quiet: true }).catch(() => {});
        });
    }

    function armBackupTimer() {
        if (backupTimer) clearInterval(backupTimer);
        const settings = backupStore.readSettings();
        if (!settings.enabled) {
            backupTimer = null;
            return;
        }
        backupTimer = setInterval(() => {
            events.job('backup', async () => {
                const backup = await backupStore.createBackup('scheduled');
                return { file: backup.file, size: backup.size };
            }, { module: 'backup' }).catch(err => {
                log.error('Geplante Sicherung fehlgeschlagen:', err.message);
            });
        }, settings.intervalMinutes * 60 * 1000);
        backupTimer.unref?.();
    }
    armBackupTimer();

    if (startMailWorkers) {
        outbox.start();
        imapPoller.start();
        every(ticketAutomationIntervalMs, () => {
            events.job('ticket-automation', async () => {
                const result = ticketAutomation.runOnce();
                customerStore.purgeExpiredTokens();
                return result;
            }, { quiet: true }).catch(err => {
                log.error('Ticket-Automatik fehlgeschlagen:', err.message);
            });
        });
    }
    if (webhookService) {
        every(30_000, () => webhookService.deliverDue().catch(err => {
            log.error('Webhook-Auslieferung fehlgeschlagen:', err.message);
        }));
    }

    async function runMaintenance() {
        try {
            await events.job('retention', () => retention.runOnce());
        } catch (err) {
            log.error('Löschfristen fehlgeschlagen:', err);
        }
        try {
            await events.job('mail-inbound-cleanup', async () => {
                const orphans = await attachmentStore.sweepOrphans();
                const pruned = inboundStore.prune();
                if (orphans > 0) {
                    log.info(`${orphans} verwaiste Anhang-Datei(en) entfernt`, {
                        event: 'attachment_orphans_removed', orphans,
                    });
                }
                return { orphans, pruned };
            }, { module: 'tickets', quiet: true });
        } catch (err) {
            log.error('Aufräumen von Anhängen/Mail-Eingang fehlgeschlagen:', err);
        }
        try {
            await events.job('event-log-purge', () => events.purge());
        } catch (err) {
            log.error('Bereinigung des Event-Logs fehlgeschlagen:', err);
        }
        try {
            await events.job('db-maintenance', async () => {
                maintainDatabase(db);
                events.maintain();
            }, { module: 'database', quiet: true });
        } catch (err) {
            log.error('Datenbank-Pflege fehlgeschlagen:', err);
        }
    }

    if (maintenanceIntervalMs > 0) {
        every(maintenanceIntervalMs, () => { runMaintenance(); });
    }

    function stop() {
        timers.forEach(clearInterval);
        if (backupTimer) clearInterval(backupTimer);
        backupTimer = null;
    }

    return { armBackupTimer, runMaintenance, stop };
}

module.exports = { createRuntimeJobs };
