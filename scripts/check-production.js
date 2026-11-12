'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { checkConfig } = require('../lib/config-check');

function readEnv(file) {
    const values = {};
    if (!fs.existsSync(file)) return values;
    for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match) continue;
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"'))
            || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        values[match[1]] = value;
    }
    return values;
}

function number(value, fallback) {
    if (value === undefined || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : NaN;
}

function count(db, table, where = '') {
    return db.prepare(`SELECT count(*) AS n FROM ${table}${where}`).get().n;
}

function integrity(db) {
    return db.prepare('PRAGMA integrity_check').all().every(row => Object.values(row)[0] === 'ok');
}

function main() {
    const envFile = path.resolve(process.argv[2] || '.env');
    const fileEnv = readEnv(envFile);
    const env = { ...fileEnv, ...process.env };
    const blockers = [];
    const warnings = [];
    const dataDir = path.resolve(env.DATA_DIR || 'data');
    const publicUrl = env.PUBLIC_URL || null;
    const smtpEnabled = Boolean(env.SMTP_HOST);
    const imapEnabled = Boolean(env.IMAP_HOST);

    if (!fs.existsSync(envFile)) blockers.push(`Konfigurationsdatei fehlt: ${envFile}`);
    if (env.NODE_ENV !== 'production') blockers.push('NODE_ENV muss production sein.');
    if (!env.DOMAIN || /localhost|127\.0\.0\.1|(^|\.)example\.(com|org|net)$/i.test(env.DOMAIN)) {
        blockers.push('DOMAIN fehlt oder ist noch eine lokale/Beispieldomain.');
    }
    if (env.DOMAIN && publicUrl) {
        try {
            if (new URL(publicUrl).hostname !== env.DOMAIN) {
                warnings.push('DOMAIN und Hostname von PUBLIC_URL unterscheiden sich.');
            }
        } catch {
            // Die allgemeine Konfigurationspruefung meldet die ungueltige URL.
        }
    }

    const checked = checkConfig({
        isProd: true,
        publicUrl,
        mailEnabled: smtpEnabled,
        inboundEnabled: imapEnabled,
        trustProxy: env.TRUST_PROXY,
        attachmentMaxMb: number(env.TICKET_ATTACHMENT_MAX_MB, 10),
        mailAttachmentMaxMb: number(env.MAIL_ATTACHMENT_MAX_MB, 10),
        imapAuthservId: env.IMAP_AUTHSERV_ID || null,
        metricsToken: env.METRICS_TOKEN || null,
    });
    blockers.push(...checked.errors);
    warnings.push(...checked.warnings);
    if (smtpEnabled && !env.SMTP_FROM) warnings.push('SMTP_FROM ist leer; Absenderdarstellung vor Go-live testen.');
    if (imapEnabled && !env.SUPPORT_REPLY_TO) warnings.push('SUPPORT_REPLY_TO ist leer; Reply-To-Verhalten vor Go-live testen.');

    const appDbFile = path.join(dataDir, 'ticket-system.db');
    const eventsDbFile = path.join(dataDir, 'events.db');
    if (!fs.existsSync(appDbFile)) {
        blockers.push(`Hauptdatenbank fehlt in ${dataDir}.`);
    } else {
        const db = new DatabaseSync(appDbFile, { readOnly: true });
        try {
            if (!integrity(db)) blockers.push('Integritätsprüfung der Hauptdatenbank ist fehlgeschlagen.');
            const activeOwner = count(db, 'support_users', ' WHERE disabled = 0 AND is_owner = 1');
            const ownerHasMfa = count(db, 'totp') > 0 || count(db, 'webauthn_credentials') > 0;
            if (activeOwner > 0 && !ownerHasMfa) {
                blockers.push('Das aktive Owner-Konto hat weder TOTP noch einen Passkey.');
            }
        } catch (error) {
            blockers.push(`Hauptdatenbank konnte nicht vollständig geprüft werden: ${error.message}`);
        } finally {
            db.close();
        }
    }
    if (!fs.existsSync(eventsDbFile)) {
        blockers.push(`Event-Datenbank fehlt in ${dataDir}.`);
    } else {
        const db = new DatabaseSync(eventsDbFile, { readOnly: true });
        try {
            if (!integrity(db)) blockers.push('Integritätsprüfung der Event-Datenbank ist fehlgeschlagen.');
        } finally {
            db.close();
        }
    }

    const backupDir = path.join(dataDir, 'backups');
    const backups = fs.existsSync(backupDir)
        ? fs.readdirSync(backupDir).filter(name => name.endsWith('.db'))
        : [];
    if (backups.length === 0) blockers.push('Es ist noch kein lokales Datenbank-Backup vorhanden.');

    console.log(`Produktionsprüfung: ${blockers.length} Blocker, ${warnings.length} Warnungen`);
    for (const message of blockers) console.log(`BLOCKER: ${message}`);
    for (const message of warnings) console.log(`WARNUNG: ${message}`);
    if (blockers.length > 0) process.exitCode = 1;
}

main();
