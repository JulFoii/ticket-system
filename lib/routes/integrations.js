'use strict';

function registerIntegrationRoutes({ app, requireAdmin, apiTokenStore, webhookService, auditLog }) {
    const render = (req, res, extra = {}) => res.render('admin/integrations', {
        tokens: apiTokenStore.list(), webhooks: webhookService.list(),
        deliveries: webhookService.listDeliveries({ limit: 30 }), secret: null, webhookSecret: null,
        error: null, notice: null, ...extra,
    });
    function redirectWithFlash(req, res, flash) {
        req.session.integrationFlash = flash;
        req.session.save(() => res.redirect(303, '/admin/integrations'));
    }
    app.get('/admin/integrations', requireAdmin, (req, res) => {
        const flash = req.session.integrationFlash ?? {};
        delete req.session.integrationFlash;
        render(req, res, flash);
    });
    app.post('/admin/integrations/tokens', requireAdmin, (req, res) => {
        const scopes = ['read', ...(req.body.write === '1' ? ['write'] : []), ...(req.body.admin === '1' ? ['admin'] : [])];
        const result = apiTokenStore.create({ name: req.body.name, role: req.body.admin === '1' ? 'admin' : 'agent', scopes });
        if (result.error) return render(req, res.status(422), { error: result.error });
        auditLog.log('api_token_created', { tokenId: result.token.id, name: result.token.name });
        redirectWithFlash(req, res, { secret: result.secret, notice: 'API-Token wurde erstellt.' });
    });
    app.post('/admin/integrations/tokens/:id/delete', requireAdmin, (req, res) => {
        if (!apiTokenStore.remove(req.params.id)) {
            return redirectWithFlash(req, res, { error: 'API-Token wurde nicht gefunden.' });
        }
        auditLog.log('api_token_deleted', { tokenId: req.params.id });
        redirectWithFlash(req, res, { notice: 'API-Token wurde gelöscht.' });
    });
    app.post('/admin/integrations/webhooks', requireAdmin, (req, res) => {
        const events = String(req.body.events ?? '*').split(',').map(v => v.trim()).filter(Boolean);
        const result = webhookService.create({ name: req.body.name, url: req.body.url, events });
        if (result.error) return render(req, res.status(422), { error: result.error });
        auditLog.log('webhook_created', { webhookId: result.webhook.id, name: result.webhook.name });
        redirectWithFlash(req, res, { webhookSecret: result.secret, notice: 'Webhook wurde erstellt.' });
    });
    app.post('/admin/integrations/webhooks/:id/delete', requireAdmin, (req, res) => {
        if (!webhookService.remove(req.params.id)) {
            return redirectWithFlash(req, res, { error: 'Webhook wurde nicht gefunden.' });
        }
        auditLog.log('webhook_deleted', { webhookId: req.params.id });
        redirectWithFlash(req, res, { notice: 'Webhook wurde gelöscht.' });
    });
    app.post('/admin/integrations/deliveries/:id/retry', requireAdmin, (req, res) => {
        const queued = webhookService.retry(req.params.id);
        redirectWithFlash(req, res, queued
            ? { notice: 'Webhook-Auslieferung wurde erneut eingeplant.' }
            : { error: 'Webhook-Auslieferung wurde nicht gefunden.' });
    });
}

module.exports = { registerIntegrationRoutes };
