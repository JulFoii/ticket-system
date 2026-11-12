'use strict';

const crypto = require('crypto');

const MAX_PAYLOAD_CHARS = 16_000;
const MAX_STRING_CHARS = 2_000;
const SECRET_KEY = /(password|passwd|pass|secret|token|cookie|authorization|salt|hash|recoverycodes?|sid|otp|totp|apikey|privatekey|credential(publickey)?)$/i;
const SAFE_KEYS = new Set(['sha256', 'sessionhash']);

function truncate(value, max) {
    if (value === undefined || value === null) return null;
    const text = String(value);
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

function redact(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (depth > 6) return '[…]';
    if (typeof value === 'string') return truncate(value, MAX_STRING_CHARS);
    if (typeof value === 'bigint') return value.toString();
    if (typeof value !== 'object') return value;
    if (value instanceof Error) return { name: value.name, message: value.message, code: value.code };
    if (value instanceof Date) return value.toISOString();
    if (Buffer.isBuffer(value)) return `[${value.length} Byte]`;
    if (Array.isArray(value)) {
        const items = value.slice(0, 200).map(item => redact(item, depth + 1));
        if (value.length > 200) items.push(`[… ${value.length - 200} weitere]`);
        return items;
    }
    const out = {};
    for (const [key, val] of Object.entries(value)) {
        const lower = key.toLowerCase();
        out[key] = !SAFE_KEYS.has(lower) && SECRET_KEY.test(lower) && val !== null && val !== undefined && val !== ''
            ? '[redacted]'
            : redact(val, depth + 1);
    }
    return out;
}

/*
 * Vorher-Nachher-Vergleich fuer CRUD-Aenderungen: nur die geaenderten Felder,
 * sensible Werte maskiert (redact). `null` wenn sich nichts geaendert hat.
 */
function diff(before, after) {
    const a = before ?? {};
    const b = after ?? {};
    const changes = {};
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (JSON.stringify(a[key]) === JSON.stringify(b[key])) continue;
        const secret = !SAFE_KEYS.has(key.toLowerCase()) && SECRET_KEY.test(key.toLowerCase());
        changes[key] = secret
            ? { from: '[redacted]', to: '[redacted]' }
            : { from: redact(a[key] ?? null), to: redact(b[key] ?? null) };
    }
    return Object.keys(changes).length > 0 ? changes : null;
}

function stringifyPayload(payload) {
    if (payload === undefined || payload === null) return null;
    let json;
    try {
        json = JSON.stringify(redact(payload));
    } catch {
        json = JSON.stringify({ unserializable: true });
    }
    if (json === '{}' || json === '[]') return null;
    if (json.length > MAX_PAYLOAD_CHARS) {
        json = JSON.stringify({ truncated: true, preview: json.slice(0, MAX_PAYLOAD_CHARS) });
    }
    return json;
}

function hashSession(sessionId) {
    return crypto.createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 16);
}

function pathOf(req) {
    const raw = req.originalUrl ?? req.url ?? '';
    return truncate(raw.split('?')[0], 300);
}

/*
 * FTS5-Suchausdruck aus Nutzereingabe: jedes Wort als Phrase mit
 * Praefix-Suche, verknuepft per UND. Anfuehrungszeichen fliegen raus, damit
 * nie eine FTS5-Syntax aus der Eingabe entsteht.
 */
function ftsQuery(input) {
    const terms = String(input ?? '')
        .split(/\s+/)
        .map(term => term.replace(/"/g, '').trim())
        .filter(term => /[\p{L}\p{N}]/u.test(term))
        .slice(0, 8);
    if (terms.length === 0) return null;
    return terms.map(term => `"${term}"*`).join(' ');
}

function escapeLike(term) {
    return term.replace(/[\\%_]/g, char => `\\${char}`);
}

module.exports = {
    diff, escapeLike, ftsQuery, hashSession, pathOf, redact, stringifyPayload, truncate,
};

