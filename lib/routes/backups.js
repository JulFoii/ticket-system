'use strict';

const fsp = require('fs/promises');
const path = require('path');

const { diff } = require('../event-store');
const { SEVERITY } = require('../event-catalog');
const { safeBackupName } = require('../safe-name');

function registerBackupRoutes({
    app, checkAuth, backupStore, auditLog, events, log, backupDir, dataDir, dbPath,
    adminPageData, armBackupTimer, exit = code => process.exit(code),
}) {
    app.post('/admin/backups', checkAuth, async (req, res, next) => {
        const wantsJson = req.accepts(['html', 'json']) === 'json';
        try {
            const backup = await backupStore.createBackup('manual');
            auditLog.log('backup_created', { ip: req.ip, file: backup.file, size: backup.size });
            if (wantsJson) return res.status(201).json(backup);
            res.redirect('/admin#tab-backups');
        } catch (err) {
            if (err.code === 'backup_in_progress') {
                if (wantsJson) return res.status(409).json({ error: err.message, code: err.code });
                return res.redirect('/admin#tab-backups');
            }
            next(err);
        }
    });

    app.get('/admin/backups/:filename/download', checkAuth, async (req, res, next) => {
        const filename = safeBackupName(req.params.filename);
        if (!filename) return res.status(400).send('Ungültiger Dateiname.');
        const file = path.join(backupDir, filename);
        try {
            await fsp.access(file);
        } catch {
            return res.status(404).send('Sicherung nicht gefunden.');
        }
        res.download(file, filename, err => {
            if (err && !res.headersSent) next(err);
        });
    });

    app.delete('/admin/backups/:filename', checkAuth, async (req, res) => {
        const filename = safeBackupName(req.params.filename);
        if (!filename) return res.status(400).json({ error: 'Ungültiger Dateiname.' });
        const removed = await backupStore.deleteBackup(filename);
        if (removed) auditLog.log('backup_deleted', { ip: req.ip, file: filename });
        res.status(removed ? 204 : 404).end();
    });

    app.post('/admin/backup-settings', checkAuth, async (req, res, next) => {
        const wantsJson = req.accepts(['html', 'json']) === 'json';
        const previousSettings = backupStore.readSettings();
        const updated = backupStore.writeSettings({
            intervalMinutes: req.body.intervalMinutes,
            retentionCount: req.body.retentionCount,
            enabled: Boolean(req.body.enabled),
        });
        if (!updated) {
            const error = 'Ungültige Werte für Intervall oder Aufbewahrung.';
            if (wantsJson) return res.status(400).json({ error });
            try {
                return res.status(400).render('admin', await adminPageData({ backupSettingsError: error }));
            } catch (err) {
                return next(err);
            }
        }
        try {
            armBackupTimer();
            auditLog.log('backup_settings_changed', {
                ip: req.ip, ...updated, changes: diff(previousSettings, updated),
            });
            if (wantsJson) return res.json(updated);
            res.redirect('/admin#tab-backups');
        } catch (err) {
            next(err);
        }
    });

    app.post('/admin/backups/:filename/restore', checkAuth, async (req, res, next) => {
        const filename = safeBackupName(req.params.filename);
        if (!filename) return res.status(400).json({ error: 'Ungültiger Dateiname.' });
        if (String(req.body.confirm ?? '') !== filename) {
            return res.status(400).json({ error: 'Bestätigung stimmt nicht mit dem Dateinamen überein.' });
        }

        let result;
        try {
            result = await backupStore.restoreBackup(filename, { dbPath });
        } catch (err) {
            if (err.dbClosed) {
                events.record({
                    event: 'backup_restore_failed', module: 'backup', severity: SEVERITY.CRITICAL,
                    message: 'Restore-Dateitausch nach Schliessen der DB fehlgeschlagen', error: err,
                });
                log.error(
                    'Restore-Dateitausch fehlgeschlagen, nachdem die DB bereits geschlossen wurde — ' +
                    'Prozess wird trotzdem beendet:', err.message
                );
                res.status(500).json({ error: 'Wiederherstellung fehlgeschlagen — Server startet trotzdem neu.' });
                return res.on('finish', () => setTimeout(() => exit(1), 250));
            }
            if (err.code === 'backup_in_progress') {
                return res.status(409).json({ error: err.message, code: err.code });
            }
            if (err.code) return res.status(400).json({ error: err.message, code: err.code });
            return next(err);
        }

        auditLog.log('backup_restored', { ip: req.ip, ...result });
        events.flush();
        await fsp.writeFile(
            path.join(dataDir, 'last-restore.json'),
            JSON.stringify({ ...result, ip: req.ip, ts: Date.now() }, null, 2)
        ).catch(() => {});

        res.json({ ok: true, message: 'Wiederhergestellt. Server startet neu …' });
        res.on('finish', () => setTimeout(() => exit(1), 250));
    });
}

module.exports = { registerBackupRoutes };
