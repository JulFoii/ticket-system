'use strict';

// Isolierte Diagnose: ausschließlich temporäre Testdaten.
const { startTestApp } = require('../test/helpers/app');

(async () => {
    const a = await startTestApp();
    try {
        const { cookie } = await a.login();
        const post = (url, body, c = cookie) => fetch(a.url(url), {
            method: 'POST', redirect: 'manual',
            headers: { Cookie: c, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams(body),
        });
        const user = (await a.services.supportUserStore.create({ username: 'audit-agent', displayName: 'Audit Agent', role: 'agent', password: 'audit-password-123' })).user;
        const agent = await a.login('audit-password-123', 'audit-agent');
        for (const route of ['/admin/customers', '/admin/kb', '/admin/reports']) {
            const r = await fetch(a.url(route), { headers: { Cookie: agent.cookie }, redirect: 'manual' });
            const html = await r.text();
            console.log('agent-page', route, r.status, 'navigation-link', html.includes('href="/admin/kb"'));
        }
        await post(`/admin/users/${user.id}/password`, { password: 'replacement-password-123' });
        console.log('agent-session-after-password-reset', (await fetch(a.url('/admin/tickets'), { headers: { Cookie: agent.cookie }, redirect: 'manual' })).status);
        const secondOwner = await a.login();
        console.log('owner-password-change', (await post('/admin-password', { password: 'new-owner-password-123', confirmPassword: 'new-owner-password-123' })).status);
        console.log('old-owner-session', (await fetch(a.url('/admin'), { headers: { Cookie: secondOwner.cookie }, redirect: 'manual' })).status);
        console.log('duplicate-owner-name-change', (await post('/admin-username', { username: 'audit-agent' })).status);
        console.log('persisted-owner-name', await a.services.usernameStore.read());
        console.log('actual-owner-name', a.services.supportUserStore.get('owner').username);
        const article = a.services.kbStore.create({ title: 'Audit article', body: 'Audit text' });
        if (article.article) console.log('agent-permanent-kb-delete', (await post(`/admin/kb/${article.article.id}/delete`, {}, agent.cookie)).status);
        const token = a.services.apiTokenStore.create({ name: 'audit', scopes: ['read', 'write'] });
        const customer = await a.services.customerStore.createCustomer({ name: 'Audit Customer', email: 'audit@example.invalid', password: 'safe-customer-password-123' });
        const ticket = a.services.ticketStore.createTicket({ customer, subject: 'Audit', body: 'Audit message' }).ticket;
        const r = await fetch(a.url(`/api/v1/customers/${customer.id}`), { method: 'PATCH', headers: { Authorization: `Bearer ${token.secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Renamed', email: 'changed@example.invalid', disabled: 'false' }) });
        console.log('api-customer-patch', r.status);
        console.log('customer-disabled', a.services.customerStore.getCustomer(customer.id).disabled);
        console.log('ticket-requester-after-patch', JSON.stringify(a.services.ticketStore.getTicket(ticket.id)));
    } finally { await a.close(); }
})().catch(err => { console.error(err); process.exitCode = 1; });

// Verzögerte Vorschlagsantwort nach geleertem Suchfeld.
const vm = require('vm');
const fs = require('fs');
let lookup;
let resolveFetch;
const box = { hidden: true, querySelector: () => list };
const list = { textContent: '', appendChild() {} };
const input = { value: '', dataset: { kbSuggest: '/support/articles.json' }, getAttribute: () => 'box', addEventListener: (_event, handler) => { input.changed = handler; } };
vm.runInNewContext(fs.readFileSync(require('path').join(__dirname, '../public/js/kb-suggest.js'), 'utf8'), {
    document: { querySelectorAll: () => [input], getElementById: () => box, createElement: () => ({ appendChild() {} }) },
    setTimeout: fn => { lookup = fn; }, clearTimeout() {},
    AbortController, fetch: () => new Promise(resolve => { resolveFetch = resolve; }),
});
input.value = 'Drucker'; input.changed(); lookup();
input.value = ''; input.changed(); lookup();
resolveFetch({ ok: true, json: async () => ({ data: [{ title: 'Alter Treffer', url: '/old' }] }) });
setImmediate(() => console.log('suggestion-box-visible-for-empty-input', !box.hidden));
