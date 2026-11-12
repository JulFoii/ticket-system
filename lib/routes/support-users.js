'use strict';

const { safeUsername, safeDisplayName } = require('../safe-name');

const MIN_PASSWORD_LENGTH = 8;

function registerSupportUserRoutes({ app, requireAdmin, supportUserStore, auditLog, supportSecurityMail, sessionStore }) {
    function notify(req, action, user, changes = []) {
        supportSecurityMail.notify({ action, actor: req.supportUser, user, changes });
    }

    function render(res, { status = 200, error = null, values = {}, done = false } = {}) {
        res.status(status).render('admin/users', {
            users: supportUserStore.list(), error, values, done,
        });
    }

    app.get('/admin/users', requireAdmin, (req, res) => render(res, { done: Boolean(req.query.done) }));

    app.post('/admin/users', requireAdmin, async (req, res, next) => {
        const username = safeUsername(req.body.username);
        const displayName = safeDisplayName(req.body.displayName);
        const role = ['admin', 'agent'].includes(req.body.role) ? req.body.role : null;
        const password = String(req.body.password ?? '');
        const values = { username: String(req.body.username ?? ''), displayName: String(req.body.displayName ?? ''), role };
        const error = !username ? 'Bitte einen gültigen Benutzernamen angeben.'
            : !displayName ? 'Bitte einen Anzeigenamen angeben.'
                : !role ? 'Bitte eine gültige Rolle wählen.'
                    : password.length < MIN_PASSWORD_LENGTH
                        ? `Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein.` : null;
        if (error) return render(res, { status: 400, error, values });
        try {
            const result = await supportUserStore.create({ username, displayName, role, password });
            if (result.error) return render(res, { status: 400, error: result.error, values });
            auditLog.log('support_user_created', { ip: req.ip, supportUser: result.user.id, role });
            notify(req, 'created', result.user, [`Rolle: ${role}`]);
            res.redirect(303, '/admin/users?done=created');
        } catch (err) { next(err); }
    });

    app.post('/admin/users/:id', requireAdmin, (req, res) => {
        const user = supportUserStore.get(req.params.id);
        if (!user || user.isOwner) return res.status(404).send('Support-Nutzer nicht gefunden.');
        const username = safeUsername(req.body.username);
        const displayName = safeDisplayName(req.body.displayName);
        const role = ['admin', 'agent'].includes(req.body.role) ? req.body.role : null;
        if (!username || !displayName || !role) return res.status(400).send('Ungültige Kontodaten.');
        const result = supportUserStore.update(user.id, {
            username, displayName, role, disabled: req.body.disabled === '1',
        });
        if (result.error) return res.status(400).send(result.error);
        auditLog.log('support_user_updated', { ip: req.ip, supportUser: user.id, role, disabled: result.user.disabled });
        const changes = [];
        if (user.username !== result.user.username) changes.push(`Benutzername: ${user.username} → ${result.user.username}`);
        if (user.displayName !== result.user.displayName) changes.push(`Anzeigename: ${user.displayName} → ${result.user.displayName}`);
        if (user.role !== result.user.role) changes.push(`Rolle: ${user.role} → ${result.user.role}`);
        if (user.disabled !== result.user.disabled) changes.push(result.user.disabled ? 'Konto gesperrt' : 'Konto entsperrt');
        if (changes.length) notify(req, 'updated', result.user, changes);
        res.redirect(303, '/admin/users?done=updated');
    });

    app.post('/admin/users/:id/password', requireAdmin, async (req, res, next) => {
        const user = supportUserStore.get(req.params.id);
        const password = String(req.body.password ?? '');
        if (!user || user.isOwner) return res.status(404).send('Support-Nutzer nicht gefunden.');
        if (password.length < MIN_PASSWORD_LENGTH) return res.status(400).send('Das Passwort ist zu kurz.');
        try {
            await supportUserStore.setPassword(user.id, password);
            sessionStore.destroyForSupportUser(user.id);
            auditLog.log('support_user_password_changed', { ip: req.ip, supportUser: user.id });
            notify(req, 'password_changed', user, ['Passwort zurückgesetzt']);
            res.redirect(303, '/admin/users?done=password');
        } catch (err) { next(err); }
    });

    app.post('/admin/users/:id/delete', requireAdmin, (req, res) => {
        const user = supportUserStore.get(req.params.id);
        if (!user || user.isOwner) return res.status(404).send('Support-Nutzer nicht gefunden.');
        supportUserStore.remove(user.id);
        auditLog.log('support_user_deleted', { ip: req.ip, supportUser: user.id, username: user.username });
        notify(req, 'deleted', user);
        res.redirect(303, '/admin/users?done=deleted');
    });
}

module.exports = { registerSupportUserRoutes };
