'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { startTestApp } = require('./helpers/app');
const { createWebhookService } = require('../lib/webhook-service');

test('REST API: Bearer-Authentifizierung, Scopes und Ticket-Lebenszyklus', async t => {
    const app = await startTestApp({ startMailWorkers: false });
    t.after(() => app.close());
    const { secret } = app.services.apiTokenStore.create({ name: 'Test', role: 'admin', scopes: ['read', 'write', 'admin'] });
    const auth = { Authorization: `Bearer ${secret}` };

    const unauthorized = await fetch(app.url('/api/v1/tickets'));
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get('content-type'), /application\/problem\+json/);

    const customer = await app.services.customerStore.createCustomer({
        email: 'api@example.com', name: 'API Kunde', password: 'langes-test-passwort',
    });
    const created = await fetch(app.url('/api/v1/tickets'), {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId: customer.id, subject: 'API Ticket', message: 'Aus Integration', priority: 'high' }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(createdBody.ticket.subject, 'API Ticket');
    assert.equal(createdBody.ticket.priority, 'high');

    const reply = await fetch(app.url(`/api/v1/tickets/${createdBody.ticket.number}/replies`), {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Antwort über API', status: 'pending' }),
    });
    assert.equal(reply.status, 201);
    const detail = await (await fetch(app.url(`/api/v1/tickets/${createdBody.ticket.number}`), { headers: auth })).json();
    assert.equal(detail.ticket.status, 'pending');
    assert.ok(detail.messages.some(message => message.body === 'Antwort über API'));
});

test('Webhooks: HMAC-signierte persistente Auslieferung', async t => {
    const received = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => { received.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) }); res.writeHead(204).end(); });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });

    const app = await startTestApp({ startMailWorkers: false });
    t.after(() => app.close());
    const result = app.services.webhookService.create({ name: 'Test', url: `http://127.0.0.1:${server.address().port}/receiver`, events: ['probe'] });
    assert.ok(result.secret.startsWith('tswhsec_'));
    app.services.webhookService.emit('probe', { ok: true });
    await app.services.webhookService.deliverDue();
    assert.equal(received.length, 1);
    assert.equal(received[0].body.event, 'probe');
    assert.match(received[0].headers['x-ticket-signature-256'], /^sha256=[a-f0-9]{64}$/);
    assert.equal(app.services.webhookService.listDeliveries()[0].status, 'delivered');
});

