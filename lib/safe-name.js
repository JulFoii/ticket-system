'use strict';

/*
 * Zentrale Eingabepruefung: jede Route, die eine ID, einen Namen oder einen
 * Enum-Wert aus einer Anfrage nimmt, schickt ihn zuerst durch eine dieser
 * Funktionen — validiert wird, was ankommt, nicht was die App selbst
 * vergeben hat.
 */

/*
 * Base64url-Credential-ID, wie sie ein Authenticator liefert und wir sie
 * speichern. Kommt bei DELETE /webauthn/credentials/:id als Pfadsegment aus
 * der Anfrage zurueck — validiert wird deshalb, was ankommt.
 */
function safeCredentialId(input) {
    const raw = String(input ?? '');
    if (raw.length === 0 || raw.length > 512) return null;
    return /^[A-Za-z0-9_-]+$/.test(raw) ? raw : null;
}

/*
 * Selbstvergebener Anzeigename eines Passkeys ("Windows Hello", "YubiKey
 * Buero"). Freier Anzeigetext, aber ohne Kontrollzeichen.
 */
function safePasskeyLabel(input) {
    const raw = String(input ?? '').trim();
    if (raw.length === 0 || raw.length > 64) return null;
    return /^[\p{L}\p{N} .,'()_-]+$/u.test(raw) ? raw : null;
}

/*
 * Admin-Benutzername. Anders als safePasskeyLabel (freier Anzeigetext) ohne
 * Leerzeichen — ein Benutzername ist ein Identifier, kein Freitext.
 */
function safeUsername(input) {
    const raw = String(input ?? '').trim();
    if (raw.length === 0 || raw.length > 64) return null;
    return /^[\p{L}\p{N}_.@-]+$/u.test(raw) ? raw : null;
}

/*
 * Dateiname einer DB-Sicherung (lib/backup-store.js). Keine Allowlist fuer
 * Freitext, sondern ein festes, ausschliesslich serverseitig erzeugtes
 * Format (Zeitstempel) — kein Backup-Dateiname stammt je aus einer
 * Nutzereingabe. Schuetzt trotzdem den :filename-Pfadparameter auf den
 * Backup-Routen.
 */
function safeBackupName(input) {
    const raw = String(input ?? '');
    return /^(pre-restore-)?ticket-system-\d{8}T\d{6}Z-[0-9a-f]{6}\.db$/.test(raw) ? raw : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/*
 * Interne IDs (crypto.randomUUID()) von Tickets, Kundenkonten und
 * Ticket-Anhaengen — kommen als Pfadsegment bzw. Formularfeld aus der
 * Anfrage zurueck. Eigene Namen je Art, damit ein Aufrufer nicht
 * versehentlich die ID einer anderen Art durchwinkt, nur weil das Format
 * zufaellig identisch ist.
 */
function safeUuid(input) {
    const raw = String(input ?? '').toLowerCase();
    return UUID_PATTERN.test(raw) ? raw : null;
}

const safeTicketId = safeUuid;
const safeCustomerId = safeUuid;
const safeAttachmentId = safeUuid;

/*
 * Oeffentliche, fortlaufende Ticketnummer (#1001, #1002 …) aus der URL
 * (/account/tickets/:number, /admin/tickets/:number). Ein "#" davor wird
 * toleriert, damit eine aus einer Mail kopierte Nummer auch in der Suche
 * funktioniert.
 */
function safeTicketNumber(input) {
    const match = /^#?(\d{1,9})$/.exec(String(input ?? '').trim());
    if (!match) return null;
    const n = Number(match[1]);
    return n > 0 ? n : null;
}

/* Enum-Checks gegen die Listen in lib/ticket-store.js. */
function safeTicketStatus(input) {
    const raw = String(input ?? '');
    return ['new', 'open', 'pending', 'resolved', 'closed'].includes(raw) ? raw : null;
}

function safeTicketPriority(input) {
    const raw = String(input ?? '');
    return ['low', 'normal', 'high', 'urgent'].includes(raw) ? raw : null;
}

/*
 * Einmal-Token aus Bestaetigungs-/Reset-Mails (lib/customer-store.js:
 * TOKEN_PREFIX + 32 Zufallsbytes base64url = 43 Zeichen nach dem Praefix).
 */
function safeCustomerToken(input) {
    const raw = String(input ?? '');
    return /^ctk_[A-Za-z0-9_-]{43}$/.test(raw) ? raw : null;
}

/* Anzeigename eines Kundenkontos: 1–80 Zeichen ohne Steuerzeichen. */
function safeDisplayName(input) {
    // eslint-disable-next-line no-control-regex
    const raw = String(input ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return raw.length >= 1 && raw.length <= 80 ? raw : null;
}

/*
 * Keine vollstaendige RFC-5322-Validierung, aber bewusst nur eine *nackte*
 * Adresse: ohne Anzeigenamen, spitze Klammern, Kommas, Anfuehrungszeichen
 * oder Kommentare. Die Adresse geht als Empfaenger an nodemailer — der
 * parst "x<opfer@example.com>" oder "a@b.de,c@d.de" als Adressliste, eine
 * lockere Pruefung liesse also ein Konto unter einer Adresse anlegen, deren
 * Bestaetigungsmail an ein ganz anderes Postfach geht. Umlaute in Local-Part
 * und Domain (IDN) bleiben erlaubt; ob das Postfach wirklich existiert,
 * zeigt ohnehin erst der Mailversand (siehe lib/mail-outbox.js).
 */
const EMAIL_PATTERN = /^[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}\p{N}]{2,63}$/u;

function safeEmail(input) {
    const raw = String(input ?? '').trim();
    if (raw.length === 0 || raw.length > 254) return null;
    return EMAIL_PATTERN.test(raw) ? raw : null;
}

/* Slug eines Wissensdatenbank-Artikels (lib/kb-store.js slugify()). */
function safeKbSlug(input) {
    const raw = String(input ?? '');
    return raw.length <= 80 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw) ? raw : null;
}

module.exports = {
    safeKbSlug,
    safeCredentialId, safePasskeyLabel, safeUsername, safeBackupName,
    safeTicketId, safeCustomerId, safeAttachmentId, safeTicketNumber, safeTicketStatus,
    safeTicketPriority, safeCustomerToken, safeDisplayName, safeEmail,
};
