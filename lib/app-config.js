'use strict';

const path = require('path');
const { DEFAULT_TIME_ZONE } = require('./time');

const DEFAULT_ADMIN_USERNAME = 'admin';

function envNumber(name, fallback, env = process.env) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
}

/**
 * Resolves every startup option in one place. Keeping environment access out
 * of the composition root makes createApp() deterministic and documents the
 * complete injectable surface used by tests and embedded deployments.
 */
function resolveAppConfig(options = {}, { env = process.env, rootDir } = {}) {
    const option = (name, fallback) => options[name] === undefined ? fallback : options[name];
    const smtpSecure = option('smtpSecure', env.SMTP_SECURE !== 'false');
    const imapSecure = option('imapSecure', env.IMAP_SECURE !== 'false');
    const imapUser = option('imapUser', env.IMAP_USER);

    return {
        appName: option('appName', env.APP_NAME || 'Ticketsystem'),
        tmpDir: option('tmpDir', path.join(rootDir, 'tmp-uploads')),
        dataDir: option('dataDir', env.DATA_DIR || path.join(rootDir, 'data')),
        minFreeDiskMb: option('minFreeDiskMb', envNumber('MIN_FREE_DISK_MB', 1024, env)),
        diskInfo: options.diskInfo,
        retentionPolicy: option('retentionPolicy', {
            auditLogDays: envNumber('AUDIT_LOG_RETENTION_DAYS', 90, env),
            unverifiedAccountDays: envNumber('UNVERIFIED_ACCOUNT_RETENTION_DAYS', 30, env),
            closedTicketDays: envNumber('CLOSED_TICKET_RETENTION_DAYS', 0, env),
        }),
        metricsToken: option('metricsToken', env.METRICS_TOKEN || null),
        maintenanceIntervalMs: option('maintenanceIntervalMs', 60 * 60 * 1000),
        isProd: option('isProd', env.NODE_ENV === 'production'),
        trustProxy: option('trustProxy', env.TRUST_PROXY),
        smtpHost: option('smtpHost', env.SMTP_HOST),
        smtpSecure,
        smtpPort: option('smtpPort', Number(env.SMTP_PORT) || (smtpSecure ? 465 : 587)),
        smtpUser: option('smtpUser', env.SMTP_USER),
        smtpPass: option('smtpPass', env.SMTP_PASS),
        smtpFrom: option('smtpFrom', env.SMTP_FROM || option('smtpUser', env.SMTP_USER)),
        mailTransport: option('mailTransport', null),
        ticketNotifyEmail: option('ticketNotifyEmail', env.TICKET_NOTIFY_EMAIL),
        imapHost: option('imapHost', env.IMAP_HOST),
        imapSecure,
        imapPort: option('imapPort', Number(env.IMAP_PORT) || (imapSecure ? 993 : 143)),
        imapUser,
        imapPass: option('imapPass', env.IMAP_PASS),
        imapMailbox: option('imapMailbox', env.IMAP_MAILBOX || 'INBOX'),
        imapProcessedMailbox: option('imapProcessedMailbox', env.IMAP_PROCESSED_MAILBOX || ''),
        imapPollSeconds: option('imapPollSeconds', Number(env.IMAP_POLL_SECONDS) || 60),
        supportReplyTo: option('supportReplyTo', env.SUPPORT_REPLY_TO
            || (/@/.test(String(imapUser ?? '')) ? imapUser : null)),
        publicUrl: option('publicUrl', env.PUBLIC_URL),
        attachmentMaxMb: option('attachmentMaxMb', Number(env.TICKET_ATTACHMENT_MAX_MB) || 10),
        mailAttachmentMaxMb: option('mailAttachmentMaxMb',
            envNumber('MAIL_ATTACHMENT_MAX_MB', 10, env)),
        imapAuthservId: option('imapAuthservId', env.IMAP_AUTHSERV_ID || null),
        ticketAutomationIntervalMs: option('ticketAutomationIntervalMs', 10 * 60 * 1000),
        startMailWorkers: option('startMailWorkers', true),
        passwordOption: options.adminPassword,
        usernameOption: options.adminUsername,
        secretOption: options.sessionSecret,
        sweepTmpUploads: option('sweepTmpUploads', true),
        log: option('log', console),
        requestLog: option('requestLog', true),
        adminIdleTimeoutMs: option('adminIdleTimeoutMs', 10 * 60 * 1000),
        eventsFile: options.eventsFile,
        eventFlushIntervalMs: option('eventFlushIntervalMs', 250),
        timeZone: option('timeZone', env.APP_TIMEZONE || DEFAULT_TIME_ZONE),
    };
}

module.exports = { DEFAULT_ADMIN_USERNAME, envNumber, resolveAppConfig };
