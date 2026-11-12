'use strict';

const crypto = require('crypto');

const MAX_ATTEMPTS = 8;
const BACKOFF = [0, 30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000, 48 * 60 * 60_000];

function jsonArray(value, fallback = []) {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : fallback; } catch { return fallback; }
}

function mapWebhook(row) {
    return row ? { id: row.id, name: row.name, url: row.url, events: jsonArray(row.events_json, ['*']), enabled: row.enabled === 1,
        createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

function validateUrl(value) {
    try {
        const url = new URL(String(value));
        return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : null;
    } catch { return null; }
}

function createWebhookService({ db, publicUrl, log = console, fetchImpl = globalThis.fetch }) {
    const byId = db.prepare('SELECT * FROM webhooks WHERE id = ?');
    // Nach einem Prozessabbruch gibt es keinen laufenden HTTP-Request mehr.
    // Solche Zustellungen beim Neustart wieder freigeben statt sie fuer immer
    // im Zwischenzustand `delivering` stehen zu lassen.
    db.prepare("UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = ? WHERE status = 'delivering'")
        .run(Date.now());
    let running = null;

    function list() { return db.prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all().map(mapWebhook); }
    function get(id) { return mapWebhook(byId.get(String(id ?? ''))); }
    function create(input) {
        const name = String(input?.name ?? '').trim();
        const url = validateUrl(input?.url);
        const events = [...new Set(Array.isArray(input?.events) ? input.events.map(String) : ['*'])].filter(Boolean).slice(0, 100);
        if (!name || name.length > 100) return { error: 'Name muss 1 bis 100 Zeichen lang sein.' };
        if (!url) return { error: 'Webhook-URL muss eine gültige HTTP(S)-URL ohne Zugangsdaten sein.' };
        const id = crypto.randomUUID();
        const secret = 'tswhsec_' + crypto.randomBytes(32).toString('base64url');
        const now = Date.now();
        db.prepare(`INSERT INTO webhooks (id, name, url, secret, events_json, enabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?)`).run(id, name, url, secret, JSON.stringify(events.length ? events : ['*']), now, now);
        return { webhook: get(id), secret };
    }
    function update(id, input) {
        const row = byId.get(String(id ?? ''));
        if (!row) return null;
        const name = String(input?.name ?? row.name).trim();
        const url = validateUrl(input?.url ?? row.url);
        const events = Array.isArray(input?.events) ? [...new Set(input.events.map(String).filter(Boolean))].slice(0, 100) : jsonArray(row.events_json, ['*']);
        if (!name || name.length > 100 || !url) return { error: 'Name oder URL ist ungültig.' };
        db.prepare('UPDATE webhooks SET name = ?, url = ?, events_json = ?, enabled = ?, updated_at = ? WHERE id = ?')
            .run(name, url, JSON.stringify(events.length ? events : ['*']), input?.enabled === undefined ? row.enabled : input.enabled ? 1 : 0, Date.now(), id);
        return { webhook: get(id) };
    }
    function remove(id) { return db.prepare('DELETE FROM webhooks WHERE id = ?').run(String(id)).changes > 0; }
    function emit(event, data = {}) {
        const now = Date.now();
        const envelope = { id: crypto.randomUUID(), event: String(event), createdAt: new Date(now).toISOString(), data };
        const hooks = db.prepare('SELECT * FROM webhooks WHERE enabled = 1').all();
        for (const hook of hooks) {
            const events = jsonArray(hook.events_json, ['*']);
            if (!events.includes('*') && !events.includes(event)) continue;
            db.prepare(`INSERT INTO webhook_deliveries
                (id, webhook_id, event, payload_json, status, attempts, next_attempt_at, created_at)
                VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`)
                .run(crypto.randomUUID(), hook.id, event, JSON.stringify(envelope), now, now);
        }
        queueMicrotask(() => deliverDue().catch(err => log.error?.('Webhook-Auslieferung fehlgeschlagen:', err)));
        return envelope.id;
    }
    function listDeliveries({ webhookId = null, limit = 100 } = {}) {
        const max = Math.min(Math.max(Number(limit) || 100, 1), 500);
        const rows = webhookId
            ? db.prepare('SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ?').all(webhookId, max)
            : db.prepare('SELECT * FROM webhook_deliveries ORDER BY created_at DESC LIMIT ?').all(max);
        return rows.map(row => ({ id: row.id, webhookId: row.webhook_id, event: row.event, status: row.status,
            attempts: row.attempts, responseStatus: row.response_status, lastError: row.last_error,
            createdAt: row.created_at, deliveredAt: row.delivered_at, nextAttemptAt: row.next_attempt_at }));
    }
    async function deliver(row) {
        const hook = byId.get(row.webhook_id);
        if (!hook || hook.enabled !== 1) return;
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = crypto.createHmac('sha256', hook.secret).update(`${timestamp}.${row.payload_json}`).digest('hex');
        db.prepare("UPDATE webhook_deliveries SET status = 'delivering', attempts = attempts + 1 WHERE id = ?").run(row.id);
        let response;
        try {
            response = await fetchImpl(hook.url, { method: 'POST', signal: AbortSignal.timeout(10_000),
                headers: { 'content-type': 'application/json', 'user-agent': 'TicketSystem-Webhooks/1.0',
                    'x-ticket-event': row.event, 'x-ticket-delivery': row.id,
                    'x-ticket-timestamp': timestamp, 'x-ticket-signature-256': `sha256=${signature}` }, body: row.payload_json });
            if (response.ok) {
                db.prepare("UPDATE webhook_deliveries SET status = 'delivered', response_status = ?, delivered_at = ?, last_error = NULL WHERE id = ?")
                    .run(response.status, Date.now(), row.id);
                return;
            }
            throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
        } catch (err) {
            const attempts = row.attempts + 1;
            const failed = attempts >= MAX_ATTEMPTS;
            db.prepare(`UPDATE webhook_deliveries SET status = ?, response_status = ?, last_error = ?, next_attempt_at = ? WHERE id = ?`)
                .run(failed ? 'failed' : 'pending', response?.status ?? err.status ?? null, String(err.message).slice(0, 500),
                    Date.now() + BACKOFF[Math.min(attempts, BACKOFF.length - 1)], row.id);
        }
    }
    function deliverDue() {
        if (running) return running;
        running = (async () => {
            const rows = db.prepare(`SELECT d.* FROM webhook_deliveries d
                JOIN webhooks w ON w.id = d.webhook_id
                WHERE d.status = 'pending' AND d.next_attempt_at <= ? AND w.enabled = 1
                ORDER BY d.created_at LIMIT 25`).all(Date.now());
            for (const row of rows) await deliver(row);
        })().finally(() => { running = null; });
        return running;
    }
    function retry(id) {
        return db.prepare(`UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = ?,
            response_status = NULL, last_error = NULL, delivered_at = NULL WHERE id = ? AND status = 'failed'`)
            .run(Date.now(), String(id)).changes > 0;
    }
    return { list, get, create, update, remove, emit, listDeliveries, deliverDue, retry, publicUrl };
}

module.exports = { createWebhookService, validateUrl };
