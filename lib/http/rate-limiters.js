'use strict';

const expressRateLimit = require('express-rate-limit');
const { ipKeyGenerator } = expressRateLimit;

const LOGIN_MESSAGE = 'Zu viele Anmeldeversuche. Bitte später erneut versuchen.';
const ACCOUNT_MESSAGE = 'Zu viele Anfragen. Bitte später erneut versuchen.';

function createRateLimiters({ auditLog }) {
    function rateLimit({ name, auditEvent, ...options }) {
        const event = auditEvent || (options.keyGenerator ? 'rate_limit_global' : 'ip_blocked');
        return expressRateLimit({
            ...options,
            handler(req, res, _next, used) {
                const info = req.rateLimit;
                if (info && info.used === info.limit + 1) {
                    auditLog.log(event, {
                        ip: req.ip,
                        limiter: name,
                        limit: info.limit,
                        windowMs: used.windowMs,
                        resetAt: info.resetTime ? info.resetTime.getTime() : null,
                    });
                }
                res.status(used.statusCode).send(used.message);
            },
        });
    }

    function twoTier({ name, windowMs, perIp, global, skipSuccessfulRequests = false, message }) {
        const common = { windowMs, legacyHeaders: false, skipSuccessfulRequests, message };
        return {
            perIp: rateLimit({ ...common, name, max: perIp, standardHeaders: true }),
            global: rateLimit({
                ...common,
                name: `${name}_global`,
                max: global,
                standardHeaders: false,
                keyGenerator: () => 'global',
            }),
        };
    }

    const loginLimiterPerIp = rateLimit({
        name: 'login', windowMs: 15 * 60 * 1000, max: 10,
        standardHeaders: true, legacyHeaders: false,
        skipSuccessfulRequests: true, message: LOGIN_MESSAGE,
    });
    const loginLimiterGlobal = rateLimit({
        name: 'login_global', windowMs: 15 * 60 * 1000, max: 100,
        standardHeaders: false, legacyHeaders: false,
        skipSuccessfulRequests: true, keyGenerator: () => 'global', message: LOGIN_MESSAGE,
    });
    const pollLimiter = rateLimit({
        name: 'poll',
        auditEvent: 'ip_blocked',
        keyGenerator: req => (req.session && (req.session.loggedIn || req.session.customerId)
            ? `session:${req.sessionID}`
            : ipKeyGenerator(req.ip)),
        windowMs: 60 * 1000,
        max: 60,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Zu viele Anfragen. Bitte kurz warten.', code: 'rate_limited' },
    });
    const accountLimiters = twoTier({
        name: 'account', windowMs: 60 * 60 * 1000, perIp: 10, global: 200, message: ACCOUNT_MESSAGE,
    });
    const customerLoginLimiters = twoTier({
        name: 'customer_login', windowMs: 15 * 60 * 1000, perIp: 10, global: 100,
        skipSuccessfulRequests: true, message: LOGIN_MESSAGE,
    });
    const ticketWriteLimiters = twoTier({
        name: 'ticket_write', windowMs: 60 * 60 * 1000, perIp: 60, global: 5000,
        message: ACCOUNT_MESSAGE,
    });
    const ticketWritePerCustomer = rateLimit({
        name: 'ticket_write_customer', auditEvent: 'rate_limit_customer',
        windowMs: 60 * 60 * 1000, max: 30, legacyHeaders: false,
        standardHeaders: true, message: ACCOUNT_MESSAGE,
        keyGenerator: req => `customer:${req.session?.customerId ?? 'none'}`,
    });

    return {
        accountLimiters,
        customerLoginLimiters,
        loginLimiterGlobal,
        loginLimiterPerIp,
        pollLimiter,
        ticketWriteLimiters,
        ticketWritePerCustomer,
    };
}

module.exports = { createRateLimiters };
