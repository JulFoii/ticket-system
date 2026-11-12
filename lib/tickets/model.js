'use strict';

const STATUSES = ['new', 'open', 'pending', 'resolved', 'closed'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const ACTIVE_STATUSES = ['new', 'open', 'pending'];
const SOURCES = ['web', 'email', 'admin'];

const SOURCE_LABELS = { web: 'Portal', email: 'E-Mail', admin: 'Support' };

const STATUS_LABELS = {
    new: 'Neu',
    open: 'Offen',
    pending: 'Wartet auf Kunde',
    resolved: 'Gelöst',
    closed: 'Geschlossen',
};

// Aus Kundensicht heisst "pending" etwas anderes: der Ball liegt bei ihm.
const CUSTOMER_STATUS_LABELS = {
    new: 'Eingegangen',
    open: 'In Bearbeitung',
    pending: 'Wartet auf dich',
    resolved: 'Gelöst',
    closed: 'Geschlossen',
};

const PRIORITY_LABELS = { low: 'Niedrig', normal: 'Normal', high: 'Hoch', urgent: 'Dringend' };

const ACTOR_LABELS = { admin: 'Support', customer: 'Kunde', system: 'Automatik' };

/*
 * Statusereignisse stehen mit den Admin-Labels im Verlauf ("Status: Neu →
 * Gelöst (Support)"). Der Kunde kennt dieselben Status aber unter anderen
 * Namen (Badge, Stepper, Mails) — fuer seine Ansicht werden sie beim Rendern
 * uebersetzt. "Wartet auf Antwort" ist das fruehere Admin-Label fuer pending
 * und steht so noch in aelteren Verlaeufen.
 */
const ADMIN_TO_CUSTOMER_LABEL = new Map([
    ...Object.keys(STATUS_LABELS).map(key => [STATUS_LABELS[key], CUSTOMER_STATUS_LABELS[key]]),
    ['Wartet auf Antwort', CUSTOMER_STATUS_LABELS.pending],
]);
const CUSTOMER_ACTOR_LABELS = { Kunde: 'du', Support: 'Support', Automatik: 'automatisch' };

function customerEventText(body) {
    const match = /^Status: (.+?) → (.+?) \((.+)\)$/.exec(String(body ?? ''));
    if (!match) return body;
    const [, from, to, who] = match;
    const label = value => ADMIN_TO_CUSTOMER_LABEL.get(value) ?? value;
    return `Status: ${label(from)} → ${label(to)} (${CUSTOMER_ACTOR_LABELS[who] ?? who})`;
}

/*
 * Antwortfrist (SLA) als SQL-Ausdruck ueber einem Ticket `t`, ohne
 * Parameter — damit passt er in die festen ADMIN_VIEWS/SORTS-Fragmente.
 * Faellig ist immer die naechste Support-Antwort: bei 'new' die Erstantwort
 * ab created_at, bei 'open' die Folgeantwort ab der letzten
 * Kundennachricht. In 'pending'/'resolved'/'closed' ist der Kunde am Zug oder
 * das Ticket erledigt — keine Frist (die Uhr "ruht" also automatisch).
 * Minuten aus ticket_sla (lib/ticket-config-store.js), NULL/0 = keine Frist.
 * "Jetzt" in Epoch-ms ueber julianday(), weil unixepoch('subsec') erst ab
 * SQLite 3.42 existiert.
 */
const NOW_MS_SQL = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
const SLA_MINUTES_SQL = `(SELECT CASE WHEN t.status = 'new' THEN s.first_response_minutes
    WHEN t.status = 'open' THEN s.next_response_minutes END FROM ticket_sla s WHERE s.priority = t.priority)`;
const SLA_DUE_SQL = `(CASE WHEN ${SLA_MINUTES_SQL} > 0 THEN
    (CASE WHEN t.status = 'new' THEN t.created_at ELSE COALESCE(t.last_customer_activity_at, t.created_at) END)
    + 60000 * ${SLA_MINUTES_SQL} END)`;

/*
 * Wiedervorlage: snoozed_until in der Zukunft blendet ein Ticket aus den
 * Arbeitsansichten aus. Faellig wird es allein durch den Vergleich mit
 * "jetzt" — die Ansichten zeigen es ab dem Zeitpunkt sofort wieder, der
 * Automatik-Lauf (lib/ticket-automation.js) raeumt die Spalte danach nur noch
 * auf und markiert das Ticket als ungelesen. Die SLA-Frist laeuft waehrend
 * der Wiedervorlage bewusst weiter (sie ist ein Versprechen an den Kunden),
 * deshalb filtert `overdue` nicht danach.
 */
const SNOOZED_SQL = `(t.snoozed_until IS NOT NULL AND t.snoozed_until > ${NOW_MS_SQL})`;
const AWAKE_SQL = `(t.snoozed_until IS NULL OR t.snoozed_until <= ${NOW_MS_SQL})`;

/*
 * Gespeicherte Ansichten. Die Bedingungen sind feste SQL-Fragmente ohne
 * Nutzereingabe — der Name kommt aus der Anfrage, wird aber nur als
 * Schluessel in dieses Objekt benutzt.
 */
const ADMIN_VIEWS = {
    active: `t.status IN ('new', 'open', 'pending') AND ${AWAKE_SQL}`,
    new: `t.status = 'new' AND ${AWAKE_SQL}`,
    open: `t.status = 'open' AND ${AWAKE_SQL}`,
    pending: `t.status = 'pending' AND ${AWAKE_SQL}`,
    urgent: `t.priority IN ('high', 'urgent') AND t.status IN ('new', 'open', 'pending') AND ${AWAKE_SQL}`,
    unread: `t.admin_unread = 1 AND t.status != 'closed' AND ${AWAKE_SQL}`,
    snoozed: `t.status IN ('new', 'open', 'pending') AND ${SNOOZED_SQL}`,
    overdue: `${SLA_DUE_SQL} < ${NOW_MS_SQL}`,
    resolved: "t.status = 'resolved'",
    closed: "t.status = 'closed'",
    done: "t.status IN ('resolved', 'closed')",
    all: '1 = 1',
};

const CUSTOMER_VIEWS = {
    active: "t.status IN ('new', 'open', 'pending')",
    waiting: "t.status = 'pending'",
    done: "t.status IN ('resolved', 'closed')",
    all: '1 = 1',
};

const SORTS = {
    updated: 't.updated_at DESC',
    created: 't.created_at DESC',
    oldest: 't.created_at ASC',
    priority: "CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.updated_at DESC",
    number: 't.number DESC',
    // Faellige zuerst, Tickets ohne Frist ans Ende.
    due: `${SLA_DUE_SQL} IS NULL, ${SLA_DUE_SQL} ASC, t.updated_at DESC`,
    // Wiedervorlagen: was als Naechstes faellig wird, zuerst.
    snooze: 't.snoozed_until IS NULL, t.snoozed_until ASC, t.updated_at DESC',
    // Kundenliste: was auf den Kunden wartet, zuerst.
    attention: "CASE t.status WHEN 'pending' THEN 0 ELSE 1 END, t.updated_at DESC",
};
// Gleiche Zeitstempel (Sammelaktion, Import) kaemen sonst in beliebiger,
// von Abfrage zu Abfrage wechselnder Reihenfolge — beim Blaettern stuende
// ein Ticket dann doppelt oder gar nicht in der Liste.
for (const key of Object.keys(SORTS)) if (key !== 'number') SORTS[key] += ', t.number DESC';

function parseTags(json) {
    try {
        const parsed = JSON.parse(json || '[]');
        return Array.isArray(parsed) ? parsed.filter(tag => typeof tag === 'string') : [];
    } catch {
        return [];
    }
}

function rowToTicket(row) {
    return {
        id: row.id,
        number: row.number,
        customerId: row.customer_id,
        requesterEmail: row.requester_email,
        requesterName: row.requester_name,
        subject: row.subject,
        status: row.status,
        priority: row.priority,
        categoryId: row.category_id,
        categoryName: row.category_name ?? null,
        tags: parseTags(row.tags_json),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastCustomerActivityAt: row.last_customer_activity_at,
        lastAdminActivityAt: row.last_admin_activity_at,
        firstResponseAt: row.first_response_at,
        resolvedAt: row.resolved_at,
        closedAt: row.closed_at,
        customerUnread: row.customer_unread === 1,
        adminUnread: row.admin_unread === 1,
        reminderSentAt: row.reminder_sent_at,
        rating: row.rating,
        ratingComment: row.rating_comment,
        ratedAt: row.rated_at,
        source: row.source ?? 'web',
        mergedIntoId: row.merged_into_id ?? null,
        splitFromId: row.split_from_id ?? null,
        slaNotifiedAt: row.sla_notified_at ?? null,
        snoozedUntil: row.snoozed_until ?? null,
        slaDueAt: row.sla_due_at ?? null,
        slaMinutes: row.sla_minutes > 0 ? row.sla_minutes : null,
        messageCount: row.message_count ?? null,
        attachmentCount: row.attachment_count ?? null,
        lastMessage: row.last_message ?? null,
        lastMessageAuthor: row.last_message_author ?? null,
        assignedToUserId: row.assigned_to_user_id ?? null,
        assignedToName: row.assigned_to_name ?? null,
    };
}

function rowToMessage(row) {
    return {
        id: row.id,
        ticketId: row.ticket_id,
        author: row.author,
        kind: row.kind,
        internal: row.internal === 1,
        body: row.body,
        via: row.via,
        createdAt: row.created_at,
        supportUserId: row.support_user_id ?? null,
        supportUserName: row.support_user_name ?? null,
        attachments: [],
    };
}

function rowToAttachment(row) {
    return {
        id: row.id,
        ticketId: row.ticket_id,
        messageId: row.message_id,
        filename: row.filename,
        mime: row.mime,
        size: row.size,
        sha256: row.sha256,
        createdAt: row.created_at,
        isImage: /^image\//.test(row.mime),
    };
}


module.exports = {
    ACTIVE_STATUSES, ACTOR_LABELS, ADMIN_VIEWS, AWAKE_SQL, CUSTOMER_STATUS_LABELS, CUSTOMER_VIEWS,
    PRIORITIES, PRIORITY_LABELS, SORTS, SOURCES, SOURCE_LABELS, STATUSES,
    STATUS_LABELS, SLA_DUE_SQL, SLA_MINUTES_SQL,
    customerEventText, rowToAttachment, rowToMessage, rowToTicket,
};

