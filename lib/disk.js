'use strict';

/*
 * Kleine Dateisystem-Helfer, die mehrere Module brauchen: freier Platz eines
 * Volumes (fuer die MIN_FREE_DISK_MB-Reserve der Ticket-Anhaenge und die
 * Betriebsmetriken) und das Aufraeumen liegengebliebener multer-
 * Zwischendateien nach einem Absturz, plus die Pruefsumme einer Datei
 * (DB-Sicherungen, lib/backup-store.js).
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const DEFAULT_TMP_TTL_MS = 24 * 60 * 60 * 1000;

/*
 * Freier Platz eines Verzeichnisses in Byte (fuer den Nutzer ohne Root-
 * Reserve, daher bavail statt bfree) plus die Geraete-ID, damit zwei
 * Verzeichnisse auf demselben Dateisystem nicht doppelt gezaehlt werden.
 * null, wenn statfs nicht verfuegbar ist — dann wird nicht geprueft statt
 * jeden Upload abzulehnen.
 */
async function defaultDiskInfo(dir) {
    try {
        const [fsStats, dirStats] = await Promise.all([fsp.statfs(dir), fsp.stat(dir)]);
        return { free: Number(fsStats.bavail) * Number(fsStats.bsize), device: dirStats.dev };
    } catch {
        return null;
    }
}

/*
 * multer schreibt zufaellig benannte Dateien ohne Endung nach tmp-uploads/
 * und verschiebt sie danach in den Anhang-Speicher. Nach einem Absturz mitten
 * im Upload bleiben sie liegen — nach Ablauf der TTL weg damit. Ein laufender
 * Upload schreibt staendig und hat eine frische mtime, der bleibt.
 */
async function sweepTmpDir(tmpDir, { ttlMs = DEFAULT_TMP_TTL_MS, now = Date.now() } = {}) {
    const entries = await fsp.readdir(tmpDir).catch(() => []);
    let removed = 0;
    for (const entry of entries) {
        const entryPath = path.join(tmpDir, entry);
        try {
            const stats = await fsp.stat(entryPath);
            if (stats.isFile() && now - stats.mtimeMs > ttlMs) {
                await fsp.rm(entryPath, { force: true });
                removed++;
            }
        } catch {
            // Zwischen readdir und stat verschwunden — nichts zu tun
        }
    }
    return removed;
}

/* SHA-256 einer Datei, gestreamt statt komplett eingelesen. */
async function sha256OfFile(filePath) {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 1 << 20 });
    for await (const chunk of stream) {
        hash.update(chunk);
    }
    return hash.digest('hex');
}

module.exports = { defaultDiskInfo, sweepTmpDir, sha256OfFile };
