'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { SqliteSessionStore } = require('./session-store');
const { createWebauthnStore } = require('./webauthn-store');
const { createTotpStore } = require('./totp-store');
const { createBackupStore } = require('./backup-store');
const { createCustomerStore } = require('./customer-store');
const { createTicketStore } = require('./ticket-store');
const { createTicketConfigStore } = require('./ticket-config-store');
const { createNotificationSettingsStore } = require('./notification-settings-store');
const { createKbStore } = require('./kb-store');
const { createAttachmentStore } = require('./attachment-store');
const { createMailer } = require('./mailer');
const { createMailOutbox } = require('./mail-outbox');
const { createTicketMail } = require('./ticket-mail');
const { createSupportSecurityMail } = require('./support-security-mail');
const { createInboundMailStore } = require('./inbound-mail-store');
const { createInboundProcessor } = require('./mail-inbound');
const { createImapPoller } = require('./imap-poller');
const { createTicketAutomation } = require('./ticket-automation');
const { createRetention } = require('./retention');
const { createApiTokenStore } = require('./api-token-store');
const { createWebhookService } = require('./webhook-service');
const { childLog } = require('./logger');

function createAppServices({
    db, events, dataDir: DATA_DIR, tmpDir: TMP_DIR, publicUrl, ticketNotifyEmail,
    attachmentMaxMb, minFreeDiskMb, diskInfo, smtpHost, smtpPort, smtpSecure,
    smtpUser, smtpPass, smtpFrom, mailTransport, clock, appName, supportReplyTo,
    sessionSecret: SESSION_SECRET, inboundEnabled, mailAttachmentMaxMb,
    imapAuthservId, imapHost, imapPort, imapSecure, imapUser, imapPass,
    imapMailbox, imapPollSeconds, imapProcessedMailbox, retentionPolicy,
    createAuditLog, log,
}) {
const sessionStore = new SqliteSessionStore({ db });
const webauthnStore = createWebauthnStore({ db });
const totpStore = createTotpStore({ db });
const auditLog = createAuditLog({ events });
const apiTokenStore = createApiTokenStore({ db });
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const backupStore = createBackupStore({ db, backupDir: BACKUP_DIR, log: childLog(log, 'backup') });

/* ------------------------------------------------ Ticketsystem --
   Kundenkonten, Tickets, Anhaenge und Mail (Outbox + IMAP-Eingang),
   siehe die jeweiligen Module in lib/ und die Routen in lib/routes/. */
const PUBLIC_URL = String(publicUrl || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
const customerStore = createCustomerStore({ db });
const ticketStore = createTicketStore({ db });
const configStore = createTicketConfigStore({ db });
const notificationStore = createNotificationSettingsStore({ db, fallbackRecipients: ticketNotifyEmail || [] });
configStore.seedDefaults();
const kbStore = createKbStore({ db });
const attachmentStore = createAttachmentStore({
    db, dir: path.join(DATA_DIR, 'ticket-attachments'), maxBytes: attachmentMaxMb * 1024 * 1024,
    // Ein von Anhaengen volles Volume legte sonst auch SQLite lahm
    // (lib/attachment-store.js)
    minFreeBytes: minFreeDiskMb * 1024 * 1024, tmpDir: TMP_DIR,
    ...(diskInfo ? { diskInfo } : {}),
});
const mailLog = childLog(log, 'mail');
const mailer = createMailer({
    host: smtpHost, port: smtpPort, secure: smtpSecure, user: smtpUser, pass: smtpPass,
    from: smtpFrom, transport: mailTransport, log: mailLog,
});
/* Anhang-IDs aus der Outbox (lib/mail-outbox.js) in nodemailer-Anhaenge
   aufloesen — erst beim Versand, nie in der DB gespeichert. Fehlende
   (inzwischen geloeschte) Dateien werden ausgelassen. */
async function resolveMailAttachments(ids) {
    const result = [];
    for (const id of ids) {
        const attachment = attachmentStore.getAttachment(id);
        if (!attachment) continue;
        const file = attachmentStore.filePath(attachment.id);
        try {
            await fsp.access(file);
        } catch {
            continue;
        }
        result.push({ filename: attachment.filename, path: file, contentType: attachment.mime });
    }
    return result;
}
// Abstand zwischen zwei Mails (siehe lib/mail-outbox.js) — nicht mit
// injiziertem Test-Transport, sonst warten die Tests nur.
const outbox = createMailOutbox({
    db, mailer, log: mailLog, auditLog, sendIntervalMs: mailTransport ? 0 : 2000, formatTime: clock.formatTimeShort,
    resolveAttachments: resolveMailAttachments,
});
const ticketMail = createTicketMail({
    outbox, customerStore, publicUrl: PUBLIC_URL, appName, notifyEmail: ticketNotifyEmail || null,
    notificationSettings: () => notificationStore.read(),
    replyTo: supportReplyTo, threadSecret: `mail-thread:${SESSION_SECRET}`, domain: mailer.domain,
    inboundEnabled, attachmentMaxBytes: mailAttachmentMaxMb * 1024 * 1024, formatDateTime: clock.formatDateTime,
});
const supportSecurityMail = createSupportSecurityMail({
    outbox, notificationStore, publicUrl: PUBLIC_URL, appName,
});
// Neue Tickets per Mail nur mit bekannter authserv-id (siehe oben)
const inboundNewTickets = inboundEnabled && Boolean(imapAuthservId);
const inboundStore = createInboundMailStore({ db });
const inboundProcessor = createInboundProcessor({
    ticketStore, customerStore, attachmentStore, ticketMail, auditLog, log: mailLog, inboundStore,
    authservId: inboundNewTickets ? imapAuthservId : null,
});
const imapPoller = createImapPoller({
    host: imapHost, port: imapPort, secure: imapSecure, user: imapUser, pass: imapPass,
    mailbox: imapMailbox, intervalMs: imapPollSeconds * 1000, processor: inboundProcessor,
    maxAttachmentBytes: attachmentStore.maxBytes, maxAttachmentFiles: attachmentStore.maxFiles,
    processedMailbox: imapProcessedMailbox, stateStore: inboundStore, log: mailLog,
});
const ticketAutomation = createTicketAutomation({
    ticketStore, configStore, ticketMail, auditLog, log: childLog(log, 'tickets'),
});
const webhookService = createWebhookService({ db, publicUrl: PUBLIC_URL, log: childLog(log, 'webhooks') });
auditLog.subscribe((event, detail) => webhookService.emit(event, detail));
const retention = createRetention({
    db, ticketStore, attachmentStore, customerStore, sessionStore, outbox, auditLog, log: childLog(log, 'jobs'),
    policy: retentionPolicy,
});


    return {
        apiTokenStore, attachmentStore, auditLog, backupStore, configStore, customerStore,
        imapPoller, inboundProcessor, inboundStore, kbStore, mailer, notificationStore, outbox,
        retention, sessionStore, supportSecurityMail, ticketAutomation, ticketMail, ticketStore,
        totpStore, webauthnStore, webhookService, publicUrl: PUBLIC_URL,
        backupDir: BACKUP_DIR, inboundNewTickets,
    };
}

module.exports = { createAppServices };

