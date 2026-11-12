'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { startTestApp } = require('./helpers/app');

test('Bootstrap is served locally, versioned and loaded as ESM on public and admin pages', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();
    for (const route of ['/support', '/account/register', '/login', '/admin', '/admin/tickets', '/admin/logs']) {
        const response = await fetch(app.url(route), { headers: { Cookie: cookie } });
        assert.equal(response.status, 200, route);
        const html = await response.text();
        assert.match(html, /href="\/vendor\/bootstrap\/bootstrap.min.css\?v=[a-f0-9]{10}"/);
        assert.match(html, /type="module" src="\/vendor\/bootstrap\/bootstrap.bundle.min.js\?v=[a-f0-9]{10}"/);
        assert.doesNotMatch(html, /class="[^"\n]*(?:btn--|\binput\b|card__)/);
        assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    }
    for (const [name, type] of [['bootstrap.min.css', /text\/css/], ['bootstrap.bundle.min.js', /javascript/]]) {
        const response = await fetch(app.url('/vendor/bootstrap/' + name));
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), type);
        assert.equal(await response.text(), fs.readFileSync(require.resolve('bootstrap/dist/' + (name.endsWith('.css') ? 'css/' : 'js/') + name), 'utf8'));
    }
    // Package metadata and sources must never become public through this route.
    for (const route of ['/vendor/bootstrap/package.json', '/vendor/bootstrap/scss/bootstrap.scss']) {
        assert.equal((await fetch(app.url(route))).status, 404);
    }
});
