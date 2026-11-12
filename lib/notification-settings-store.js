'use strict';

const { safeEmail } = require('./safe-name');

const MAX_NOTIFICATION_RECIPIENTS = 10;

function parseNotificationRecipients(value) {
    const result = [];
    for (const raw of String(value ?? '').split(/[;,\n]/)) {
        const email = safeEmail(raw.trim())?.toLowerCase();
        if (!raw.trim()) continue;
        if (!email) return { error: `„${raw.trim()}“ ist keine gültige E-Mail-Adresse.` };
        if (!result.includes(email)) result.push(email);
    }
    if (result.length > MAX_NOTIFICATION_RECIPIENTS) {
        return { error: `Höchstens ${MAX_NOTIFICATION_RECIPIENTS} Empfänger sind erlaubt.` };
    }
    return { recipients: result };
}

function createNotificationSettingsStore({ db, fallbackRecipients = [] }) {
    if (!db) throw new Error('notification settings store braucht eine db');

    const readStmt = db.prepare('SELECT * FROM admin_notification_settings WHERE id = 1');
    const writeStmt = db.prepare(`
        INSERT INTO admin_notification_settings
            (id, recipients, notify_new_ticket, notify_customer_reply, notify_sla_breach,
             notify_support_created, notify_support_updated, notify_support_password, notify_support_deleted)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            recipients = excluded.recipients,
            notify_new_ticket = excluded.notify_new_ticket,
            notify_customer_reply = excluded.notify_customer_reply,
            notify_sla_breach = excluded.notify_sla_breach,
            notify_support_created = excluded.notify_support_created,
            notify_support_updated = excluded.notify_support_updated,
            notify_support_password = excluded.notify_support_password,
            notify_support_deleted = excluded.notify_support_deleted
    `);

    function read() {
        const row = readStmt.get();
        if (!row) {
            const parsed = parseNotificationRecipients(Array.isArray(fallbackRecipients)
                ? fallbackRecipients.join(',') : fallbackRecipients);
            return {
                recipients: parsed.recipients ?? [], newTicket: true, customerReply: true, slaBreach: true,
                supportCreated: true, supportUpdated: true, supportPassword: true, supportDeleted: true,
                inherited: true,
            };
        }
        return {
            recipients: row.recipients ? row.recipients.split('\n').filter(Boolean) : [],
            newTicket: Boolean(row.notify_new_ticket),
            customerReply: Boolean(row.notify_customer_reply),
            slaBreach: Boolean(row.notify_sla_breach),
            supportCreated: Boolean(row.notify_support_created),
            supportUpdated: Boolean(row.notify_support_updated),
            supportPassword: Boolean(row.notify_support_password),
            supportDeleted: Boolean(row.notify_support_deleted),
            inherited: false,
        };
    }

    function update(input) {
        const parsed = parseNotificationRecipients(input?.recipients);
        if (parsed.error) return parsed;
        const settings = {
            recipients: parsed.recipients,
            newTicket: input?.newTicket === '1' || input?.newTicket === true,
            customerReply: input?.customerReply === '1' || input?.customerReply === true,
            slaBreach: input?.slaBreach === '1' || input?.slaBreach === true,
            supportCreated: input?.supportCreated === '1' || input?.supportCreated === true,
            supportUpdated: input?.supportUpdated === '1' || input?.supportUpdated === true,
            supportPassword: input?.supportPassword === '1' || input?.supportPassword === true,
            supportDeleted: input?.supportDeleted === '1' || input?.supportDeleted === true,
            inherited: false,
        };
        writeStmt.run(
            settings.recipients.join('\n'), Number(settings.newTicket), Number(settings.customerReply), Number(settings.slaBreach),
            Number(settings.supportCreated), Number(settings.supportUpdated), Number(settings.supportPassword),
            Number(settings.supportDeleted)
        );
        return { settings };
    }

    return { read, update };
}

module.exports = {
    createNotificationSettingsStore, MAX_NOTIFICATION_RECIPIENTS, parseNotificationRecipients,
};
