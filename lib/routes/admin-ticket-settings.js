'use strict';

const { safeEmail } = require('../safe-name');
const { diff } = require('../event-store');
const { SETTINGS_LIMITS, SLA_MAX_HOURS } = require('../ticket-config-store');
const { MAX_NOTIFICATION_RECIPIENTS } = require('../notification-settings-store');
const { REPLY_TEMPLATE_LIMITS, buildReplyDraft } = require('../reply-template');
const { MAX_MESSAGE_LENGTH, textField } = require('./helpers');

function registerAdminTicketSettingsRoutes(ctx) {
    const {
        app, requireAdmin, configStore, notificationStore, attachmentStore, ticketMail, outbox, mailer,
        imapPoller, auditLog, notifyEmail, publicUrl, inboundEnabled, adminUsername, inboundNewTickets,
    } = ctx;

    async function renderSettings(req, res, {
        status = 200, error = null, success = null, replyTemplate = null, slaValues = null,
    } = {}) {
        let fallbackAgent;
        try {
            fallbackAgent = await adminUsername();
        } catch (err) {
            return req.next(err);
        }
        const template = replyTemplate ?? configStore.readReplyTemplate();
        const adminNotifications = notificationStore.read();
        const preview = buildReplyDraft({ ...template, name: 'Max Mustermann', agent: template.agentName || fallbackAgent });
        res.status(status).render('admin/ticket-settings', {
            replyTemplate: template,
            replyTemplateLimits: REPLY_TEMPLATE_LIMITS,
            replyTemplatePreview: preview.value.slice(0, preview.caret) + '…' + preview.value.slice(preview.caret),
            fallbackAgent,
            categories: configStore.listCategories(),
            canned: configStore.listCanned(),
            settings: configStore.readSettings(),
            limits: SETTINGS_LIMITS,
            sla: slaValues ?? configStore.readSla(),
            slaMaxHours: SLA_MAX_HOURS,
            inboundNewTickets,
            outboxCounts: outbox.counts(),
            outboxMails: outbox.list({ limit: 30 }),
            mailEnabled: outbox.enabled,
            mailFrom: mailer.from,
            mailSecurity: mailer.security,
            notifyEmail: adminNotifications.recipients[0] ?? notifyEmail,
            adminNotifications,
            maxNotificationRecipients: MAX_NOTIFICATION_RECIPIENTS,
            publicUrl,
            imap: { enabled: inboundEnabled, mailbox: imapPoller.mailbox, ...imapPoller.status },
            attachmentTotals: attachmentStore.totals(),
            error,
            success: success ?? ({
                automation: 'Automatik gespeichert.', category: 'Kategorien aktualisiert.', sla: 'Antwortfristen gespeichert.',
                canned: 'Textbausteine aktualisiert.', template: 'Anrede & Grußformel gespeichert.',
                notifications: 'Admin-Benachrichtigungen gespeichert.',
                test: 'Testmail wurde in die Warteschlange gelegt.',
                retry: 'Mail wird erneut versucht.', imap: 'Postfach wurde abgerufen.',
            }[req.query.saved] ?? null),
        });
    }

    app.get('/admin/ticket-settings', requireAdmin, (req, res) => renderSettings(req, res));

    app.post('/admin/ticket-settings/reply-template', requireAdmin, (req, res) => {
        const result = configStore.updateReplyTemplate(req.body);
        if (result.error) {
            return renderSettings(req, res, { status: 400, error: result.error, replyTemplate: {
                greeting: String(req.body.greeting ?? ''), signature: String(req.body.signature ?? ''),
                agentName: String(req.body.agentName ?? ''),
            } });
        }
        auditLog.log('ticket_reply_template_changed', { ip: req.ip });
        res.redirect(303, '/admin/ticket-settings?saved=template#reply-template');
    });

    app.post('/admin/ticket-settings/automation', requireAdmin, (req, res) => {
        const result = configStore.updateSettings(req.body);
        if (result.error) return renderSettings(req, res, { status: 400, error: result.error });
        auditLog.log('ticket_settings_changed', { ip: req.ip, ...result.settings });
        res.redirect(303, '/admin/ticket-settings?saved=automation#automation');
    });

    app.post('/admin/ticket-settings/notifications', requireAdmin, (req, res) => {
        const result = notificationStore.update(req.body);
        if (result.error) return renderSettings(req, res, { status: 400, error: result.error });
        auditLog.log('admin_notifications_changed', {
            ip: req.ip,
            recipientCount: result.settings.recipients.length,
            newTicket: result.settings.newTicket,
            customerReply: result.settings.customerReply,
            slaBreach: result.settings.slaBreach,
            supportCreated: result.settings.supportCreated,
            supportUpdated: result.settings.supportUpdated,
            supportPassword: result.settings.supportPassword,
            supportDeleted: result.settings.supportDeleted,
        });
        res.redirect(303, '/admin/ticket-settings?saved=notifications#admin-notifications');
    });

    app.post('/admin/ticket-settings/sla', requireAdmin, (req, res) => {
        const before = configStore.readSla();
        const result = configStore.updateSla(req.body);
        if (result.error) return renderSettings(req, res, { status: 400, error: result.error });
        auditLog.log('ticket_sla_changed', { ip: req.ip, changes: diff(before, result.sla) });
        res.redirect(303, '/admin/ticket-settings?saved=sla#sla');
    });

    app.post('/admin/ticket-settings/categories', requireAdmin, (req, res) => {
        const name = textField(req.body.name, 60);
        if (!name) return renderSettings(req, res, { status: 400, error: 'Bitte einen Kategorienamen angeben.' });
        if (!configStore.addCategory(name)) {
            return renderSettings(req, res, { status: 400, error: 'Diese Kategorie gibt es schon.' });
        }
        res.redirect(303, '/admin/ticket-settings?saved=category#categories');
    });

    app.post('/admin/ticket-settings/categories/:id', requireAdmin, (req, res) => {
        if (req.body.delete === '1') {
            configStore.deleteCategory(req.params.id);
        } else {
            const name = textField(req.body.name, 60);
            if (!name || !configStore.renameCategory(req.params.id, name)) {
                return renderSettings(req, res, { status: 400, error: 'Kategorie konnte nicht umbenannt werden (leer oder doppelt).' });
            }
        }
        res.redirect(303, '/admin/ticket-settings?saved=category#categories');
    });

    app.post('/admin/ticket-settings/canned', requireAdmin, (req, res) => {
        const title = textField(req.body.title, 80);
        const body = textField(req.body.body, MAX_MESSAGE_LENGTH);
        if (!title || !body) return renderSettings(req, res, { status: 400, error: 'Textbaustein braucht Titel und Text.' });
        configStore.addCanned({ title, body });
        res.redirect(303, '/admin/ticket-settings?saved=canned#canned');
    });

    app.post('/admin/ticket-settings/canned/:id', requireAdmin, (req, res) => {
        if (req.body.delete === '1') {
            configStore.deleteCanned(req.params.id);
        } else {
            const title = textField(req.body.title, 80);
            const body = textField(req.body.body, MAX_MESSAGE_LENGTH);
            if (!title || !body) return renderSettings(req, res, { status: 400, error: 'Textbaustein braucht Titel und Text.' });
            configStore.updateCanned(req.params.id, { title, body });
        }
        res.redirect(303, '/admin/ticket-settings?saved=canned#canned');
    });

    app.post('/admin/mail/test', requireAdmin, (req, res) => {
        const to = safeEmail(req.body.to) ?? notificationStore.read().recipients[0] ?? notifyEmail;
        if (!outbox.enabled) return renderSettings(req, res, { status: 400, error: 'Mailversand ist nicht konfiguriert (SMTP_HOST fehlt).' });
        if (!to) return renderSettings(req, res, { status: 400, error: 'Bitte eine Empfängeradresse angeben.' });
        ticketMail.testMail(to);
        auditLog.log('mail_test', { ip: req.ip });
        res.redirect(303, '/admin/ticket-settings?saved=test#mail');
    });

    app.post('/admin/mail/outbox/:id/retry', requireAdmin, (req, res) => {
        outbox.retry(req.params.id);
        res.redirect(303, '/admin/ticket-settings?saved=retry#mail');
    });

    app.post('/admin/mail/imap/poll', requireAdmin, async (req, res, next) => {
        try {
            await imapPoller.pollOnce();
            res.redirect(303, '/admin/ticket-settings?saved=imap#mail');
        } catch (err) {
            next(err);
        }
    });
}

module.exports = { registerAdminTicketSettingsRoutes };
