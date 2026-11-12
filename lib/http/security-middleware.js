'use strict';

function hostOf(value) {
    if (!value || value === 'null') return null;
    try {
        return new URL(value).host;
    } catch {
        return null;
    }
}

function createSupportUserLoader({ supportUserStore, ownerId }) {
    return function loadSupportUser(req, res, next) {
        req.supportUser = null;
        res.locals.currentSupportUser = null;
        res.locals.isSupportAdmin = false;
        if (req.session?.loggedIn) {
            const user = supportUserStore.get(req.session.supportUserId || ownerId);
            if (!user || user.disabled) {
                delete req.session.loggedIn;
                delete req.session.supportUserId;
            } else {
                req.supportUser = user;
                req.session.supportUserId = user.id;
                req.session.supportUserName = user.displayName;
                res.locals.currentSupportUser = user;
                res.locals.isSupportAdmin = user.role === 'admin';
            }
        }
        next();
    };
}

function createSameOriginGuard({ auditLog }) {
    return function sameOriginGuard(req, res, next) {
        if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();

        const sourceHost = hostOf(req.get('origin')) ?? hostOf(req.get('referer'));
        if (sourceHost === null) return next();
        if (sourceHost !== req.get('host')) {
            auditLog.log('csrf_rejected', { ip: req.ip, sourceHost, method: req.method });
            return res.status(403).send('Cross-Origin-Anfrage abgelehnt.');
        }
        next();
    };
}

function rpIdAndOrigin(req) {
    const host = req.get('host');
    return { rpID: host.split(':')[0], expectedOrigin: `${req.protocol}://${host}` };
}

module.exports = { createSameOriginGuard, createSupportUserLoader, hostOf, rpIdAndOrigin };
