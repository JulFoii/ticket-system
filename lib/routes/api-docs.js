'use strict';

const path = require('path');
const { createOpenApiDocument } = require('../openapi');

function registerApiDocsRoutes({ app, requireAdmin }) {
    const dist = path.dirname(require.resolve('swagger-ui-dist/swagger-ui.css'));
    const document = createOpenApiDocument();
    const asset = name => (req, res) => res.sendFile(path.join(dist, name), { maxAge: '1h' });

    app.get('/api/openapi.json', requireAdmin, (_req, res) => {
        res.set('Cache-Control', 'no-store');
        res.json(document);
    });
    app.get('/api/docs/assets/swagger-ui.css', requireAdmin, asset('swagger-ui.css'));
    app.get('/api/docs/assets/swagger-ui-bundle.js', requireAdmin, asset('swagger-ui-bundle.js'));
    app.get('/api/docs/assets/swagger-ui-standalone-preset.js', requireAdmin, asset('swagger-ui-standalone-preset.js'));
    app.get('/api/docs', requireAdmin, (req, res) => res.render('admin/api-docs', { page: 'admin-integrations' }));
}

module.exports = { registerApiDocsRoutes };
