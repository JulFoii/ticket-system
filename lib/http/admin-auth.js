'use strict';

function createAdminAuthorization({ auditLog, idleTimeoutMs, sessionCookie }) {
    function checkAuth(req, res, next) {
        if (req.session && req.session.loggedIn && req.supportUser) {
            const now = Date.now();
            const lastActivity = req.session.lastActivity ?? now;
            if (now - lastActivity > idleTimeoutMs) {
                auditLog.log('session_idle_timeout', { ip: req.ip });
                return req.session.destroy(() => {
                    res.clearCookie(sessionCookie);
                    if (req.accepts(['html', 'json']) === 'json') {
                        return res.status(401).json({ error: 'Sitzung wegen Inaktivität abgelaufen.' });
                    }
                    res.redirect('/login?idle=1');
                });
            }
            if (req.get('X-Idle-Background') !== '1') req.session.lastActivity = now;
            return next();
        }
        if (req.accepts(['html', 'json']) === 'json') {
            return res.status(401).json({ error: 'Nicht angemeldet.' });
        }
        if (req.session && req.session.pendingTotp) return res.redirect('/login/totp');
        res.redirect('/login');
    }

    function requireAdmin(req, res, next) {
        checkAuth(req, res, () => {
            if (req.supportUser.role === 'admin') return next();
            res.status(403).send('Nur Administratoren dürfen diesen Bereich öffnen.');
        });
    }

    function requireOwner(req, res, next) {
        checkAuth(req, res, () => {
            if (req.supportUser.isOwner) return next();
            res.status(403).send('Diese Sicherheitseinstellung gehört zum Owner-Konto.');
        });
    }

    return { checkAuth, requireAdmin, requireOwner };
}

module.exports = { createAdminAuthorization };
