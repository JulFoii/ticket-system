'use strict';

/* Support-Konten fuer den Mehrbenutzerbetrieb. Der historische Admin bleibt
   als Owner erhalten; sein Hash wird beim Start aus admin_password gespiegelt,
   damit bestehende Installationen ohne neuen Bootstrap weiterlaufen. */

const crypto = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(crypto.scrypt);
const KEY_LENGTH = 64;
const OWNER_ID = 'owner';

function toUser(row) {
    return row ? {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        role: row.role,
        disabled: row.disabled === 1,
        isOwner: row.is_owner === 1,
        createdAt: row.created_at,
        lastLoginAt: row.last_login_at,
    } : null;
}

function createSupportUserStore({ db }) {
    if (!db) throw new Error('support user store braucht eine db');

    const byIdStmt = db.prepare('SELECT * FROM support_users WHERE id = ?');
    const byUsernameStmt = db.prepare('SELECT * FROM support_users WHERE username = ? COLLATE NOCASE');
    const listStmt = db.prepare('SELECT * FROM support_users ORDER BY is_owner DESC, display_name COLLATE NOCASE, username COLLATE NOCASE');
    const insertStmt = db.prepare(`
        INSERT INTO support_users
            (id, username, display_name, role, password_salt, password_hash, disabled, is_owner, created_at)
        VALUES (@id, @username, @displayName, @role, @salt, @hash, 0, @isOwner, @createdAt)
    `);
    const updateStmt = db.prepare(`
        UPDATE support_users SET username = @username, display_name = @displayName,
            role = @role, disabled = @disabled WHERE id = @id AND is_owner = 0
    `);
    const passwordStmt = db.prepare('UPDATE support_users SET password_salt = ?, password_hash = ? WHERE id = ?');
    const loginStmt = db.prepare('UPDATE support_users SET last_login_at = ? WHERE id = ?');
    const deleteStmt = db.prepare('DELETE FROM support_users WHERE id = ? AND is_owner = 0');

    async function hashPassword(password) {
        const salt = crypto.randomBytes(16);
        const hash = await scryptAsync(String(password), salt, KEY_LENGTH);
        return { salt: salt.toString('base64url'), hash: hash.toString('base64url') };
    }

    async function verifyPassword(password, row) {
        if (!row) {
            // Gleiche teure Operation auch bei unbekanntem Namen: keine
            // Benutzer-Enumeration ueber Antwortzeiten.
            await scryptAsync(String(password ?? ''), crypto.randomBytes(16), KEY_LENGTH);
            return false;
        }
        const stored = Buffer.from(row.password_hash, 'base64url');
        const candidate = await scryptAsync(String(password ?? ''), Buffer.from(row.password_salt, 'base64url'), stored.length);
        return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
    }

    function get(id) { return toUser(byIdStmt.get(String(id ?? ''))); }
    function findByUsername(username) { return byUsernameStmt.get(String(username ?? '').trim()) ?? null; }
    function list() { return listStmt.all().map(toUser); }

    function ensureOwner({ username, passwordRecord }) {
        const existing = byIdStmt.get(OWNER_ID);
        if (!existing) {
            insertStmt.run({
                id: OWNER_ID, username, displayName: username, role: 'admin',
                salt: passwordRecord.salt, hash: passwordRecord.hash, isOwner: 1, createdAt: Date.now(),
            });
        } else {
            db.prepare(`UPDATE support_users SET username = ?, display_name = CASE
                WHEN display_name = username THEN ? ELSE display_name END,
                password_salt = ?, password_hash = ?, role = 'admin', disabled = 0 WHERE id = ?`)
                .run(username, username, passwordRecord.salt, passwordRecord.hash, OWNER_ID);
        }
        return get(OWNER_ID);
    }

    async function create({ username, displayName, role, password }) {
        const record = await hashPassword(password);
        const id = crypto.randomUUID();
        try {
            insertStmt.run({
                id, username, displayName, role, salt: record.salt, hash: record.hash,
                isOwner: 0, createdAt: Date.now(),
            });
        } catch (err) {
            if (/UNIQUE/i.test(err.message)) return { error: 'Dieser Benutzername ist bereits vergeben.' };
            throw err;
        }
        return { user: get(id) };
    }

    function update(id, { username, displayName, role, disabled }) {
        try {
            const changes = updateStmt.run({ id, username, displayName, role, disabled: disabled ? 1 : 0 }).changes;
            return changes ? { user: get(id) } : { error: 'Benutzer nicht gefunden oder Owner-Konto.' };
        } catch (err) {
            if (/UNIQUE/i.test(err.message)) return { error: 'Dieser Benutzername ist bereits vergeben.' };
            throw err;
        }
    }

    async function setPassword(id, password) {
        const record = await hashPassword(password);
        return passwordStmt.run(record.salt, record.hash, id).changes > 0;
    }

    function remove(id) { return deleteStmt.run(id).changes > 0; }
    function recordLogin(id) { loginStmt.run(Date.now(), id); }

    return {
        OWNER_ID, get, findByUsername, list, ensureOwner, create, update, setPassword,
        remove, recordLogin, verifyPassword,
    };
}

module.exports = { createSupportUserStore, OWNER_ID };