test('REST API: Administrationsressourcen und Integrationsverwaltung', async t => {
    const app = await startTestApp({ startMailWorkers: false });
    t.after(() => app.close());
    const { secret } = app.services.apiTokenStore.create({ name: 'Admin', role: 'admin', scopes: ['read', 'write', 'admin'] });
    const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };
    const call = async (method, path, body) => {
        const response = await fetch(app.url(path), { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const text = await response.text();
        return { response, body: text ? JSON.parse(text) : null };
    };

    assert.equal((await call('GET', '/api/v1')).response.status, 200);
    const customer = await app.services.customerStore.createCustomer({ email: 'matrix@example.com', name: 'Matrix', password: 'langes-passwort' });
    assert.equal((await call('GET', '/api/v1/customers')).response.status, 200);
    assert.equal((await call('GET', `/api/v1/customers/${customer.id}`)).response.status, 200);
    assert.equal((await call('PATCH', `/api/v1/customers/${customer.id}`, { name: 'Matrix Neu', disabled: false })).response.status, 200);

    const article = await call('POST', '/api/v1/knowledge-base/articles', { title: 'API Hilfe', body: 'Inhalt', published: true });
    assert.equal(article.response.status, 201);
    assert.equal((await call('GET', '/api/v1/knowledge-base/articles')).response.status, 200);
    assert.equal((await call('GET', `/api/v1/knowledge-base/articles/${article.body.article.id}`)).response.status, 200);
    assert.equal((await call('PATCH', `/api/v1/knowledge-base/articles/${article.body.article.id}`, { title: 'API Hilfe 2', body: 'Neu', published: false })).response.status, 200);
    assert.equal((await call('DELETE', `/api/v1/knowledge-base/articles/${article.body.article.id}`)).response.status, 204);

    const category = await call('POST', '/api/v1/categories', { name: 'API Kategorie' });
    assert.equal(category.response.status, 201);
    assert.equal((await call('GET', '/api/v1/categories')).response.status, 200);
    assert.equal((await call('PATCH', `/api/v1/categories/${category.body.category.id}`, { name: 'API Kategorie 2' })).response.status, 200);
    assert.equal((await call('DELETE', `/api/v1/categories/${category.body.category.id}`)).response.status, 204);

    const canned = await call('POST', '/api/v1/canned-responses', { title: 'API Antwort', body: 'Text' });
    assert.equal(canned.response.status, 201);
    assert.equal((await call('GET', '/api/v1/canned-responses')).response.status, 200);
    assert.equal((await call('PATCH', `/api/v1/canned-responses/${canned.body.cannedResponse.id}`, { title: 'Neu', body: 'Text 2' })).response.status, 200);
    assert.equal((await call('DELETE', `/api/v1/canned-responses/${canned.body.cannedResponse.id}`)).response.status, 204);

    assert.equal((await call('GET', '/api/v1/settings')).response.status, 200);
    assert.equal((await call('PATCH', '/api/v1/settings/automation', { pendingReminderDays: 2, pendingAutoResolveDays: 5, autoCloseDays: 6 })).response.status, 200);
    assert.equal((await call('PATCH', '/api/v1/settings/sla', {
        low: { firstResponseHours: 72, nextResponseHours: 72 }, normal: { firstResponseHours: 24, nextResponseHours: 24 },
        high: { firstResponseHours: 8, nextResponseHours: 8 }, urgent: { firstResponseHours: 4, nextResponseHours: 4 },
    })).response.status, 200);
    assert.equal((await call('PATCH', '/api/v1/settings/reply-template', { greeting: 'Hallo {name},', signature: 'Gruß', agentName: 'API' })).response.status, 200);

    const user = await call('POST', '/api/v1/support-users', { username: 'apiagent', displayName: 'API Agent', role: 'agent', password: 'sehr-langes-passwort' });
    assert.equal(user.response.status, 201);
    assert.equal((await call('GET', '/api/v1/support-users')).response.status, 200);
    assert.equal((await call('PATCH', `/api/v1/support-users/${user.body.user.id}`, { username: 'apiagent2', displayName: 'API Agent 2', role: 'agent' })).response.status, 200);
    assert.equal((await call('DELETE', `/api/v1/support-users/${user.body.user.id}`)).response.status, 204);

    assert.equal((await call('GET', '/api/v1/reports')).response.status, 200);
    const eventList = await call('GET', '/api/v1/events');
    assert.equal(eventList.response.status, 200);
    assert.equal((await call('GET', `/api/v1/events/${eventList.body.events[0]?.id || 999999}`)).response.status, eventList.body.events.length ? 200 : 404);
    const backup = await call('POST', '/api/v1/backups');
    assert.equal(backup.response.status, 201);
    assert.equal((await call('GET', '/api/v1/backups')).response.status, 200);
    assert.equal((await call('DELETE', `/api/v1/backups/${backup.body.backup.file}`)).response.status, 204);

    const token = await call('POST', '/api/v1/api-tokens', { name: 'Zweites Token', role: 'agent', scopes: ['read'] });
    assert.equal(token.response.status, 201);
    assert.equal((await call('GET', '/api/v1/api-tokens')).response.status, 200);
    assert.equal((await call('PATCH', `/api/v1/api-tokens/${token.body.token.id}`, { name: 'Geändert', role: 'agent', scopes: ['read'], disabled: false })).response.status, 200);
    assert.equal((await call('DELETE', `/api/v1/api-tokens/${token.body.token.id}`)).response.status, 204);

    const hook = await call('POST', '/api/v1/webhooks', { name: 'Hook', url: 'https://example.invalid/hook', events: ['probe'] });
    assert.equal(hook.response.status, 201);
    assert.equal((await call('GET', '/api/v1/webhooks')).response.status, 200);
    assert.equal((await call('PATCH', `/api/v1/webhooks/${hook.body.webhook.id}`, { name: 'Hook 2', enabled: false })).response.status, 200);
    assert.equal((await call('GET', '/api/v1/webhook-deliveries')).response.status, 200);
    assert.equal((await call('POST', '/api/v1/webhook-deliveries/missing/retry')).response.status, 404);
    assert.equal((await call('DELETE', `/api/v1/webhooks/${hook.body.webhook.id}`)).response.status, 204);
});

test('API-Tokens und Webhooks lehnen ungültige Konfiguration sicher ab', async t => {
    const app = await startTestApp({ startMailWorkers: false });
    t.after(() => app.close());
    const tokens = app.services.apiTokenStore;
    assert.match(tokens.create({ name: '' }).error, /Name/);
    assert.match(tokens.create({ name: 'Alt', expiresAt: Date.now() - 1 }).error, /Zukunft/);
    assert.equal(tokens.authenticate('falsch'), null);
    assert.equal(tokens.update('fehlt', {}), null);
    assert.equal(tokens.remove('fehlt'), false);
    const limited = tokens.create({ name: 'Nur Lesen', role: 'agent', scopes: ['admin'] });
    assert.deepEqual(limited.token.scopes, ['read']);
    assert.equal(tokens.authenticate(limited.secret).id, limited.token.id);
    const normal = tokens.create({ name: 'Standard Agent' });
    assert.deepEqual(normal.token.scopes, ['read', 'write'], 'Agent-Default verliert den Schreib-Scope nicht');
    const disabled = tokens.update(normal.token.id, { disabled: true });
    const renamed = tokens.update(normal.token.id, { name: 'Umbenannt' });
    assert.equal(renamed.disabled, true, 'partielles Update aktiviert Token nicht wieder');
    assert.equal(renamed.role, 'agent');
    assert.match(tokens.update(normal.token.id, { role: 'ungueltig' }).error, /Rolle/);
    assert.match(tokens.update(normal.token.id, { expiresAt: Date.now() - 1 }).error, /Zukunft/);

    const noWrite = await fetch(app.url('/api/v1/tickets'), {
        method: 'POST', headers: { Authorization: `Bearer ${limited.secret}`, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(noWrite.status, 403);
    const noAdmin = await fetch(app.url('/api/v1/settings'), { headers: { Authorization: `Bearer ${limited.secret}` } });
    assert.equal(noAdmin.status, 403);

    const hooks = app.services.webhookService;
    assert.match(hooks.create({ name: '', url: 'https://example.org' }).error, /Name/);
    assert.match(hooks.create({ name: 'Ungültig', url: 'file:///tmp/x' }).error, /HTTP/);
    assert.equal(hooks.update('fehlt', {}), null);
    assert.equal(hooks.remove('fehlt'), false);
    assert.equal(hooks.retry('fehlt'), false);
    assert.equal(disabled.disabled, true);
});

test('API validiert atomar und gibt fachliche Fehler als Problem JSON zurück', async t => {
    const app = await startTestApp({ startMailWorkers: false });
    t.after(() => app.close());
    const { secret } = app.services.apiTokenStore.create({ name: 'Admin', role: 'admin', scopes: ['read', 'write', 'admin'] });
    const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };
    const customer = await app.services.customerStore.createCustomer({ email: 'atomic@example.com', name: 'Atomic', password: 'langes-passwort' });
    const created = app.services.ticketStore.createTicket({ customer, subject: 'Atomar', body: 'Text' }).ticket;
    const invalid = await fetch(app.url(`/api/v1/tickets/${created.number}`), {
        method: 'PATCH', headers, body: JSON.stringify({ status: 'resolved', priority: 'falsch' }),
    });
    assert.equal(invalid.status, 422);
    assert.equal(app.services.ticketStore.getTicket(created.id).status, 'new', 'keine Teiländerung vor Validierungsfehler');
    for (const body of [
        { tags: 'kein-array' }, { categoryId: 999999 }, { assignedToUserId: 'fehlt' }, { status: 'falsch' },
    ]) {
        const response = await fetch(app.url(`/api/v1/tickets/${created.number}`), {
            method: 'PATCH', headers, body: JSON.stringify(body),
        });
        assert.equal(response.status, 422);
    }
    const badTicket = await fetch(app.url('/api/v1/tickets'), {
        method: 'POST', headers, body: JSON.stringify({ customerId: customer.id, subject: 'X', message: 'Y', priority: 'falsch' }),
    });
    assert.equal(badTicket.status, 422);

    const badCustomer = await fetch(app.url('/api/v1/customers'), {
        method: 'POST', headers, body: JSON.stringify({ email: 'keine-mail', name: '', password: 'kurz' }),
    });
    assert.equal(badCustomer.status, 422);
    assert.match(badCustomer.headers.get('content-type'), /application\/problem\+json/);
    const duplicate = await fetch(app.url('/api/v1/customers'), {
        method: 'POST', headers, body: JSON.stringify({ email: customer.email, name: 'Doppelt', password: 'langes-passwort' }),
    });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).code, 'email_conflict');
    const second = await app.services.customerStore.createCustomer({ email: 'second@example.com', name: 'Unverändert', password: 'langes-passwort' });
    const conflictPatch = await fetch(app.url(`/api/v1/customers/${second.id}`), {
        method: 'PATCH', headers, body: JSON.stringify({ name: 'Darf nicht bleiben', email: customer.email }),
    });
    assert.equal(conflictPatch.status, 409);
    assert.equal(app.services.customerStore.getCustomer(second.id).name, 'Unverändert', 'Kundenänderung bleibt bei E-Mail-Konflikt atomar');
    assert.equal((await fetch(app.url('/api/v1/categories'), {
        method: 'POST', headers, body: JSON.stringify({ name: '' }),
    })).status, 422);
    assert.equal((await fetch(app.url('/api/v1/canned-responses'), {
        method: 'POST', headers, body: JSON.stringify({ title: '', body: '' }),
    })).status, 422);
    assert.equal((await fetch(app.url('/api/v1/settings/sla'), {
        method: 'PATCH', headers, body: JSON.stringify({ low: {} }),
    })).status, 422);
    assert.equal((await fetch(app.url('/api/v1/support-users'), {
        method: 'POST', headers, body: JSON.stringify({ username: 'mit leer', displayName: '', role: 'root', password: 'kurz' }),
    })).status, 422);
});

test('Webhook-Service nimmt nach Neustart unterbrochene Zustellungen wieder auf', async t => {
    const app = await startTestApp({ startMailWorkers: false });
    t.after(() => app.close());
    const hook = app.services.webhookService.create({ name: 'Crash', url: 'https://example.invalid/hook', events: ['probe'] });
    app.services.webhookService.emit('probe', {});
    const row = app.services.db.prepare('SELECT id FROM webhook_deliveries WHERE webhook_id = ?').get(hook.webhook.id);
    app.services.db.prepare("UPDATE webhook_deliveries SET status = 'delivering' WHERE id = ?").run(row.id);
    createWebhookService({ db: app.services.db, fetchImpl: async () => ({ ok: true, status: 204 }) });
    assert.equal(app.services.db.prepare('SELECT status FROM webhook_deliveries WHERE id = ?').get(row.id).status, 'pending');
});

test('API behandelt unbekannte Routen, kaputtes JSON und zusammengeführte Tickets kontrolliert', async t => {
    const app = await startTestApp({ startMailWorkers: false });
    t.after(() => app.close());
    const { secret } = app.services.apiTokenStore.create({ name: 'Admin', role: 'admin', scopes: ['read', 'write', 'admin'] });
    const auth = { Authorization: `Bearer ${secret}` };
    const missing = await fetch(app.url('/api/v1/gibt-es-nicht'), { headers: auth });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, 'api_route_not_found');

    const malformed = await fetch(app.url('/api/v1/tickets'), {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{kaputt',
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).code, 'invalid_json');
    const empty = await fetch(app.url('/api/v1/api-tokens'), { method: 'POST', headers: auth });
    assert.equal(empty.status, 422);

    const customer = await app.services.customerStore.createCustomer({ email: 'merge@example.com', name: 'Merge', password: 'langes-passwort' });
    const source = app.services.ticketStore.createTicket({ customer, subject: 'Quelle', body: 'Q' }).ticket;
    const target = app.services.ticketStore.createTicket({ customer, subject: 'Ziel', body: 'Z' }).ticket;
    assert.ok(!app.services.ticketStore.mergeTickets(source.id, target.id).error);
    const reply = await fetch(app.url(`/api/v1/tickets/${source.number}/replies`), {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Nicht mehr hier' }),
    });
    assert.equal(reply.status, 409);
    assert.equal((await reply.json()).code, 'merged_ticket');
});

test('Integrations-GUI nutzt PRG, zeigt Geheimnisse einmalig und löscht Tokens', async t => {
    const app = await startTestApp({ startMailWorkers: false });
    t.after(() => app.close());
    const { cookie } = await app.login();
    const form = body => ({
        method: 'POST', redirect: 'manual', headers: {
            Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', Origin: app.base,
        }, body: new URLSearchParams(body),
    });

    const created = await fetch(app.url('/admin/integrations/tokens'), form({ name: 'GUI Token', write: '1' }));
    assert.equal(created.status, 303);
    assert.equal(created.headers.get('location'), '/admin/integrations');
    assert.equal(app.services.apiTokenStore.list().length, 1);

    const page = await fetch(app.url('/admin/integrations'), { headers: { Cookie: cookie } });
    const html = await page.text();
    assert.match(html, /tsapi_[A-Za-z0-9_-]+/);
    assert.match(html, /API-Token wurde erstellt/);
    assert.equal((html.match(/confirm\.js/g) || []).length, 1, 'Bestätigungsskript nur einmal laden');

    const reload = await (await fetch(app.url('/admin/integrations'), { headers: { Cookie: cookie } })).text();
    assert.doesNotMatch(reload, /tsapi_[A-Za-z0-9_-]+/);
    assert.equal(app.services.apiTokenStore.list().length, 1, 'Reload erzeugt kein weiteres Token');

    const tokenId = app.services.apiTokenStore.list()[0].id;
    const removed = await fetch(app.url(`/admin/integrations/tokens/${tokenId}/delete`), form({}));
    assert.equal(removed.status, 303);
    assert.equal(app.services.apiTokenStore.list().length, 0);
    const afterDelete = await (await fetch(app.url('/admin/integrations'), { headers: { Cookie: cookie } })).text();
    assert.match(afterDelete, /API-Token wurde gelöscht/);
});
