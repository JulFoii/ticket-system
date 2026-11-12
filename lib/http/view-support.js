'use strict';

const {
    formatMessage, relativeTime, formatDuration, initials, slaState,
} = require('../routes/helpers');
const {
    STATUS_LABELS, CUSTOMER_STATUS_LABELS, PRIORITY_LABELS, SOURCE_LABELS, customerEventText,
} = require('../ticket-store');

function formatSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / 1024 ** exponent;
    return `${value.toFixed(value < 10 && exponent > 0 ? 1 : 0)} ${units[exponent]}`;
}

function configureViewLocals({ app, clock }) {
    Object.assign(app.locals, {
        formatSize,
        formatDate: clock.formatDate,
        formatDateTime: clock.formatDateTime,
        formatTime: clock.formatTime,
        formatStamp: clock.formatStamp,
        zoneName: clock.zoneName,
        appTimeZone: clock.timeZone,
        relativeTime,
        formatDuration,
        formatMessage,
        initials,
        slaState,
        statusLabels: STATUS_LABELS,
        customerStatusLabels: CUSTOMER_STATUS_LABELS,
        priorityLabels: PRIORITY_LABELS,
        sourceLabels: SOURCE_LABELS,
        customerEventText,
    });
}

function createFragmentRenderer(app) {
    function renderPartial(view, locals) {
        return new Promise((resolve, reject) => {
            app.render(view, locals, (err, html) => {
                if (err) reject(err); else resolve(html);
            });
        });
    }

    function renderNavCount(res) {
        const { loggedIn, adminTicketBadge, currentCustomer, customerUnread } = res.locals;
        if (loggedIn) {
            return renderPartial('partials/nav-count', {
                count: adminTicketBadge ?? 0, title: 'Ungelesene Tickets',
            });
        }
        if (currentCustomer) {
            return renderPartial('partials/nav-count', {
                count: customerUnread ?? 0, title: 'Neue Antworten',
            });
        }
        return Promise.resolve('');
    }

    return { renderNavCount, renderPartial };
}

module.exports = { configureViewLocals, createFragmentRenderer, formatSize };
