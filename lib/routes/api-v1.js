'use strict';

const { createTicketReports } = require('../ticket-reports');
const { STATUSES, PRIORITIES } = require('../ticket-store');
const { MAX_MESSAGE_LENGTH, MAX_SUBJECT_LENGTH, checkPasswordStrength, lineField, textField } = require('./helpers');
const { safeDisplayName, safeEmail, safeUsername } = require('../safe-name');
const { transaction } = require('../db-tx');

function problem(res, status, code, message, details) {
    return res.status(status).type('application/problem+json').json({
        type: `https://docs.ticket-system.local/problems/${code}`,
        title: message, status, code, ...(details ? { details } : {}),
    });
}

function registerApiV1(ctx) {
    const { app, apiTokenStore, webhookService, ticketStore, customerStore, configStore, kbStore,
        supportUserStore, attachmentStore, ticketMail, auditLog, events, backupStore, clock } = ctx;
    const reports = createTicketReports({ db: ticketStore.db, clock });
    const router = require('express').Router();

    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
        const token = match ? apiTokenStore.authenticate(match[1]) : null;
        if (!token) return problem(res, 401, 'invalid_token', 'Ein gültiges API-Token ist erforderlich.');
        req.apiToken = token;
        // Requests ohne JSON-Content-Type haben sonst gar keinen Body und
        // wuerden in einzelnen Handlern als 500 statt als Validierungsfehler enden.
        req.body ??= {};
        const booleanFields = ['disabled', 'verified', 'enabled', 'published'];
        if (booleanFields.some(key => req.body[key] !== undefined && typeof req.body[key] !== 'boolean')
            || (req.body.notifications && Object.values(req.body.notifications).some(value => typeof value !== 'boolean'))) {
            return problem(res, 422, 'invalid_boolean', 'Boolean-Felder müssen true oder false enthalten.');
        }
        res.set('X-API-Version', '1');
        next();
    });
    const scope = needed => (req, res, next) => req.apiToken.scopes.includes(needed) || req.apiToken.scopes.includes('admin')
        ? next() : problem(res, 403, 'insufficient_scope', `Scope „${needed}“ ist erforderlich.`);
    const admin = (req, res, next) => req.apiToken.role === 'admin' && req.apiToken.scopes.includes('admin')
        ? next() : problem(res, 403, 'admin_required', 'Ein Admin-Token mit Scope „admin“ ist erforderlich.');
    const write = scope('write');
    const changed = (event, data) => { auditLog.log(event, data); };
    const ticketByNumber = (req, res, next) => {
        req.ticket = ticketStore.getByNumber(req.params.number);
        if (!req.ticket) return problem(res, 404, 'ticket_not_found', 'Ticket nicht gefunden.');
        next();
    };
    const editableTicket = (req, res, next) => req.ticket.mergedIntoId
        ? problem(res, 409, 'merged_ticket', 'Zusammengeführte Tickets können nicht mehr verändert werden.')
        : next();

    router.get('/', (req, res) => res.json({ version: 'v1', resources: [
        'tickets', 'customers', 'knowledge-base/articles', 'categories', 'canned-responses', 'settings',
        'support-users', 'reports', 'events', 'backups', 'api-tokens', 'webhooks',
    ] }));

    router.get('/tickets', (req, res) => res.json(ticketStore.listTickets({
        view: req.query.view, q: req.query.q, customerId: req.query.customerId, categoryId: req.query.categoryId,
        priority: req.query.priority, assignedTo: req.query.assignedTo, sort: req.query.sort,
        page: req.query.page, perPage: req.query.perPage,
    })));
    router.post('/tickets', write, (req, res) => {
        const customer = customerStore.getCustomer(req.body.customerId);
        if (!customer) return problem(res, 422, 'invalid_customer', 'Der angegebene Kunde existiert nicht.');
        const subject = lineField(req.body.subject, MAX_SUBJECT_LENGTH);
        const body = textField(req.body.message, MAX_MESSAGE_LENGTH);
        if (!subject || subject !== String(req.body.subject ?? '').trim() || !body || body !== String(req.body.message ?? '').trim()) {
            return problem(res, 422, 'invalid_ticket', 'Betreff oder Nachricht ist ungültig oder zu lang.');
        }
        if (req.body.priority !== undefined && !PRIORITIES.includes(req.body.priority)) return problem(res, 422, 'invalid_priority', 'Ungültige Priorität.');
        if (req.body.status !== undefined && !['pending', 'open', 'resolved'].includes(req.body.status)) return problem(res, 422, 'invalid_status', 'Beim Anlegen sind nur pending, open oder resolved erlaubt.');
        const category = req.body.categoryId == null ? null : configStore.getCategory(req.body.categoryId);
        if (req.body.categoryId != null && !category) return problem(res, 422, 'invalid_category', 'Kategorie nicht gefunden.');
        const result = ticketStore.createTicket({ customer, subject, body,
            priority: req.body.priority ?? 'normal', categoryId: category?.id ?? null,
            author: 'admin', source: 'admin', via: 'web', statusAfter: req.body.status,
        });
        ticketMail.ticketOpenedBySupport?.(result.ticket, result.message, []);
        changed('api_ticket_created', { tokenId: req.apiToken.id, ticket: result.ticket.number });
        res.status(201).location(`/api/v1/tickets/${result.ticket.number}`).json({ ...result, messages: ticketStore.listMessages(result.ticket.id) });
    });
    router.get('/tickets/:number', ticketByNumber, (req, res) => res.json({ ticket: req.ticket, messages: ticketStore.listMessages(req.ticket.id),
        splitChildren: ticketStore.listSplitChildren(req.ticket.id) }));
    router.patch('/tickets/:number', write, ticketByNumber, editableTicket, (req, res) => {
        const before = req.ticket;
        if (req.body.status !== undefined && !STATUSES.includes(req.body.status)) return problem(res, 422, 'invalid_status', 'Ungültiger Ticketstatus.');
        if (req.body.priority !== undefined && !PRIORITIES.includes(req.body.priority)) return problem(res, 422, 'invalid_priority', 'Ungültige Priorität.');
        const category = req.body.categoryId === undefined || req.body.categoryId == null ? null : configStore.getCategory(req.body.categoryId);
        if (req.body.categoryId != null && !category) return problem(res, 422, 'invalid_category', 'Kategorie nicht gefunden.');
        const user = req.body.assignedToUserId ? supportUserStore.get(req.body.assignedToUserId) : null;
        if (req.body.assignedToUserId && !user) return problem(res, 422, 'invalid_assignee', 'Support-Nutzer nicht gefunden.');
        if (req.body.tags !== undefined && !Array.isArray(req.body.tags)) return problem(res, 422, 'invalid_tags', 'Tags müssen als Array gesendet werden.');
        if (req.body.status !== undefined) {
            const change = ticketStore.setStatus(before.id, req.body.status, { actor: 'admin' });
            if (change?.changed) ticketMail.statusChanged?.(change.ticket, change.from, change.to, 'admin');
        }
        if (req.body.priority !== undefined) {
            ticketStore.setPriority(before.id, req.body.priority);
        }
        if (req.body.categoryId !== undefined) {
            ticketStore.setCategory(before.id, category?.id ?? null, category?.name ?? null);
        }
        if (req.body.tags !== undefined) ticketStore.setTags(before.id, req.body.tags);
        if (req.body.assignedToUserId !== undefined) {
            ticketStore.setAssignee(before.id, user?.id ?? null, { label: user?.displayName });
        }
        changed('api_ticket_updated', { tokenId: req.apiToken.id, ticket: before.number });
        res.json({ ticket: ticketStore.getTicket(before.id) });
    });
    router.delete('/tickets/:number', admin, ticketByNumber, async (req, res, next) => {
        try {
            const ids = ticketStore.deleteTicket(req.ticket.id);
            await attachmentStore.removeFiles(ids ?? []);
            changed('api_ticket_deleted', { tokenId: req.apiToken.id, ticket: req.ticket.number });
            res.status(204).end();
        } catch (err) { next(err); }
    });
    router.post('/tickets/:number/replies', write, ticketByNumber, editableTicket, (req, res) => {
        const body = String(req.body.message ?? '').trim();
        if (!body || body.length > MAX_MESSAGE_LENGTH || req.ticket.status === 'closed') return problem(res, 422, 'invalid_reply', 'Antwort ist leer, zu lang oder das Ticket ist geschlossen.');
        if (req.body.status !== undefined && !STATUSES.includes(req.body.status)) return problem(res, 422, 'invalid_status', 'Ungültiger Ticketstatus.');
        const result = ticketStore.addReply(req.ticket.id, { author: 'admin', body, statusAfter: req.body.status });
        ticketMail.adminReplied?.(result.ticket, result.message, []);
        changed('api_ticket_replied', { tokenId: req.apiToken.id, ticket: req.ticket.number });
        res.status(201).json(result);
    });
    router.post('/tickets/:number/notes', write, ticketByNumber, editableTicket, (req, res) => {
        const body = String(req.body.message ?? '').trim();
        if (!body || body.length > MAX_MESSAGE_LENGTH) return problem(res, 422, 'invalid_note', 'Notiz ist leer oder zu lang.');
        const result = ticketStore.addNote(req.ticket.id, { body });
        changed('api_ticket_noted', { tokenId: req.apiToken.id, ticket: req.ticket.number });
        res.status(201).json(result);
    });
    router.post('/tickets/:number/snooze', write, ticketByNumber, (req, res) => {
        const until = Date.parse(req.body.until);
        if (!Number.isFinite(until) || until <= Date.now()) return problem(res, 422, 'invalid_snooze', '„until“ muss ein zukünftiger ISO-Zeitpunkt sein.');
        const ticket = ticketStore.snooze(req.ticket.id, until, { label: new Date(until).toISOString(), note: req.body.note });
        if (!ticket) return problem(res, 409, 'cannot_snooze', 'Ticket kann nicht auf Wiedervorlage gesetzt werden.');
        changed('api_ticket_snoozed', { tokenId: req.apiToken.id, ticket: req.ticket.number, until });
        res.json({ ticket });
    });
    router.delete('/tickets/:number/snooze', write, ticketByNumber, (req, res) => {
        if (!ticketStore.unsnooze(req.ticket.id)) return problem(res, 409, 'not_snoozed', 'Ticket ist nicht auf Wiedervorlage.');
        changed('api_ticket_unsnoozed', { tokenId: req.apiToken.id, ticket: req.ticket.number });
        res.json({ ticket: ticketStore.getTicket(req.ticket.id) });
    });
    router.post('/tickets/:number/merge', write, ticketByNumber, (req, res) => {
        const target = ticketStore.getByNumber(req.body.targetNumber);
        const result = target ? ticketStore.mergeTickets(req.ticket.id, target.id) : { error: 'not_found' };
        if (result.error) return problem(res, 409, `merge_${result.error}`, 'Tickets konnten nicht zusammengeführt werden.');
        changed('api_tickets_merged', { tokenId: req.apiToken.id, source: req.ticket.number, target: target.number });
        res.json(result);
    });
    router.post('/tickets/:number/split', write, ticketByNumber, (req, res) => {
        const result = ticketStore.splitTicket(req.ticket.id, req.body);
        if (result.error) return problem(res, 409, `split_${result.error}`, 'Ticket konnte nicht aufgeteilt werden.');
        changed('api_ticket_split', { tokenId: req.apiToken.id, source: req.ticket.number, target: result.target.number });
        res.status(201).json(result);
    });

    router.get('/customers', (req, res) => res.json(customerStore.listCustomers(req.query)));
    router.post('/customers', write, async (req, res, next) => {
        try {
            const email = safeEmail(req.body.email);
            const name = safeDisplayName(req.body.name);
            if (!email || !name) return problem(res, 422, 'invalid_customer', 'Name oder E-Mail-Adresse ist ungültig.');
            const weak = checkPasswordStrength(req.body.password, { email, name });
            if (weak) return problem(res, 422, 'invalid_password', weak);
            const customer = await customerStore.createCustomer({ email, name, password: req.body.password });
            if (req.body.verified) customerStore.markVerified(customer.id);
            changed('api_customer_created', { tokenId: req.apiToken.id, customerId: customer.id });
            res.status(201).json({ customer: customerStore.getCustomer(customer.id) });
        } catch (err) { next(err); }
    });
    router.get('/customers/:id', (req, res) => {
        const customer = customerStore.getCustomer(req.params.id);
        return customer ? res.json({ customer, tickets: ticketStore.listTickets({ customerId: customer.id, view: 'all', perPage: req.query.perPage, page: req.query.page }) })
            : problem(res, 404, 'customer_not_found', 'Kunde nicht gefunden.');
    });
    router.patch('/customers/:id', write, (req, res) => {
        const customer = customerStore.getCustomer(req.params.id);
        if (!customer) return problem(res, 404, 'customer_not_found', 'Kunde nicht gefunden.');
        const name = req.body.name === undefined ? null : safeDisplayName(req.body.name);
        const email = req.body.email === undefined ? null : safeEmail(req.body.email);
        if (req.body.name !== undefined && !name) return problem(res, 422, 'invalid_name', 'Name ist ungültig.');
        if (req.body.email !== undefined && !email) return problem(res, 422, 'invalid_email', 'E-Mail-Adresse ist ungültig.');
        const emailOwner = email ? customerStore.findByEmail(email) : null;
        if (emailOwner && emailOwner.id !== customer.id) return problem(res, 409, 'email_conflict', 'E-Mail-Adresse ist bereits vergeben.');
        transaction(ticketStore.db, () => {
            if (name) customerStore.setName(customer.id, name);
            if (email && !customerStore.setEmail(customer.id, email)) throw new Error('E-Mail-Adresse ist bereits vergeben.');
            if (name || email) ticketStore.syncRequester(customerStore.getCustomer(customer.id));
        });
        if (req.body.disabled !== undefined) customerStore.setDisabled(customer.id, Boolean(req.body.disabled));
        if (req.body.verified === true) customerStore.markVerified(customer.id);
        if (req.body.notifications) customerStore.setNotify(customer.id, req.body.notifications);
        changed('api_customer_updated', { tokenId: req.apiToken.id, customerId: customer.id });
        res.json({ customer: customerStore.getCustomer(customer.id) });
    });

    router.get('/knowledge-base/articles', (req, res) => res.json({ articles: kbStore.list({ q: req.query.q, categoryId: req.query.categoryId, publishedOnly: req.query.publishedOnly === 'true', limit: req.query.limit }) }));
    router.get('/knowledge-base/articles/:id', (req, res) => { const article = kbStore.get(req.params.id); return article ? res.json({ article }) : problem(res, 404, 'article_not_found', 'Artikel nicht gefunden.'); });
    router.post('/knowledge-base/articles', write, (req, res) => { const result = kbStore.create(req.body); if (result.error) return problem(res, 422, 'invalid_article', result.error); changed('api_kb_created', { tokenId: req.apiToken.id, articleId: result.article.id }); res.status(201).json(result); });
    router.patch('/knowledge-base/articles/:id', write, (req, res) => { const result = kbStore.update(req.params.id, req.body); if (result.error) return problem(res, 422, 'invalid_article', result.error); changed('api_kb_updated', { tokenId: req.apiToken.id, articleId: result.article.id }); res.json(result); });
    router.delete('/knowledge-base/articles/:id', admin, (req, res) => { if (!kbStore.remove(req.params.id)) return problem(res, 404, 'article_not_found', 'Artikel nicht gefunden.'); changed('api_kb_deleted', { tokenId: req.apiToken.id, articleId: req.params.id }); res.status(204).end(); });

    router.get('/categories', (req, res) => res.json({ categories: configStore.listCategories() }));
    router.post('/categories', admin, (req, res) => { const name = lineField(req.body.name, 80); if (!name) return problem(res, 422, 'invalid_category', 'Kategoriename ist erforderlich.'); const id = configStore.addCategory(name); return id ? res.status(201).json({ category: configStore.getCategory(id) }) : problem(res, 409, 'category_conflict', 'Kategorie ist bereits vorhanden.'); });
    router.patch('/categories/:id', admin, (req, res) => { const name = lineField(req.body.name, 80); if (!name) return problem(res, 422, 'invalid_category', 'Kategoriename ist erforderlich.'); return configStore.renameCategory(req.params.id, name) ? res.json({ category: configStore.getCategory(req.params.id) }) : problem(res, 409, 'category_conflict', 'Kategorie nicht gefunden oder Name vergeben.'); });
    router.delete('/categories/:id', admin, (req, res) => configStore.deleteCategory(req.params.id) ? res.status(204).end() : problem(res, 404, 'category_not_found', 'Kategorie nicht gefunden.'));
    router.get('/canned-responses', (req, res) => res.json({ cannedResponses: configStore.listCanned() }));
    router.post('/canned-responses', write, (req, res) => { const title = lineField(req.body.title, 120); const body = textField(req.body.body, MAX_MESSAGE_LENGTH); if (!title || !body) return problem(res, 422, 'invalid_canned', 'Titel und Text sind erforderlich.'); const id = configStore.addCanned({ title, body }); res.status(201).json({ cannedResponse: configStore.getCanned(id) }); });
    router.patch('/canned-responses/:id', write, (req, res) => { const title = lineField(req.body.title, 120); const body = textField(req.body.body, MAX_MESSAGE_LENGTH); if (!title || !body) return problem(res, 422, 'invalid_canned', 'Titel und Text sind erforderlich.'); return configStore.updateCanned(req.params.id, { title, body }) ? res.json({ cannedResponse: configStore.getCanned(req.params.id) }) : problem(res, 404, 'canned_not_found', 'Textbaustein nicht gefunden.'); });
    router.delete('/canned-responses/:id', write, (req, res) => configStore.deleteCanned(req.params.id) ? res.status(204).end() : problem(res, 404, 'canned_not_found', 'Textbaustein nicht gefunden.'));
    router.get('/settings', admin, (req, res) => res.json({ automation: configStore.readSettings(), sla: configStore.readSla(), replyTemplate: configStore.readReplyTemplate() }));
    router.patch('/settings/automation', admin, (req, res) => { const result = configStore.updateSettings(req.body); return result.error ? problem(res, 422, 'invalid_settings', result.error) : res.json(result); });
    router.patch('/settings/sla', admin, (req, res) => { const priorities = ['low', 'normal', 'high', 'urgent']; if (priorities.some(p => !req.body?.[p] || typeof req.body[p] !== 'object')) return problem(res, 422, 'invalid_sla', 'Für jede Priorität sind SLA-Werte erforderlich.'); const input = {}; for (const p of priorities) { input[`${p}_first`] = req.body[p].firstResponseHours; input[`${p}_next`] = req.body[p].nextResponseHours; } const result = configStore.updateSla(input); return result.error ? problem(res, 422, 'invalid_sla', result.error) : res.json(result); });
    router.patch('/settings/reply-template', admin, (req, res) => { const result = configStore.updateReplyTemplate(req.body); return result.error ? problem(res, 422, 'invalid_template', result.error) : res.json(result); });

    router.get('/support-users', admin, (req, res) => res.json({ users: supportUserStore.list() }));
    router.post('/support-users', admin, async (req, res, next) => { try { const username = safeUsername(req.body.username); const displayName = safeDisplayName(req.body.displayName); if (!username || !displayName || !['admin', 'agent'].includes(req.body.role)) return problem(res, 422, 'invalid_user', 'Benutzername, Anzeigename oder Rolle ist ungültig.'); const weak = checkPasswordStrength(req.body.password, { name: displayName }); if (weak) return problem(res, 422, 'invalid_password', weak); const result = await supportUserStore.create({ ...req.body, username, displayName }); return result.error ? problem(res, 409, 'invalid_user', result.error) : res.status(201).json(result); } catch (err) { next(err); } });
    router.patch('/support-users/:id', admin, (req, res) => { const existing = supportUserStore.get(req.params.id); if (!existing) return problem(res, 404, 'user_not_found', 'Support-Nutzer nicht gefunden.'); const username = safeUsername(req.body.username ?? existing.username); const displayName = safeDisplayName(req.body.displayName ?? existing.displayName); const role = req.body.role ?? existing.role; if (!username || !displayName || !['admin', 'agent'].includes(role)) return problem(res, 422, 'invalid_user', 'Benutzername, Anzeigename oder Rolle ist ungültig.'); const result = supportUserStore.update(req.params.id, { ...existing, ...req.body, username, displayName, role }); return result.error ? problem(res, 422, 'invalid_user', result.error) : res.json(result); });
    router.delete('/support-users/:id', admin, (req, res) => supportUserStore.remove(req.params.id) ? res.status(204).end() : problem(res, 409, 'user_not_deletable', 'Nutzer nicht gefunden oder Owner-Konto.'));

    router.get('/reports', (req, res) => { const to = Number(req.query.to) || Date.now(); const from = Number(req.query.from) || to - 30 * 86400e3; res.json({ report: reports.report({ from, to }) }); });
    router.get('/events', admin, (req, res) => res.json(events.list(req.query, { limit: req.query.limit })));
    router.get('/events/:id', admin, (req, res) => { const event = events.get(req.params.id); return event ? res.json({ event }) : problem(res, 404, 'event_not_found', 'Ereignis nicht gefunden.'); });
    router.get('/backups', admin, async (req, res, next) => { try { res.json({ backups: await backupStore.listBackups(), settings: backupStore.readSettings() }); } catch (err) { next(err); } });
    router.post('/backups', admin, async (req, res, next) => { try { res.status(201).json({ backup: await backupStore.createBackup('api') }); } catch (err) { next(err); } });
    router.delete('/backups/:file', admin, async (req, res, next) => { try { return await backupStore.deleteBackup(req.params.file) ? res.status(204).end() : problem(res, 404, 'backup_not_found', 'Backup nicht gefunden.'); } catch (err) { next(err); } });

    router.get('/api-tokens', admin, (req, res) => res.json({ tokens: apiTokenStore.list() }));
    router.post('/api-tokens', admin, (req, res) => { const result = apiTokenStore.create(req.body); return result.error ? problem(res, 422, 'invalid_token', result.error) : res.status(201).json(result); });
    router.patch('/api-tokens/:id', admin, (req, res) => { const token = apiTokenStore.update(req.params.id, req.body); return !token ? problem(res, 404, 'token_not_found', 'API-Token nicht gefunden.') : token.error ? problem(res, 422, 'invalid_token', token.error) : res.json({ token }); });
    router.delete('/api-tokens/:id', admin, (req, res) => req.apiToken.id === req.params.id ? problem(res, 409, 'self_delete', 'Das aktuell verwendete Token kann sich nicht selbst löschen.') : apiTokenStore.remove(req.params.id) ? res.status(204).end() : problem(res, 404, 'token_not_found', 'API-Token nicht gefunden.'));
    router.get('/webhooks', admin, (req, res) => res.json({ webhooks: webhookService.list() }));
    router.post('/webhooks', admin, (req, res) => { const result = webhookService.create(req.body); return result.error ? problem(res, 422, 'invalid_webhook', result.error) : res.status(201).json(result); });
    router.patch('/webhooks/:id', admin, (req, res) => { const result = webhookService.update(req.params.id, req.body); return !result ? problem(res, 404, 'webhook_not_found', 'Webhook nicht gefunden.') : result.error ? problem(res, 422, 'invalid_webhook', result.error) : res.json(result); });
    router.delete('/webhooks/:id', admin, (req, res) => webhookService.remove(req.params.id) ? res.status(204).end() : problem(res, 404, 'webhook_not_found', 'Webhook nicht gefunden.'));
    router.get('/webhook-deliveries', admin, (req, res) => res.json({ deliveries: webhookService.listDeliveries({ webhookId: req.query.webhookId, limit: req.query.limit }) }));
    router.post('/webhook-deliveries/:id/retry', admin, (req, res) => webhookService.retry(req.params.id) ? res.status(202).json({ queued: true }) : problem(res, 404, 'delivery_not_found', 'Auslieferung nicht gefunden.'));

    router.use((req, res) => problem(res, 404, 'api_route_not_found', 'API-Endpunkt nicht gefunden.'));

    app.use('/api/v1', router);
}

module.exports = { registerApiV1, problem };
