'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/app');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

test('Audit: Namenskonflikte bleiben atomar, Passwortwechsel widerrufen fremde Sitzungen', async t => {
    const a = await startTestApp();
    let stopped = false;
    let b;
    t.after(async () => {
        if (b) await b.close();
        if (!stopped) await a.close();
        else await fs.promises.rm(a.root, { recursive: true, force: true });
    });
    const owner = await a.login();
    const second = await a.login();
    const user = (await a.services.supportUserStore.create({ username: 'agent-audit', displayName: 'Agent', role: 'agent', password: 'test-password-long' })).user;
    const agent = await a.login('test-password-long', user.username);
    const post = (url, body) => fetch(a.url(url), { method: 'POST', redirect: 'manual', headers: { Cookie: owner.cookie, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
    assert.equal((await post('/admin-username', { username: user.username })).status, 409);
    assert.equal(await a.services.usernameStore.read(), 'admin');
    assert.equal(a.services.supportUserStore.get('owner').username, 'admin');
    assert.equal((await post(`/admin/users/${user.id}/password`, { password: 'replacement-password' })).status, 303);
    const get = (url, cookie) => fetch(a.url(url), { redirect: 'manual', headers: { Cookie: cookie, Accept: 'application/json' } });
    assert.equal((await get('/admin/tickets', agent.cookie)).status, 401);
    assert.equal((await post('/admin-password', { password: 'new-owner-password', confirmPassword: 'new-owner-password' })).status, 200);
    assert.equal((await get('/admin', second.cookie)).status, 401);
    assert.equal((await get('/admin', owner.cookie)).status, 200);
    // Derselbe Datenbestand muss nach Neustart weiterhin verwendbar sein.
    const dirs = { dataDir: path.join(a.root, 'data'), tmpDir: path.join(a.root, 'tmp-uploads') };
    await a.shutdown();
    stopped = true;
    b = await startTestApp(dirs);
    assert.equal((await b.login('new-owner-password')).res.status, 302);
});

test('Audit: API validiert vor Mutation, synchronisiert Kunden und schützt endgültige Artikellöschung', async t => {
    const a = await startTestApp();
    t.after(() => a.close());
    const { secret } = a.services.apiTokenStore.create({ name: 'Agent', scopes: ['read', 'write'] });
    const customer = await a.services.customerStore.createCustomer({ name: 'Original', email: 'audit@example.invalid', password: 'long-password-test' });
    const ticket = a.services.ticketStore.createTicket({ customer, subject: 'Audit', body: 'Test' }).ticket;
    const patch = body => fetch(a.url(`/api/v1/customers/${customer.id}`), { method: 'PATCH', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await patch({ name: 'Wrong', disabled: 'false' })).status, 422);
    assert.equal(a.services.customerStore.getCustomer(customer.id).name, 'Original');
    assert.equal((await patch({ name: 'Updated', email: 'updated@example.invalid', disabled: false })).status, 200);
    const updated = a.services.ticketStore.getTicket(ticket.id);
    assert.equal(updated.requesterName, 'Updated');
    assert.equal(updated.requesterEmail, 'updated@example.invalid');
    const article = a.services.kbStore.create({ title: 'Audit article', body: 'Test' }).article;
    const user = (await a.services.supportUserStore.create({ username: 'agent', displayName: 'Agent', role: 'agent', password: 'test-password-long' })).user;
    const agent = await a.login('test-password-long', user.username);
    assert.equal((await fetch(a.url(`/admin/kb/${article.id}/delete`), { method: 'POST', redirect: 'manual', headers: { Cookie: agent.cookie } })).status, 403);
    assert.equal((await fetch(a.url(`/api/v1/knowledge-base/articles/${article.id}`), { method: 'DELETE', headers: { Authorization: `Bearer ${secret}` } })).status, 403);
    assert.ok(a.services.kbStore.get(article.id));
    const editor = await (await fetch(a.url(`/admin/kb/${article.id}`), { headers: { Cookie: agent.cookie } })).text();
    assert.ok(!editor.includes(`/admin/kb/${article.id}/delete`));
    for (const url of ['/imprint', '/privacy']) {
        const html = await (await fetch(a.url(url))).text();
        assert.ok(html.includes('Julian Foitzik'));
        assert.ok(!html.includes('class="placeholder"'));
    }
});

test('Audit: verspätete Artikelvorschläge bleiben bei geleertem Feld unsichtbar', async () => {
    let lookup;
    let finish;
    const list = { textContent: '', appendChild() {} };
    const box = { hidden: true, querySelector: () => list };
    const input = { value: '', dataset: { kbSuggest: '/suggest' }, getAttribute: () => 'box', addEventListener: (_event, fn) => { input.changed = fn; } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/kb-suggest.js'), 'utf8'), {
        document: { querySelectorAll: () => [input], getElementById: () => box, createElement: () => ({ appendChild() {} }) },
        setTimeout: fn => { lookup = fn; }, clearTimeout() {}, AbortController,
        fetch: () => new Promise(resolve => { finish = resolve; }),
    });
    input.value = 'Drucker'; input.changed(); lookup();
    input.value = ''; input.changed(); lookup();
    finish({ ok: true, json: async () => ({ data: [{ title: 'Alter Treffer', url: '/old' }] }) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(box.hidden, true);
});
