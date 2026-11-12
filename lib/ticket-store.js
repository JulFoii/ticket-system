'use strict';

/*
 * Tickets mit Kundenkonten (Tabellen `tickets`, `ticket_messages`,
 * `ticket_attachments`, siehe lib/db.js). Ein Ticket gehoert genau einem
 * Kundenkonto (customer_id) — requester_email/-name sind eine Momentaufnahme
 * fuer Mails und fuer Tickets, deren Konto (noch) nicht existiert (Import aus
 * dem Gast-Ticket-Prototyp, siehe migratePrototypeTickets() in lib/db.js).
 *
 * Status-Automat (modernes Helpdesk-Modell):
 *
 *   new ──Admin-Antwort──> pending ──Kunden-Antwort──> open ──Admin-Antwort──> pending
 *                            │                                               │
 *                            └──── Admin/Kunde/Automatik: resolved ──────────┘
 *                                          │  Kunden-Antwort -> open (wiedereroeffnet)
 *                                          └── nach N Tagen automatisch -> closed
 *
 *   - new:      angelegt, noch keine Antwort vom Support
 *   - open:     Kunde hat geantwortet, Support ist am Zug
 *   - pending:  Support hat geantwortet, wartet auf den Kunden
 *   - resolved: geloest — der Kunde kann per Antwort wiedereroeffnen
 *   - closed:   endgueltig, keine Antworten mehr (server.js lehnt sie ab,
 *               bevor addReply() ueberhaupt aufgerufen wird)
 *
 * Nachrichten haben drei Arten (kind): 'reply' (oeffentliche Antwort), 'note'
 * (interne Notiz, nur Admin) und 'event' (System-Ereignis wie ein
 * Statuswechsel). internal=1 blendet eine Nachricht fuer den Kunden aus —
 * immer gesetzt fuer Notizen, fuer Ereignisse je nach Art (eine geaenderte
 * Prioritaet geht den Kunden nichts an, ein "geloest" schon).
 *
 * DatabaseSync ist synchron: createTicket() vergibt die fortlaufende Nummer
 * per MAX(number)+1 ohne Race, weil zwischen Lesen und Schreiben kein anderer
 * JS-Code laufen kann.
 */

const crypto = require('crypto');
const { transaction } = require('./db-tx');

