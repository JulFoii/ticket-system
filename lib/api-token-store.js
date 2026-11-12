'use strict';

const crypto = require('crypto');

const PREFIX = 'tsapi_';
const VALID_SCOPES = ['read', 'write', 'admin'];

function hash(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function parseScopes(value) {
    try {
        const parsed = JSON.parse(value || '[]');
        return Array.isArray(parsed) ? parsed.filter(scope => VALID_SCOPES.includes(scope)) : [];
    } catch { return []; }
}

function mapToken(row) {
    return row ? {
        id: row.id, name: row.name, role: row.role, scopes: parseScopes(row.scopes_json),
        disabled: row.disabled === 1, createdAt: row.created_at, lastUsedAt: row.last_used_at,
        expiresAt: row.expires_at,
    } : null;
}

function createApiTokenStore({ db }) {
    const listStmt = db.prepare('SELECT * FROM api_tokens ORDER BY created_at DESC');
    const getStmt = db.prepare('SELECT * FROM api_tokens WHERE id = ?');
    const authStmt = db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?');
    const touchStmt = db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?');

    function list() { return listStmt.all().map(mapToken); }
    function get(id) { return mapToken(getStmt.get(String(id ?? ''))); }
    function create({ name, role = 'agent', scopes = ['read', 'write'], expiresAt = null }) {
        const cleanName = String(name ?? '').trim();
        if (!cleanName || cleanName.length > 100) return { error: 'Name muss 1 bis 100 Zeichen lang sein.' };
        const cleanRole = role === 'admin' ? 'admin' : 'agent';
        const cleanScopes = [...new Set(Array.isArray(scopes) ? scopes : [])]
            .filter(scope => VALID_SCOPES.includes(scope) && (scope !== 'admin' || cleanRole === 'admin'));
        if (!cleanScopes.includes('read')) cleanScopes.unshift('read');
        const expiry = expiresAt == null ? null : Number(expiresAt);
        if (expiry !== null && (!Number.isFinite(expiry) || expiry <= Date.now())) return { error: 'Ablaufzeitpunkt liegt nicht in der Zukunft.' };
        const id = crypto.randomUUID();
        const secret = PREFIX + crypto.randomBytes(32).toString('base64url');
        db.prepare(`INSERT INTO api_tokens
            (id, name, token_hash, role, scopes_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(id, cleanName, hash(secret), cleanRole, JSON.stringify(cleanScopes), Date.now(), expiry);
        return { token: get(id), secret };
    }
    function authenticate(secret) {
        if (!String(secret ?? '').startsWith(PREFIX)) return null;
        const row = authStmt.get(hash(secret));
        if (!row || row.disabled === 1 || (row.expires_at && row.expires_at <= Date.now())) return null;
        touchStmt.run(Date.now(), row.id);
        return mapToken(row);
    }
    function update(id, { name, disabled, scopes, role, expiresAt }) {
        const existing = get(id);
        if (!existing) return null;
        const cleanRole = role === undefined ? existing.role : role === 'admin' ? 'admin' : role === 'agent' ? 'agent' : null;
        if (!cleanRole) return { error: 'Ungültige Rolle.' };
        const cleanName = String(name ?? existing.name).trim();
        if (!cleanName || cleanName.length > 100) return { error: 'Name muss 1 bis 100 Zeichen lang sein.' };
        const cleanScopes = [...new Set(Array.isArray(scopes) ? scopes : existing.scopes)]
            .filter(scope => VALID_SCOPES.includes(scope) && (scope !== 'admin' || cleanRole === 'admin'));
        if (!cleanScopes.includes('read')) cleanScopes.unshift('read');
        const expiry = expiresAt === undefined ? existing.expiresAt
            : expiresAt == null || expiresAt === '' ? null : Number(expiresAt);
        if (expiry !== null && (!Number.isFinite(expiry) || expiry <= Date.now())) {
            return { error: 'Ablaufzeitpunkt liegt nicht in der Zukunft.' };
        }
        db.prepare(`UPDATE api_tokens SET name = ?, role = ?, scopes_json = ?, disabled = ?, expires_at = ? WHERE id = ?`)
            .run(cleanName, cleanRole, JSON.stringify(cleanScopes), disabled === undefined ? existing.disabled ? 1 : 0 : disabled ? 1 : 0,
                expiry, id);
        return get(id);
    }
    function remove(id) { return db.prepare('DELETE FROM api_tokens WHERE id = ?').run(String(id)).changes > 0; }
    return { list, get, create, authenticate, update, remove, VALID_SCOPES };
}

module.exports = { createApiTokenStore, VALID_SCOPES };
