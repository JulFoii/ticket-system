'use strict';

const { safeEmail, safeCustomerToken, safeDisplayName } = require('../safe-name');
const { checkPasswordStrength } = require('./helpers');

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

function registerAccountSettingsRoutes(ctx, { notice }) {
    const {
        app, checkCustomer, customerStore, ticketStore, attachmentStore, ticketMail,
        outbox, sessionStore, auditLog, limiters, mailEnabled,
    } = ctx;

    function renderSettings(req, res, { status = 200, errors = {}, success = null } = {}) {
        res.status(status).render('account/settings', {
            customer: req.customer, errors, success, mailEnabled,
            pendingEmail: req.query.email === 'sent',
        });
    }

    app.get('/account/settings', checkCustomer, (req, res) => {
        const flash = {
            profile: 'Profil gespeichert.', password: 'Passwort geändert.', notifications: 'Benachrichtigungen gespeichert.',
            email: 'Neue E-Mail-Adresse bestätigt.',
        }[req.query.saved];
        renderSettings(req, res, { success: flash ?? null });
    });

    app.post('/account/settings/profile', checkCustomer, (req, res) => {
        const name = safeDisplayName(req.body.name);
        if (!name) return renderSettings(req, res, { status: 400, errors: { profile: 'Bitte gib einen Namen an (max. 80 Zeichen).' } });
        customerStore.setName(req.customer.id, name);
        ticketStore.syncRequester({ ...req.customer, name });
        res.redirect('/account/settings?saved=profile');
    });

    app.post('/account/settings/password', checkCustomer, limiters.customerLoginGlobal, limiters.customerLoginPerIp,
        async (req, res, next) => {
            try {
                if (!(await customerStore.verifyPassword(req.customer.id, req.body.currentPassword))) {
                    return renderSettings(req, res, { status: 401, errors: { password: 'Das aktuelle Passwort ist falsch.' } });
                }
                const weak = checkPasswordStrength(req.body.password, req.customer);
                const error = weak ?? (req.body.password !== req.body.passwordConfirm ? 'Die Passwörter stimmen nicht überein.' : null);
                if (error) return renderSettings(req, res, { status: 400, errors: { password: error } });
                await customerStore.setPassword(req.customer.id, req.body.password);
                sessionStore.destroyForCustomer(req.customer.id, req.sessionID);
                ticketMail.passwordChanged(req.customer);
                auditLog.log('customer_password_changed', { ip: req.ip, customerId: req.customer.id });
                res.redirect('/account/settings?saved=password');
            } catch (err) {
                next(err);
            }
        });

    app.post('/account/settings/email', checkCustomer, limiters.customerLoginGlobal, limiters.customerLoginPerIp,
        async (req, res, next) => {
            try {
                const email = safeEmail(req.body.email);
                if (!email) return renderSettings(req, res, { status: 400, errors: { email: 'Bitte gib eine gültige E-Mail-Adresse an.' } });
                if (!(await customerStore.verifyPassword(req.customer.id, req.body.currentPassword))) {
                    return renderSettings(req, res, { status: 401, errors: { email: 'Das Passwort ist falsch.' } });
                }
                if (email.toLowerCase() === req.customer.email) {
                    return renderSettings(req, res, { status: 400, errors: { email: 'Das ist bereits deine aktuelle Adresse.' } });
                }
                if (!customerStore.findByEmail(email)) {
                    const token = customerStore.issueToken(req.customer.id, 'email_change', {
                        ttlMs: VERIFY_TTL_MS, payload: email.toLowerCase(),
                    });
                    ticketMail.emailChange(req.customer, email, token);
                }
                auditLog.log('customer_email_change_requested', { ip: req.ip, customerId: req.customer.id });
                res.redirect('/account/settings?email=sent');
            } catch (err) {
                next(err);
            }
        });

    app.get('/account/confirm-email', (req, res) => {
        const token = safeCustomerToken(req.query.token);
        const result = token ? customerStore.consumeToken(token, 'email_change') : null;
        if (!result || !result.payload || !customerStore.setEmail(result.customer.id, result.payload)) {
            return notice(res, {
                status: 400, variant: 'danger', title: 'Link ungültig',
                text: 'Dieser Link ist ungültig oder abgelaufen. Möglicherweise wird die Adresse inzwischen von einem anderen Konto verwendet.',
                action: { href: '/account/settings', label: 'Zu den Einstellungen' },
            });
        }
        const updated = customerStore.getCustomer(result.customer.id);
        ticketStore.syncRequester(updated);
        auditLog.log('customer_email_changed', { customerId: updated.id });
        res.redirect(req.customer ? '/account/settings?saved=email' : '/account/login');
    });

    app.post('/account/settings/notifications', checkCustomer, (req, res) => {
        customerStore.setNotify(req.customer.id, {
            replies: req.body.replies === '1',
            status: req.body.status === '1',
            reminders: req.body.reminders === '1',
        });
        res.redirect('/account/settings?saved=notifications');
    });

    app.get('/account/export', checkCustomer, (req, res) => {
        const { customer } = req;
        const data = {
            exportedAt: new Date().toISOString(),
            account: {
                name: customer.name,
                email: customer.email,
                createdAt: new Date(customer.createdAt).toISOString(),
                emailVerifiedAt: customer.emailVerifiedAt ? new Date(customer.emailVerifiedAt).toISOString() : null,
                notifications: customer.notify,
            },
            tickets: ticketStore.exportForCustomer(customer.id),
        };
        auditLog.log('customer_export', { customerId: customer.id });
        res.attachment('support-export.json');
        res.type('application/json').send(JSON.stringify(data, null, 2));
    });

    app.post('/account/delete', checkCustomer, limiters.customerLoginGlobal, limiters.customerLoginPerIp,
        async (req, res, next) => {
            try {
                if (String(req.body.confirm ?? '').trim().toUpperCase() !== 'LÖSCHEN') {
                    return renderSettings(req, res, { status: 400, errors: { delete: 'Bitte tippe LÖSCHEN zur Bestätigung.' } });
                }
                if (!(await customerStore.verifyPassword(req.customer.id, req.body.currentPassword))) {
                    return renderSettings(req, res, { status: 401, errors: { delete: 'Das Passwort ist falsch.' } });
                }
                await deleteCustomerCompletely(req.customer);
                auditLog.log('customer_deleted', { ip: req.ip, customerId: req.customer.id, by: 'customer' });
                req.session.destroy(() => {
                    res.clearCookie('ts.sid');
                    notice(res, {
                        variant: 'success', title: 'Konto gelöscht',
                        text: 'Dein Konto und alle zugehörigen Tickets, Nachrichten und Anhänge wurden gelöscht.',
                        action: { href: '/', label: 'Zur Startseite' },
                    });
                });
            } catch (err) {
                next(err);
            }
        });

    async function deleteCustomerCompletely(customer) {
        const attachmentIds = ticketStore.deleteTicketsOfCustomer(customer.id);
        await attachmentStore.removeFiles(attachmentIds);
        customerStore.deleteCustomer(customer.id);
        sessionStore.destroyForCustomer(customer.id);
        outbox.forgetAddress(customer.email);
        ticketMail.accountDeleted(customer);
    }

    return { deleteCustomerCompletely };
}

module.exports = { registerAccountSettingsRoutes };