const {
    ACTIVE_STATUSES, ACTOR_LABELS, ADMIN_VIEWS, AWAKE_SQL, CUSTOMER_STATUS_LABELS, CUSTOMER_VIEWS,
    PRIORITIES, PRIORITY_LABELS, SORTS, SOURCES, SOURCE_LABELS, STATUSES,
    STATUS_LABELS, SLA_DUE_SQL, SLA_MINUTES_SQL,
    customerEventText, rowToAttachment, rowToMessage, rowToTicket,
} = require('./tickets/model');
function createTicketStore({ db }) {
    if (!db) throw new Error('ticket store braucht eine db');

    const SELECT_TICKET = `
        SELECT t.*, c.name AS category_name, su.display_name AS assigned_to_name,
            ${SLA_DUE_SQL} AS sla_due_at, ${SLA_MINUTES_SQL} AS sla_minutes
        FROM tickets t LEFT JOIN ticket_categories c ON c.id = t.category_id
        LEFT JOIN support_users su ON su.id = t.assigned_to_user_id
    `;
    const getStmt = db.prepare(`${SELECT_TICKET} WHERE t.id = ?`);
    const getByNumberStmt = db.prepare(`${SELECT_TICKET} WHERE t.number = ?`);
    const nextNumberStmt = db.prepare('SELECT COALESCE(MAX(number), 1000) + 1 AS n FROM tickets');
    const insertTicketStmt = db.prepare(`
        INSERT INTO tickets (id, number, customer_id, requester_email, requester_name, subject, status,
                             priority, category_id, created_at, updated_at, last_customer_activity_at,
                             last_admin_activity_at, first_response_at, admin_unread, customer_unread,
                             source)
        VALUES (@id, @number, @customerId, @email, @name, @subject, @status, @priority, @categoryId,
                @now, @now, @customerActivity, @adminActivity, @adminActivity, @adminUnread, @customerUnread,
                @source)
    `);
    const insertMessageStmt = db.prepare(`
        INSERT INTO ticket_messages (ticket_id, author, kind, internal, body, via, created_at, support_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const getMessageStmt = db.prepare(`SELECT m.*, su.display_name AS support_user_name
        FROM ticket_messages m LEFT JOIN support_users su ON su.id = m.support_user_id WHERE m.id = ?`);
    const listMessagesStmt = db.prepare(
        `SELECT m.*, su.display_name AS support_user_name FROM ticket_messages m
         LEFT JOIN support_users su ON su.id = m.support_user_id
         WHERE m.ticket_id = ? ORDER BY m.created_at ASC, m.id ASC`
    );
    const listPublicMessagesStmt = db.prepare(
        `SELECT m.*, su.display_name AS support_user_name FROM ticket_messages m
         LEFT JOIN support_users su ON su.id = m.support_user_id
         WHERE m.ticket_id = ? AND m.internal = 0 ORDER BY m.created_at ASC, m.id ASC`
    );
    const listAttachmentsStmt = db.prepare(
        'SELECT * FROM ticket_attachments WHERE ticket_id = ? ORDER BY created_at ASC'
    );
    const attachmentIdsStmt = db.prepare('SELECT id FROM ticket_attachments WHERE ticket_id = ?');
    const deleteTicketStmt = db.prepare('DELETE FROM tickets WHERE id = ?');
    const touchStmt = db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?');
    const claimStmt = db.prepare(`
        UPDATE tickets SET customer_id = ?, requester_name = COALESCE(requester_name, ?)
        WHERE customer_id IS NULL AND requester_email = ?
    `);
    const idsForCustomerStmt = db.prepare('SELECT id FROM tickets WHERE customer_id = ?');
    const updateRequesterStmt = db.prepare(
        'UPDATE tickets SET requester_email = ?, requester_name = ? WHERE customer_id = ?'
    );

    function now() {
        return Date.now();
    }

    function getTicket(id) {
        const row = getStmt.get(String(id ?? ''));
        return row ? rowToTicket(row) : null;
    }

    function getByNumber(number) {
        const n = Number(number);
        if (!Number.isInteger(n) || n <= 0) return null;
        const row = getByNumberStmt.get(n);
        return row ? rowToTicket(row) : null;
    }

    /* Kundensicht: ein fremdes Ticket ist fuer den Aufrufer genauso "nicht
       vorhanden" wie ein nicht existierendes — kein Unterschied in der
       Antwort, also keine Enumeration fremder Ticketnummern. */
    function getForCustomer(number, customerId) {
        const ticket = getByNumber(number);
        return ticket && customerId && ticket.customerId === customerId ? ticket : null;
    }

    function insertMessage(ticketId, { author, kind, internal = false, body, via = 'web', at = now(), supportUserId = null }) {
        const { lastInsertRowid } = insertMessageStmt.run(
            ticketId, author, kind, internal ? 1 : 0, String(body), via, at, supportUserId
        );
        return rowToMessage(getMessageStmt.get(lastInsertRowid));
    }

    function update(ticketId, fields) {
        const keys = Object.keys(fields);
        if (keys.length === 0) return;
        // Spaltennamen kommen ausschliesslich aus diesem Modul, nie aus einer
        // Anfrage — die Werte laufen als Parameter.
        const sql = `UPDATE tickets SET ${keys.map(key => `${key} = @${key}`).join(', ')} WHERE id = @__id`;
        db.prepare(sql).run({ ...fields, __id: ticketId });
    }

    /*
     * Legt Ticket + erste Nachricht an, gibt beides zurueck.
     *
     * author 'customer' (Portal, E-Mail): Status 'new', der Support ist am
     * Zug. author 'admin' (der Support legt ein Ticket fuer einen Kunden an,
     * z. B. nach einem Anruf): die erste Nachricht ist schon die Antwort des
     * Supports — Status statusAfter (Default 'pending'), first_response_at
     * sofort gesetzt, ungelesen fuer den Kunden. source haelt den Kanal fest
     * ('web' | 'email' | 'admin') fuer Reporting und Anzeige.
     */
    function createTicket({
        customer, subject, body, priority = 'normal', categoryId = null, via = 'web',
        author = 'customer', source = null, statusAfter = null, supportUserId = null,
    }) {
        const id = crypto.randomUUID();
        const at = now();
        const byAdmin = author === 'admin';
        // "new" heisst "noch keine Antwort vom Support" — passt hier nie.
        const status = byAdmin
            ? (['pending', 'open', 'resolved'].includes(statusAfter) ? statusAfter : 'pending')
            : 'new';
        // transaction() statt BEGIN: lib/attachment-store.js commit() fasst
        // Ticket, Nachricht und Anhang-Zeilen in eine aeussere Transaktion.
        return transaction(db, () => {
            const number = nextNumberStmt.get().n;
            insertTicketStmt.run({
                id, number,
                customerId: customer.id,
                email: customer.email,
                name: customer.name,
                subject: String(subject),
                status,
                priority: PRIORITIES.includes(priority) ? priority : 'normal',
                categoryId: categoryId ?? null,
                now: at,
                customerActivity: byAdmin ? null : at,
                adminActivity: byAdmin ? at : null,
                adminUnread: byAdmin ? 0 : 1,
                customerUnread: byAdmin ? 1 : 0,
                source: SOURCES.includes(source) ? source : byAdmin ? 'admin' : via === 'email' ? 'email' : 'web',
            });
            if (status === 'resolved') update(id, { resolved_at: at });
            if (byAdmin && supportUserId) update(id, { assigned_to_user_id: supportUserId });
            const message = insertMessage(id, {
                author: byAdmin ? 'admin' : 'customer', kind: 'reply', body, via, at,
                supportUserId: byAdmin ? supportUserId : null,
            });
            return { ticket: getTicket(id), message };
        });
    }

    function statusEvent(ticketId, from, to, actor, at) {
        const who = ACTOR_LABELS[actor] ?? actor;
        insertMessage(ticketId, {
            author: actor === 'admin' ? 'admin' : actor === 'customer' ? 'customer' : 'system',
            kind: 'event',
            body: `Status: ${STATUS_LABELS[from]} → ${STATUS_LABELS[to]} (${who})`,
            at,
        });
    }

    function statusFields(from, to, at) {
        const fields = { status: to };
        if (to === 'resolved') fields.resolved_at = at;
        if (to === 'closed') fields.closed_at = at;
        if (ACTIVE_STATUSES.includes(to)) {
            fields.resolved_at = null;
            fields.closed_at = null;
        }
        if (to !== 'pending') fields.reminder_sent_at = null;
        // Erledigt: eine Wiedervorlage hat nichts mehr, woran sie erinnern
        // koennte (und eine Wiedereroeffnung soll sofort sichtbar sein).
        if (!ACTIVE_STATUSES.includes(to)) fields.snoozed_until = null;
        // Neuer Status = neue Frist: eine spaetere Ueberschreitung meldet
        // lib/ticket-automation.js wieder.
        if (to !== from) fields.sla_notified_at = null;
        return fields;
    }

    // Nur diese Wechsel bekommen ein sichtbares Ereignis im Verlauf — der
    // Alltagsfall new/open -> pending durch eine Antwort ist schon durch die
    // Antwort selbst sichtbar und waere nur Rauschen.
    function isNotableTransition(from, to) {
        if (from === to) return false;
        if (to === 'resolved' || to === 'closed') return true;
        return from === 'resolved' || from === 'closed';
    }

    /*
     * Oeffentliche Antwort. author 'customer' setzt den Status auf 'open'
     * (ausser ein noch unbeantwortetes 'new' — das bleibt 'new'), author
     * 'admin' auf statusAfter (Default 'pending'). Gibt {message, ticket,
     * previousStatus} zurueck.
     */
    function addReply(ticketId, { author, body, via = 'web', statusAfter = null, supportUserId = null }) {
        const ticket = getTicket(ticketId);
        // Zusammengefuehrt: siehe setStatus() — die Aufrufer pruefen das
        // vorher und antworten mit einer Meldung, das hier ist nur die Sperre.
        if (!ticket || ticket.mergedIntoId) return null;
        const at = now();
        return transaction(db, () => {
            const message = insertMessage(ticketId, { author, kind: 'reply', body, via, at, supportUserId });
            let next;
            const fields = { updated_at: at };
            if (author === 'customer') {
                next = ticket.status === 'new' ? 'new' : 'open';
                // Wer antwortet, hat den Verlauf gesehen — "neue Antwort"
                // fuer den Kunden ist damit erledigt. Eine Kundenantwort
                // hebt auch eine Wiedervorlage auf: neue Aktivitaet gehoert
                // in den Posteingang, nicht in die Ablage.
                Object.assign(fields, {
                    last_customer_activity_at: at, admin_unread: 1, customer_unread: 0, reminder_sent_at: null,
                    sla_notified_at: null, snoozed_until: null,
                });
            } else {
                next = STATUSES.includes(statusAfter) ? statusAfter : 'pending';
                // reminder_sent_at zurueck: mit jeder neuen Support-Antwort
                // beginnt die Wartezeit fuer Erinnerung und Auto-Loesen von
                // vorn — sonst wuerde ein Ticket, zu dem schon einmal
                // erinnert wurde, direkt nach der naechsten Antwort
                // automatisch geloest (lib/ticket-automation.js).
                Object.assign(fields, {
                    last_admin_activity_at: at, customer_unread: 1, admin_unread: 0,
                    first_response_at: ticket.firstResponseAt ?? at, reminder_sent_at: null,
                    sla_notified_at: null,
                });
            }
            Object.assign(fields, statusFields(ticket.status, next, at));
            update(ticketId, fields);
            if (isNotableTransition(ticket.status, next)) {
                statusEvent(ticketId, ticket.status, next, author, at + 1);
            }
            return { message, ticket: getTicket(ticketId), previousStatus: ticket.status };
        });
    }

    /* Interne Notiz — nie fuer den Kunden sichtbar, aendert keinen Status. */
    function addNote(ticketId, { body, supportUserId = null }) {
        if (!getTicket(ticketId)) return null;
        const at = now();
        return transaction(db, () => {
            const message = insertMessage(ticketId, {
                author: 'admin', kind: 'note', internal: true, body, at, supportUserId,
            });
            update(ticketId, { updated_at: at, admin_unread: 0 });
            return { message, ticket: getTicket(ticketId) };
        });
    }

    function setStatus(ticketId, status, { actor = 'admin' } = {}) {
        if (!STATUSES.includes(status)) return null;
        const ticket = getTicket(ticketId);
        if (!ticket) return null;
        // Zusammengefuehrt: Verlauf und Anhaenge liegen im Ziel, die Quelle
        // bleibt geschlossen — wieder geoeffnet waere sie ein leeres Ticket,
        // dessen URL trotzdem ins Ziel weiterleitet.
        if (ticket.mergedIntoId) return null;
        if (ticket.status === status) return { changed: false, from: status, to: status, ticket };
        const at = now();
        const fields = { updated_at: at, ...statusFields(ticket.status, status, at) };
        // Ein Statuswechsel durch Support/Automatik ist fuer den Kunden eine
        // Neuigkeit, einer durch ihn selbst nicht (und umgekehrt).
        if (actor === 'customer') fields.admin_unread = 1;
        else fields.customer_unread = 1;
        update(ticketId, fields);
        statusEvent(ticketId, ticket.status, status, actor, at);
        return { changed: true, from: ticket.status, to: status, ticket: getTicket(ticketId) };
    }

    function setPriority(ticketId, priority) {
        if (!PRIORITIES.includes(priority)) return false;
        const ticket = getTicket(ticketId);
        if (!ticket || ticket.priority === priority) return false;
        const at = now();
        update(ticketId, { priority, updated_at: at });
        insertMessage(ticketId, {
            author: 'admin', kind: 'event', internal: true, at,
            body: `Priorität: ${PRIORITY_LABELS[ticket.priority]} → ${PRIORITY_LABELS[priority]}`,
        });
        return true;
    }

    function setAssignee(ticketId, userId, { label = null, actorUserId = null } = {}) {
        const ticket = getTicket(ticketId);
        const next = userId || null;
        if (!ticket || ticket.assignedToUserId === next) return false;
        update(ticketId, { assigned_to_user_id: next, updated_at: now() });
        insertMessage(ticketId, {
            author: 'admin', kind: 'event', internal: true, supportUserId: actorUserId,
            body: next ? `Zugewiesen an ${label || 'Support'}` : 'Zuweisung aufgehoben',
        });
        return true;
    }

    function setCategory(ticketId, categoryId, categoryName) {
        const ticket = getTicket(ticketId);
        if (!ticket || (ticket.categoryId ?? null) === (categoryId ?? null)) return false;
        const at = now();
        update(ticketId, { category_id: categoryId ?? null, updated_at: at });
        insertMessage(ticketId, {
            author: 'admin', kind: 'event', internal: true, at,
            body: `Kategorie: ${ticket.categoryName ?? '—'} → ${categoryName ?? '—'}`,
        });
        return true;
    }

    function setTags(ticketId, tags) {
        const clean = [...new Set((tags || []).map(tag => String(tag).trim().toLowerCase()).filter(Boolean))]
            .slice(0, 20);
        const ticket = getTicket(ticketId);
        // Unveraendert (der Eigenschaften-Dialog schickt die Tags bei jedem
        // Speichern mit): kein updated_at-Sprung, der sonst Live-Updates,
        // "Neue Aktivitaet" und die Sortierung ausloesen wuerde.
        if (!ticket || JSON.stringify(ticket.tags) === JSON.stringify(clean)) return clean;
        const at = now();
        update(ticketId, { tags_json: JSON.stringify(clean), updated_at: at });
        insertMessage(ticketId, {
            author: 'admin', kind: 'event', internal: true, at,
            body: `Tags: ${ticket.tags.join(', ') || '—'} → ${clean.join(', ') || '—'}`,
        });
        return clean;
    }

    function markRead(ticketId, side) {
        if (side === 'customer') update(ticketId, { customer_unread: 0 });
        else if (side === 'admin') update(ticketId, { admin_unread: 0 });
    }

    /*
     * Wiedervorlage bis `until` (ms). Nur fuer aktive, nicht
     * zusammengefuehrte Tickets. `label` ist der fuer den Verlauf formatierte
     * Zeitpunkt (die Zeitzone kennt nur der Aufrufer, siehe lib/time.js),
     * `note` wird als interne Notiz angehaengt. Eine Support-Antwort hebt die
     * Wiedervorlage nicht auf ("antworten und Freitag nachsehen"), eine
     * Kundenantwort und das Loesen/Schliessen schon.
     */
    function snooze(ticketId, until, { label = null, note = '' } = {}) {
        const ticket = getTicket(ticketId);
        if (!ticket || ticket.mergedIntoId || !ACTIVE_STATUSES.includes(ticket.status)) return null;
        const value = Number(until);
        if (!Number.isFinite(value)) return null;
        const at = now();
        const text = String(note ?? '').trim();
        db.exec('BEGIN');
        try {
            update(ticketId, { snoozed_until: value, updated_at: at, admin_unread: 0 });
            insertMessage(ticketId, {
                author: 'admin', kind: 'event', internal: true, at,
                body: `Wiedervorlage bis ${label ?? new Date(value).toISOString()}`,
            });
            if (text) insertMessage(ticketId, { author: 'admin', kind: 'note', internal: true, body: text, at: at + 1 });
            db.exec('COMMIT');
        } catch (err) {
            db.exec('ROLLBACK');
            throw err;
        }
        return getTicket(ticketId);
    }

    /* Wiedervorlage aufheben — reason 'admin' (von Hand) oder 'due'
       (faellig, aus der Automatik: dann auch wieder als ungelesen). */
    function unsnooze(ticketId, { reason = 'admin' } = {}) {
        const ticket = getTicket(ticketId);
        if (!ticket || ticket.snoozedUntil === null) return false;
        const at = now();
        const fields = { snoozed_until: null, updated_at: at };
        if (reason === 'due') fields.admin_unread = 1;
        update(ticketId, fields);
        insertMessage(ticketId, {
            author: reason === 'due' ? 'system' : 'admin', kind: 'event', internal: true, at,
            body: reason === 'due' ? 'Wiedervorlage fällig' : 'Wiedervorlage aufgehoben',
        });
        return true;
    }

    function markReminderSent(ticketId) {
        update(ticketId, { reminder_sent_at: now() });
    }

    /* Zufriedenheitsbewertung nach dem Loesen — nur einmal, nur fuer
       geloeste/geschlossene Tickets. */
    function rate(ticketId, rating, comment) {
        const ticket = getTicket(ticketId);
        const value = Number(rating);
        if (!ticket || !['resolved', 'closed'].includes(ticket.status)) return false;
        if (ticket.rating != null || !Number.isInteger(value) || value < 1 || value > 5) return false;
        const at = now();
        update(ticketId, {
            rating: value, rating_comment: comment ? String(comment) : null, rated_at: at,
            updated_at: at, admin_unread: 1,
        });
        insertMessage(ticketId, {
            author: 'customer', kind: 'event', internal: true, at,
            body: `Bewertung: ${'★'.repeat(value)}${'☆'.repeat(5 - value)}${comment ? ` — „${comment}“` : ''}`,
        });
        return true;
    }

    function touch(ticketId) {
        touchStmt.run(now(), ticketId);
    }

    /* Nachrichten inkl. ihrer Anhaenge. includeInternal=false (Kundensicht)
       blendet Notizen, interne Ereignisse und deren Anhaenge aus. */
    function listMessages(ticketId, { includeInternal = true } = {}) {
        const rows = includeInternal ? listMessagesStmt.all(ticketId) : listPublicMessagesStmt.all(ticketId);
        const messages = rows.map(rowToMessage);
        const byId = new Map(messages.map(message => [message.id, message]));
        for (const row of listAttachmentsStmt.all(ticketId)) {
            const message = byId.get(row.message_id);
            if (message) message.attachments.push(rowToAttachment(row));
        }
        return messages;
    }

    function buildFilter({ view, q, customerId, categoryId, priority, assignedTo, includeInternal }) {
        const views = customerId ? CUSTOMER_VIEWS : ADMIN_VIEWS;
        const where = [views[view] ?? views.active];
        const params = {};
        if (customerId) {
            where.push('t.customer_id = @customerId');
            params.customerId = customerId;
        }
        if (categoryId) {
            where.push('t.category_id = @categoryId');
            params.categoryId = Number(categoryId);
        }
        if (priority && PRIORITIES.includes(priority)) {
            where.push('t.priority = @priority');
            params.priority = priority;
        }
        if (assignedTo === 'unassigned') {
            where.push('t.assigned_to_user_id IS NULL');
        } else if (assignedTo) {
            where.push('t.assigned_to_user_id = @assignedTo');
            params.assignedTo = assignedTo;
        }
        const query = String(q ?? '').trim();
        if (query) {
            const numberMatch = /^#?(\d{1,9})$/.exec(query);
            // % und _ escapen statt entfernen — sonst faende "server_01" nichts.
            params.like = `%${query.replace(/[%_\\]/g, '\\$&')}%`;
            params.number = numberMatch ? Number(numberMatch[1]) : -1;
            where.push(`(
                t.number = @number OR t.subject LIKE @like ESCAPE '\\' OR t.requester_email LIKE @like ESCAPE '\\'
                OR t.requester_name LIKE @like ESCAPE '\\' OR t.tags_json LIKE @like ESCAPE '\\'
                OR EXISTS (SELECT 1 FROM ticket_messages m WHERE m.ticket_id = t.id
                           AND m.kind != 'event' ${includeInternal ? '' : 'AND m.internal = 0'}
                           AND m.body LIKE @like ESCAPE '\\')
            )`);
        }
        return { where: where.join(' AND '), params };
    }

    /* Paginierte Liste fuer Admin-Posteingang und Kundenuebersicht. */
    function listTickets({
        view = 'active', q = '', customerId = null, categoryId = null, priority = null, assignedTo = null,
        sort = 'updated', page = 1, perPage = 25,
    } = {}) {
        const includeInternal = !customerId;
        const { where, params } = buildFilter({ view, q, customerId, categoryId, priority, assignedTo, includeInternal });
        const orderBy = SORTS[sort] ?? SORTS.updated;
        const limit = Math.min(Math.max(1, Number(perPage) || 25), 100);
        const total = db.prepare(`SELECT COUNT(*) AS n FROM tickets t WHERE ${where}`).get(params).n;
        const pages = Math.max(1, Math.ceil(total / limit));
        // Eine Seite hinter dem Ende (alter Link, eine Sammelaktion hat
        // Tickets aus der Ansicht genommen) zeigt die letzte statt einer leeren.
        const offset = (Math.min(Math.max(1, Math.floor(Number(page)) || 1), pages) - 1) * limit;
        const rows = db.prepare(`
            SELECT t.*, c.name AS category_name, su.display_name AS assigned_to_name,
                ${SLA_DUE_SQL} AS sla_due_at, ${SLA_MINUTES_SQL} AS sla_minutes,
                (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id AND m.kind = 'reply') AS message_count,
                (SELECT COUNT(*) FROM ticket_attachments a WHERE a.ticket_id = t.id) AS attachment_count,
                (SELECT m.body FROM ticket_messages m WHERE m.ticket_id = t.id AND m.kind != 'event'
                    ${includeInternal ? '' : 'AND m.internal = 0'} ORDER BY m.id DESC LIMIT 1) AS last_message,
                (SELECT m.author FROM ticket_messages m WHERE m.ticket_id = t.id AND m.kind != 'event'
                    ${includeInternal ? '' : 'AND m.internal = 0'} ORDER BY m.id DESC LIMIT 1) AS last_message_author
            FROM tickets t LEFT JOIN ticket_categories c ON c.id = t.category_id
            LEFT JOIN support_users su ON su.id = t.assigned_to_user_id
            WHERE ${where}
            ORDER BY ${orderBy}
            LIMIT ${limit} OFFSET ${offset}
        `).all(params);
        return {
            tickets: rows.map(rowToTicket),
            total,
            page: Math.floor(offset / limit) + 1,
            pages,
            perPage: limit,
        };
    }

    /* Zaehler je Ansicht fuer die Seitenleiste/Tabs — ein einziger Scan. */
    function countViews({ customerId = null } = {}) {
        const views = customerId ? CUSTOMER_VIEWS : ADMIN_VIEWS;
        const columns = Object.entries(views)
            .map(([name, condition]) => `SUM(CASE WHEN ${condition} THEN 1 ELSE 0 END) AS "${name}"`)
            .join(', ');
        const row = customerId
            ? db.prepare(`SELECT ${columns} FROM tickets t WHERE t.customer_id = ?`).get(customerId)
            : db.prepare(`SELECT ${columns} FROM tickets t`).get();
        const counts = {};
        for (const name of Object.keys(views)) counts[name] = row?.[name] ?? 0;
        return counts;
    }

    /* Juengste Aenderung ueber alle Tickets — fuer den "Neue Aktivitaet"-
       Hinweis im Admin-Posteingang. */
    function latestActivity() {
        return db.prepare('SELECT COALESCE(MAX(updated_at), 0) AS latest FROM tickets').get().latest;
    }

    function countUnreadForCustomer(customerId) {
        return db.prepare(
            "SELECT COUNT(*) AS n FROM tickets WHERE customer_id = ? AND customer_unread = 1 AND status != 'closed'"
        ).get(customerId).n;
    }

    /* Kennzahlen fuer das Admin-Dashboard. */
    function stats({ sinceMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
        const since = now() - sinceMs;
        const row = db.prepare(`
            SELECT
                AVG(CASE WHEN first_response_at IS NOT NULL AND created_at >= @since AND source != 'admin'
                    THEN first_response_at - created_at END) AS avg_first_response,
                AVG(CASE WHEN resolved_at IS NOT NULL AND created_at >= @since
                    THEN resolved_at - created_at END) AS avg_resolution,
                AVG(CASE WHEN rating IS NOT NULL THEN rating END) AS avg_rating,
                SUM(CASE WHEN rating IS NOT NULL THEN 1 ELSE 0 END) AS rated,
                SUM(CASE WHEN created_at >= @since THEN 1 ELSE 0 END) AS created_recent
            FROM tickets
        `).get({ since });
        return {
            views: countViews(),
            avgFirstResponseMs: row.avg_first_response,
            avgResolutionMs: row.avg_resolution,
            avgRating: row.avg_rating,
            ratedCount: row.rated ?? 0,
            createdRecent: row.created_recent ?? 0,
        };
    }

    /* Ordnet Tickets ohne Konto (Prototyp-Import) einem frisch bestaetigten
       Konto mit genau dieser Adresse zu. */
    function claimTicketsByEmail(customer) {
        return claimStmt.run(customer.id, customer.name, customer.email).changes;
    }

    function syncRequester(customer) {
        updateRequesterStmt.run(customer.email, customer.name, customer.id);
    }

    /* Loescht ein Ticket samt Nachrichten und Anhang-Zeilen (FK-Kaskade) —
       gibt die Anhang-IDs zurueck, damit der Aufrufer die Dateien entfernt. */
    function deleteTicket(ticketId) {
        const attachmentIds = attachmentIdsStmt.all(ticketId).map(row => row.id);
        const deleted = deleteTicketStmt.run(ticketId).changes > 0;
        return deleted ? attachmentIds : null;
    }

    function deleteTicketsOfCustomer(customerId) {
        const attachmentIds = [];
        for (const { id } of idsForCustomerStmt.all(customerId)) {
            attachmentIds.push(...(deleteTicket(id) ?? []));
        }
        return attachmentIds;
    }

    /* DSGVO-Export: alles, was der Kunde selbst sehen kann. */
    function exportForCustomer(customerId) {
        return idsForCustomerStmt.all(customerId).map(({ id }) => {
            const ticket = getTicket(id);
            return {
                number: ticket.number,
                subject: ticket.subject,
                status: ticket.status,
                priority: ticket.priority,
                category: ticket.categoryName,
                createdAt: new Date(ticket.createdAt).toISOString(),
                rating: ticket.rating,
                ratingComment: ticket.ratingComment,
                messages: listMessages(id, { includeInternal: false }).map(message => ({
                    author: message.author,
                    kind: message.kind,
                    body: message.kind === 'event' ? customerEventText(message.body) : message.body,
                    createdAt: new Date(message.createdAt).toISOString(),
                    attachments: message.attachments.map(a => ({ filename: a.filename, size: a.size, sha256: a.sha256 })),
                })),
            };
        });
    }

    /* ------------------------------------------------ Automatik-Abfragen */

    // Zurueckgestellte Tickets bekommen weder Erinnerung noch Auto-Loesen:
    // wer ein Ticket bewusst auf Wiedervorlage legt, wartet auf etwas und
    // will es nicht zwischendurch automatisch geloest sehen.
    function dueForReminder(cutoff) {
        return db.prepare(`
            ${SELECT_TICKET} WHERE t.status = 'pending' AND t.reminder_sent_at IS NULL
            AND COALESCE(t.last_admin_activity_at, t.updated_at) <= ? AND ${AWAKE_SQL}
        `).all(cutoff).map(rowToTicket);
    }

    function dueForAutoResolve(cutoff) {
        return db.prepare(`
            ${SELECT_TICKET} WHERE t.status = 'pending' AND t.reminder_sent_at IS NOT NULL
            AND t.reminder_sent_at <= ? AND ${AWAKE_SQL}
        `).all(cutoff).map(rowToTicket);
    }

    /* Wiedervorlagen, deren Zeitpunkt erreicht ist (noch nicht aufgeraeumt). */
    function dueForWake(nowMs = now()) {
        return db.prepare(`
            ${SELECT_TICKET} WHERE t.snoozed_until IS NOT NULL AND t.snoozed_until <= ?
        `).all(nowMs).map(rowToTicket);
    }

    function dueForAutoClose(cutoff) {
        return db.prepare(`
            ${SELECT_TICKET} WHERE t.status = 'resolved' AND t.resolved_at IS NOT NULL AND t.resolved_at <= ?
        `).all(cutoff).map(rowToTicket);
    }

    /* SLA: ueberfaellige Tickets, zu denen noch keine Meldung verschickt wurde. */
    function dueForSlaBreach(nowMs = now()) {
        return db.prepare(`
            ${SELECT_TICKET} WHERE t.sla_notified_at IS NULL AND ${SLA_DUE_SQL} < ?
        `).all(nowMs).map(rowToTicket);
    }

    function markSlaNotified(ticketId) {
        update(ticketId, { sla_notified_at: now() });
    }

    /* Wie viele Tickets hat ein Konto seit `since` ueber einen Kanal
       eroeffnet — Schleifenschutz fuer Tickets per E-Mail. */
    function countRecentBySource(customerId, source, since) {
        return db.prepare(
            'SELECT COUNT(*) AS n FROM tickets WHERE customer_id = ? AND source = ? AND created_at >= ?'
        ).get(customerId, source, since).n;
    }

    /*
     * Fuehrt das Ticket sourceId in targetId zusammen (z. B. zweimal dasselbe
     * Anliegen gemeldet). Nachrichten und Anhaenge wandern ins Ziel — der
     * Verlauf bleibt chronologisch, weil listMessages() nach created_at
     * sortiert. Die Quelle wird geschlossen und verweist per merged_into_id
     * aufs Ziel (Weiterleitung der alten URL, Mail-Antworten auf den alten
     * Thread, siehe lib/mail-inbound.js). Nur Tickets desselben Kontos.
     * Gibt { source, target } oder { error } zurueck.
     */
    function mergeTickets(sourceId, targetId) {
        const source = getTicket(sourceId);
        const target = getTicket(targetId);
        if (!source || !target) return { error: 'not_found' };
        if (source.id === target.id) return { error: 'same_ticket' };
        if (!source.customerId || source.customerId !== target.customerId) return { error: 'different_customer' };
        if (source.mergedIntoId) return { error: 'already_merged' };
        if (target.status === 'closed' || target.mergedIntoId) return { error: 'target_closed' };

        const at = now();
        const rank = priority => PRIORITIES.indexOf(priority);
        db.exec('BEGIN');
        try {
            db.prepare('UPDATE ticket_messages SET ticket_id = ? WHERE ticket_id = ?').run(target.id, source.id);
            db.prepare('UPDATE ticket_attachments SET ticket_id = ? WHERE ticket_id = ?').run(target.id, source.id);

            const fields = {
                tags_json: JSON.stringify([...new Set([...target.tags, ...source.tags])].slice(0, 20)),
                priority: rank(source.priority) > rank(target.priority) ? source.priority : target.priority,
                updated_at: at,
                customer_unread: 1,
                last_customer_activity_at:
                    Math.max(target.lastCustomerActivityAt ?? 0, source.lastCustomerActivityAt ?? 0) || null,
            };
            // Wartete in der Quelle noch eine Kundennachricht auf Antwort,
            // ist der Support auch im Ziel am Zug.
            if (['new', 'open'].includes(source.status) && !['new', 'open'].includes(target.status)) {
                Object.assign(fields, statusFields(target.status, 'open', at));
            }
            update(target.id, fields);
            insertMessage(target.id, {
                author: 'admin', kind: 'event', at,
                body: `Ticket #${source.number} („${source.subject}“) wurde hier zusammengeführt`,
            });

            update(source.id, {
                ...statusFields(source.status, 'closed', at),
                merged_into_id: target.id, updated_at: at, customer_unread: 0, admin_unread: 0,
            });
            insertMessage(source.id, {
                author: 'admin', kind: 'event', at,
                body: `Zusammengeführt in Ticket #${target.number}`,
            });
            db.exec('COMMIT');
        } catch (err) {
            db.exec('ROLLBACK');
            throw err;
        }
        return { source: getTicket(source.id), target: getTicket(target.id) };
    }

    /* Aktivitaets-Zeitstempel aus den (verbliebenen) Antworten neu setzen —
       nach dem Aufteilen koennen die alten Werte auf eine Nachricht zeigen,
       die jetzt im anderen Ticket steht (die SLA fuer 'open' rechnet ab
       last_customer_activity_at). */
    function recomputeActivity(ticketId) {
        const row = db.prepare(`
            SELECT MAX(CASE WHEN author = 'customer' THEN created_at END) AS last_customer,
                   MAX(CASE WHEN author = 'admin' THEN created_at END) AS last_admin,
                   MIN(CASE WHEN author = 'admin' THEN created_at END) AS first_admin
            FROM ticket_messages WHERE ticket_id = ? AND kind = 'reply'
        `).get(ticketId);
        update(ticketId, {
            last_customer_activity_at: row.last_customer ?? null,
            last_admin_activity_at: row.last_admin ?? null,
            first_response_at: row.first_admin ?? null,
        });
    }

    /*
     * Gegenstueck zu mergeTickets(): verschiebt ausgewaehlte Antworten/
     * Notizen (samt Anhaengen) in ein neues Ticket desselben Kunden, z. B.
     * wenn im Thread ein zweites Anliegen auftaucht. Ereignisse sind nicht
     * auswaehlbar, im Ursprung muss mindestens eine Antwort bleiben.
     * created_at und Status des neuen Tickets folgen aus den verschobenen
     * Nachrichten (das Anliegen kam ja schon damals), der Status des
     * Ursprungs bleibt unveraendert — den entscheidet der Admin. Beide
     * Verlaeufe bekommen ein oeffentliches Ereignis als Querverweis,
     * split_from_id verknuepft sie dauerhaft.
     * Gibt { source, target, moved } oder { error } zurueck.
     */
    function splitTicket(sourceId, { messageIds, subject, priority = null, categoryId = null }) {
        const source = getTicket(sourceId);
        if (!source) return { error: 'not_found' };
        if (source.status === 'closed' || source.mergedIntoId) return { error: 'closed' };
        if (!source.customerId) return { error: 'no_customer' };

        const wanted = new Set((messageIds || []).map(Number));
        const messages = listMessages(source.id);
        const moving = messages.filter(m => m.kind !== 'event' && wanted.has(m.id));
        if (moving.length === 0) return { error: 'no_messages' };
        // Nur Notizen ergaeben ein Ticket, in dem der Kunde nichts sieht —
        // samt Mail und oeffentlichem Querverweis auf einen internen Vorgang.
        if (!moving.some(m => m.kind === 'reply')) return { error: 'no_replies' };
        const movingIds = new Set(moving.map(m => m.id));
        if (!messages.some(m => m.kind === 'reply' && !movingIds.has(m.id))) return { error: 'all_messages' };

        const replies = moving.filter(m => m.kind === 'reply');
        const last = replies.at(-1);
        const status = last.author === 'admin' ? 'pending'
            : replies.some(m => m.author === 'admin') ? 'open' : 'new';
        const createdAt = moving[0].createdAt;
        const id = crypto.randomUUID();
        const at = now();
        const placeholders = moving.map(() => '?').join(', ');
        db.exec('BEGIN');
        try {
            const number = nextNumberStmt.get().n;
            insertTicketStmt.run({
                id, number,
                customerId: source.customerId,
                email: source.requesterEmail,
                name: source.requesterName,
                subject: String(subject),
                status,
                priority: PRIORITIES.includes(priority) ? priority : source.priority,
                categoryId: categoryId ?? null,
                now: createdAt,
                customerActivity: null,
                adminActivity: null,
                adminUnread: 0,
                customerUnread: 1,
                source: source.source,
            });
            const ids = [...movingIds];
            db.prepare(`UPDATE ticket_messages SET ticket_id = ? WHERE ticket_id = ? AND id IN (${placeholders})`)
                .run(id, source.id, ...ids);
            db.prepare(`UPDATE ticket_attachments SET ticket_id = ? WHERE ticket_id = ? AND message_id IN (${placeholders})`)
                .run(id, source.id, ...ids);
            update(id, {
                split_from_id: source.id, tags_json: JSON.stringify(source.tags), updated_at: at,
            });
            recomputeActivity(id);
            recomputeActivity(source.id);
            update(source.id, { updated_at: at, sla_notified_at: null });

            const count = moving.length === 1 ? '1 Nachricht' : `${moving.length} Nachrichten`;
            insertMessage(source.id, {
                author: 'admin', kind: 'event', at,
                body: `${count} in Ticket #${number} („${subject}“) verschoben`,
            });
            insertMessage(id, {
                author: 'admin', kind: 'event', at,
                body: `Aufgeteilt aus Ticket #${source.number} („${source.subject}“)`,
            });
            db.exec('COMMIT');
        } catch (err) {
            db.exec('ROLLBACK');
            throw err;
        }
        return { source: getTicket(source.id), target: getTicket(id), moved: moving.length };
    }

    /* Tickets, die aus diesem abgeteilt wurden (Seitenleiste "Zeitachse"). */
    function listSplitChildren(ticketId) {
        return db.prepare(`${SELECT_TICKET} WHERE t.split_from_id = ? ORDER BY t.number`)
            .all(ticketId).map(rowToTicket);
    }

    return {
        db, createTicket, getTicket, getByNumber, getForCustomer, addReply, addNote, setStatus,
        setPriority, setCategory, setTags, setAssignee, markRead, markReminderSent, rate, touch, listMessages,
        listTickets, countViews, latestActivity, countUnreadForCustomer, stats, claimTicketsByEmail, syncRequester,
        deleteTicket, deleteTicketsOfCustomer, exportForCustomer, dueForReminder, dueForAutoResolve,
        dueForAutoClose, dueForSlaBreach, markSlaNotified,
        countRecentBySource, mergeTickets, splitTicket, listSplitChildren,
        snooze, unsnooze, dueForWake,
    };
}

module.exports = {
    createTicketStore,
    STATUSES, PRIORITIES, ACTIVE_STATUSES, SOURCES, SOURCE_LABELS, STATUS_LABELS, CUSTOMER_STATUS_LABELS, PRIORITY_LABELS,
    ADMIN_VIEWS, CUSTOMER_VIEWS, SORTS, customerEventText,
};
