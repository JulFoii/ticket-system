'use strict';

/* Sicherheitsbenachrichtigungen fuer Support-Konten. Bewusst getrennt von
 * ticket-mail.js: Dieses Modul kennt keine Tickets, Kunden oder Thread-IDs;
 * die Route kennt umgekehrt weder Mail-Templates noch die Outbox. */

const { compose } = require('./mail-templates');

const ACTION_SETTING = Object.freeze({
    created: 'supportCreated',
    updated: 'supportUpdated',
    password_changed: 'supportPassword',
    deleted: 'supportDeleted',
});

const ACTION_LABEL = Object.freeze({
    created: 'Support-Konto erstellt',
    updated: 'Support-Konto geändert',
    password_changed: 'Support-Passwort geändert',
    deleted: 'Support-Konto gelöscht',
});

function createSupportSecurityMail({ outbox, notificationStore, publicUrl, appName = 'Ticketsystem' }) {
    const base = String(publicUrl || '').replace(/\/+$/, '');

    function notify({ action, actor, user, changes = [] }) {
        const setting = ACTION_SETTING[action];
        if (!setting) throw new Error(`Unbekanntes Support-Sicherheitsereignis: ${action}`);
        const settings = notificationStore.read();
        if (!settings[setting]) return [];

        const heading = ACTION_LABEL[action];
        const actorLabel = actor?.displayName || actor?.username || 'Administrator';
        const userLabel = user?.displayName && user.displayName !== user.username
            ? `${user.displayName} (${user.username})` : user?.username || 'Unbekannt';
        const paragraphs = [
            `${actorLabel} hat eine sicherheitsrelevante Änderung am Support-Konto ${userLabel} vorgenommen.`,
        ];
        if (changes.length) paragraphs.push(`Änderungen: ${changes.join(', ')}.`);
        paragraphs.push('Falls diese Änderung nicht erwartet wurde, prüfe bitte umgehend das Support-Team und das Ereignisprotokoll.');
        const content = {
            appName,
            subject: `${appName}: ${heading} – ${user?.username || 'Support-Konto'}`,
            heading,
            preheader: `Sicherheitsänderung durch ${actorLabel}.`,
            paragraphs,
            button: { label: 'Support-Team prüfen', url: `${base}/admin/users` },
            footer: `${appName} · Sicherheitsbenachrichtigung`,
            footerLinks: [
                { label: 'Support-Team', url: `${base}/admin/users` },
                { label: 'Ereignisprotokoll', url: `${base}/admin/logs` },
            ],
        };
        const { text, html } = compose(content);
        return settings.recipients.map(to => outbox.enqueue({
            kind: 'admin_support_security', to, subject: content.subject, text, html,
        }));
    }

    return { notify };
}

module.exports = { createSupportSecurityMail, ACTION_SETTING };
