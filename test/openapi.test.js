'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createOpenApiDocument } = require('../lib/openapi');
const { startTestApp } = require('./helpers/app');

function implementedOperations() {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'routes', 'api-v1.js'), 'utf8');
    return [...source.matchAll(/router\.(get|post|patch|delete)\('([^']+)'/g)]
        .map(([, method, route]) => `${method.toUpperCase()} ${route.replace(/:([A-Za-z]+)/g, '{$1}')}`)
        .sort();
}

function documentedOperations(document) {
    const methods = new Set(['get', 'post', 'patch', 'delete', 'put']);
    return Object.entries(document.paths).flatMap(([route, item]) => Object.keys(item)
        .filter(method => methods.has(method)).map(method => `${method.toUpperCase()} ${route}`)).sort();
}

test('OpenAPI 3.1 dokumentiert jeden implementierten REST-Endpunkt genau einmal', () => {
    const document = createOpenApiDocument();
    assert.equal(document.openapi, '3.1.0');
    assert.deepEqual(documentedOperations(document), implementedOperations());
    assert.equal(document.components.securitySchemes.bearerAuth.scheme, 'bearer');
    for (const operation of Object.values(document.paths).flatMap(item => Object.values(item))) {
        assert.ok(operation.operationId, 'operationId fehlt');
        assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
        assert.ok(operation.responses[401]);
        assert.ok(operation.responses[403]);
    }
});

test('Swagger UI und OpenAPI-Dokument sind nur für Administratoren erreichbar', async t => {
    const app = await startTestApp({ startMailWorkers: false });
    t.after(() => app.close());
    const anonymous = await fetch(app.url('/api/docs'), { redirect: 'manual' });
    assert.equal(anonymous.status, 302);

    const { cookie } = await app.login();
    const headers = { Cookie: cookie };
    const page = await fetch(app.url('/api/docs'), { headers });
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /Swagger API-Dokumentation/);
    assert.match(html, /swagger-ui-bundle\.js/);
    assert.match(html, /swagger-init\.js\?v=/);

    const spec = await fetch(app.url('/api/openapi.json'), { headers });
    assert.equal(spec.status, 200);
    assert.equal((await spec.json()).paths['/tickets'].post.operationId, 'createTicket');
    const css = await fetch(app.url('/api/docs/assets/swagger-ui.css'), { headers });
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
});
