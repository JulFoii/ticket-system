'use strict';

/*
 * Eine einzige SQLite-Datenbank (DATA_DIR/ticket-system.db) fuer den
 * gesamten Zustand der App: Sitzungen, Admin-Zugang (Passwort, Benutzername,
 * TOTP, Passkeys), Session-Signierschluessel, Kundenkonten, Tickets samt
 * Nachrichten, Wissensdatenbank, Mail-Outbox und Backup-Einstellungen. Nur
 * die Bytes der Ticket-Anhaenge liegen im Dateisystem
 * (DATA_DIR/ticket-attachments/), das Event-Log in einer eigenen Datei
 * (DATA_DIR/events.db, siehe lib/event-store.js).
 *
 * Bootstrap-Prinzip fuer sicherheitsrelevante Einzelwerte (Passwort,
 * Benutzername, Session-Secret): der aus Env-Var/Default berechnete Wert wird
 * beim allerersten Start, an dem die jeweilige Tabelle noch leer ist, sofort
 * in die DB geschrieben. Ab da gewinnt ausschliesslich die DB — eine
 * spaetere Aenderung der Env-Var hat keine Wirkung mehr, dieselbe Regel wie
 * fuer eine explizite Aenderung ueber die Admin-UI. Ein Geheimnis, das
 * dauerhaft in einer Env-Var/.env-Datei steht, ist im Produktivbetrieb die
 * schlechtere Aufbewahrung.
 *
 * node:sqlite (DatabaseSync) statt einer Dependency wie better-sqlite3: seit
 * Node 22.5 im Core, synchron (kein Treiber-Overhead, keine zusaetzliche
 * Angriffsflaeche). Die Synchronitaet ist hier unproblematisch — es sind
 * einzelne, indizierte Operationen auf einer kleinen eingebetteten DB
 * (Mikrosekunden).
 *
 * WAL-Modus: Lesen blockiert Schreiben nicht (und umgekehrt), wichtig weil
 * derselbe Prozess parallel Sitzungen aktualisiert, Mails verschickt und
 * Tickets schreibt.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

/*
 * Verbindungs-Pragmas, bei jedem Oeffnen gesetzt (gelten nur fuer diese
 * Verbindung, werden nicht in der Datei gespeichert — ausser journal_mode):
 *  - WAL: Lesen blockiert Schreiben nicht, siehe oben.
 *  - synchronous=NORMAL: im WAL-Modus die empfohlene Stufe — ein Stromausfall
 *    kann hoechstens die allerletzten Transaktionen kosten, die Datei bleibt
 *    aber immer konsistent; FULL wuerde jeden Commit mit einem fsync bezahlen.
 *  - busy_timeout: wartet bis zu 5 s auf eine Sperre statt sofort mit
 *    SQLITE_BUSY zu scheitern — relevant, sobald ausser dieser App noch
 *    jemand die Datei oeffnet (DB-Browser, das node -e-Snippet aus der
 *    README, ein Backup-Tool auf dem Host).
 */
const PRAGMAS = `
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
`;

const SCHEMA = `

    CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        expires INTEGER NOT NULL,
        data_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires);

    CREATE TABLE IF NOT EXISTS webauthn_user (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        user_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webauthn_credentials (
        credential_id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL,
        counter INTEGER NOT NULL,
        transports_json TEXT NOT NULL DEFAULT '[]',
        label TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS session_secret (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        secret TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_password (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        salt TEXT NOT NULL,
        hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_username (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        username TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS totp (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        secret TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS totp_recovery_codes (
        hash TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS backup_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        interval_minutes INTEGER NOT NULL DEFAULT 60,
        retention_count INTEGER NOT NULL DEFAULT 24,
        enabled INTEGER NOT NULL DEFAULT 1
    );
`;

/*
 * Ticketsystem mit Kundenkonten (siehe lib/customer-store.js,
 * lib/ticket-store.js, lib/mail-outbox.js).
 */
const TICKET_SCHEMA = `
    CREATE TABLE IF NOT EXISTS support_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('admin', 'agent')),
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0,
        is_owner INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1)),
        created_at INTEGER NOT NULL,
        last_login_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS support_users_owner ON support_users(is_owner) WHERE is_owner = 1;

    CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        name TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        email_verified_at INTEGER,
        disabled INTEGER NOT NULL DEFAULT 0,
        notify_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        last_login_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS customers_email ON customers(email);

    CREATE TABLE IF NOT EXISTS customer_tokens (
        token_hash TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset', 'email_change')),
        payload TEXT,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS customer_tokens_customer ON customer_tokens(customer_id);

    CREATE TABLE IF NOT EXISTS ticket_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        position INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        number INTEGER NOT NULL UNIQUE,
        customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
        requester_email TEXT NOT NULL,
        requester_name TEXT,
        subject TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new'
            CHECK (status IN ('new', 'open', 'pending', 'resolved', 'closed')),
        priority TEXT NOT NULL DEFAULT 'normal'
            CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
        category_id INTEGER REFERENCES ticket_categories(id) ON DELETE SET NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT 'web',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_customer_activity_at INTEGER,
        last_admin_activity_at INTEGER,
        first_response_at INTEGER,
        resolved_at INTEGER,
        closed_at INTEGER,
        customer_unread INTEGER NOT NULL DEFAULT 0,
        admin_unread INTEGER NOT NULL DEFAULT 1,
        reminder_sent_at INTEGER,
        rating INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
        rating_comment TEXT,
        rated_at INTEGER,
        merged_into_id TEXT,
        split_from_id TEXT,
        sla_notified_at INTEGER,
        snoozed_until INTEGER
    );
    CREATE INDEX IF NOT EXISTS tickets_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS tickets_customer ON tickets(customer_id);
    CREATE INDEX IF NOT EXISTS tickets_updated ON tickets(updated_at);
    CREATE INDEX IF NOT EXISTS tickets_split_from ON tickets(split_from_id);
    CREATE INDEX IF NOT EXISTS tickets_snoozed ON tickets(snoozed_until);

    CREATE TABLE IF NOT EXISTS ticket_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        author TEXT NOT NULL CHECK (author IN ('customer', 'admin', 'system')),
        kind TEXT NOT NULL CHECK (kind IN ('reply', 'note', 'event')),
        internal INTEGER NOT NULL DEFAULT 0,
        body TEXT NOT NULL,
        via TEXT NOT NULL DEFAULT 'web' CHECK (via IN ('web', 'email')),
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ticket_messages_ticket_id ON ticket_messages(ticket_id);

    CREATE TABLE IF NOT EXISTS ticket_attachments (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        message_id INTEGER REFERENCES ticket_messages(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ticket_attachments_ticket ON ticket_attachments(ticket_id);
    CREATE INDEX IF NOT EXISTS ticket_attachments_message ON ticket_attachments(message_id);

    CREATE TABLE IF NOT EXISTS canned_responses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ticket_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        pending_reminder_days INTEGER NOT NULL DEFAULT 3,
        pending_auto_resolve_days INTEGER NOT NULL DEFAULT 7,
        auto_close_days INTEGER NOT NULL DEFAULT 7
    );

    CREATE TABLE IF NOT EXISTS admin_notification_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        recipients TEXT NOT NULL DEFAULT '',
        notify_new_ticket INTEGER NOT NULL DEFAULT 1 CHECK (notify_new_ticket IN (0, 1)),
        notify_customer_reply INTEGER NOT NULL DEFAULT 1 CHECK (notify_customer_reply IN (0, 1)),
        notify_sla_breach INTEGER NOT NULL DEFAULT 1 CHECK (notify_sla_breach IN (0, 1))
    );

    -- Anrede/Grussformel fuer Support-Antworten (lib/reply-template.js).
    CREATE TABLE IF NOT EXISTS ticket_reply_template (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        greeting TEXT NOT NULL,
        signature TEXT NOT NULL,
        agent_name TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS mail_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        to_addr TEXT NOT NULL,
        subject TEXT NOT NULL,
        text_body TEXT NOT NULL,
        html_body TEXT,
        headers_json TEXT NOT NULL DEFAULT '{}',
        attachments_json TEXT NOT NULL DEFAULT '[]',
        ticket_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_attempt_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        sent_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS mail_outbox_due ON mail_outbox(status, next_attempt_at);

    -- Antwortfristen je Prioritaet (lib/ticket-config-store.js readSla()).
    -- NULL/0 = keine Frist. Fehlt eine Zeile, gelten die SLA_DEFAULTS.
    CREATE TABLE IF NOT EXISTS ticket_sla (
        priority TEXT PRIMARY KEY CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
        first_response_minutes INTEGER,
        next_response_minutes INTEGER
    );

    -- Wissensdatenbank / FAQ auf /support (lib/kb-store.js).
    CREATE TABLE IF NOT EXISTS kb_articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        category_id INTEGER REFERENCES ticket_categories(id) ON DELETE SET NULL,
        published INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0,
        views INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );

    -- Anonyme Wirksamkeitsmessung der Wissensdatenbank. Es werden keine IP-
    -- Adressen oder Browserkennungen gespeichert; Freitext ist optional.
    CREATE TABLE IF NOT EXISTS kb_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        article_id INTEGER NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
        helpful INTEGER NOT NULL CHECK (helpful IN (0, 1)),
        comment TEXT,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS kb_feedback_article_created ON kb_feedback(article_id, created_at);
    CREATE TABLE IF NOT EXISTS kb_search_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query TEXT NOT NULL,
        result_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS kb_search_events_created ON kb_search_events(created_at);
    CREATE TABLE IF NOT EXISTS kb_article_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        article_id INTEGER NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
        event TEXT NOT NULL CHECK (event IN ('suggestion_click', 'ticket_started')),
        query TEXT,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS kb_article_events_article_created ON kb_article_events(article_id, created_at);

    -- Mail-Eingang (lib/inbound-mail-store.js): schon verarbeitete Mails
    -- (Message-ID, gegen Doppelverarbeitung nach Absturz/Neustart),
    -- gedrosselte Hinweis-Mails (gegen Autoresponder-Schleifen) und der
    -- IMAP-UID-Stand je Postfach.
    CREATE TABLE IF NOT EXISTS inbound_mail_seen (
        key TEXT PRIMARY KEY,
        seen_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS inbound_mail_seen_at ON inbound_mail_seen(seen_at);
    CREATE TABLE IF NOT EXISTS inbound_mail_notices (
        key TEXT PRIMARY KEY,
        sent_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS imap_state (
        mailbox TEXT PRIMARY KEY,
        uid_validity TEXT NOT NULL,
        last_uid INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_tokens (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('admin', 'agent')),
        scopes_json TEXT NOT NULL DEFAULT '["read","write"]',
        disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        expires_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        secret TEXT NOT NULL,
        events_json TEXT NOT NULL DEFAULT '["*"]',
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id TEXT PRIMARY KEY,
        webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
        event TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivering', 'delivered', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        response_status INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);
`;

/*
 * Versionierte Schema-Migrationen. Die aktuelle Version steht in
 * `PRAGMA user_version` der Datei selbst; beim Oeffnen laufen genau die
 * Migrationen mit hoeherer Nummer, jede in ihrer eigenen Transaktion
 * zusammen mit dem Hochzaehlen der Version — bricht eine ab, bleibt die DB
 * auf dem vorherigen, konsistenten Stand.
 *
 * Regeln fuer neue Eintraege: nur anhaengen (nie umnummerieren oder
 * nachtraeglich aendern), fortlaufend nummerieren. Neue Tabellen duerfen
 * weiterhin per CREATE TABLE IF NOT EXISTS in SCHEMA stehen; alles, was eine
 * *bestehende* Tabelle aendert (ALTER TABLE, Datenumbau), gehoert hierher.
 *
 * 1 ist das Ausgangsschema (SCHEMA/TICKET_SCHEMA oben) und aendert selbst
 * nichts — es stempelt nur die Version, damit kuenftige Migrationen eine
 * Basis haben.
 */
const MIGRATIONS = [
    {
        version: 1,
        name: 'Ausgangsschema',
        up() {},
    },
    {
        version: 2,
        name: 'Support-Nutzer und Ticket-Zuweisung',
        up(db) {
            db.exec('ALTER TABLE tickets ADD COLUMN assigned_to_user_id TEXT REFERENCES support_users(id) ON DELETE SET NULL');
            db.exec('ALTER TABLE ticket_messages ADD COLUMN support_user_id TEXT REFERENCES support_users(id) ON DELETE SET NULL');
            db.exec('CREATE INDEX tickets_assigned_to ON tickets(assigned_to_user_id)');
        },
    },
    {
        version: 3,
        name: 'Konfigurierbare Admin-Benachrichtigungen',
        up(db) {
            db.exec(`
                CREATE TABLE IF NOT EXISTS admin_notification_settings (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    recipients TEXT NOT NULL DEFAULT '',
                    notify_new_ticket INTEGER NOT NULL DEFAULT 1 CHECK (notify_new_ticket IN (0, 1)),
                    notify_customer_reply INTEGER NOT NULL DEFAULT 1 CHECK (notify_customer_reply IN (0, 1)),
                    notify_sla_breach INTEGER NOT NULL DEFAULT 1 CHECK (notify_sla_breach IN (0, 1))
                )
            `);
        },
    },
    {
        version: 4,
        name: 'Auswahl der Support-Sicherheitsbenachrichtigungen',
        up(db) {
            db.exec('ALTER TABLE admin_notification_settings ADD COLUMN notify_support_created INTEGER NOT NULL DEFAULT 1 CHECK (notify_support_created IN (0, 1))');
            db.exec('ALTER TABLE admin_notification_settings ADD COLUMN notify_support_updated INTEGER NOT NULL DEFAULT 1 CHECK (notify_support_updated IN (0, 1))');
            db.exec('ALTER TABLE admin_notification_settings ADD COLUMN notify_support_password INTEGER NOT NULL DEFAULT 1 CHECK (notify_support_password IN (0, 1))');
            db.exec('ALTER TABLE admin_notification_settings ADD COLUMN notify_support_deleted INTEGER NOT NULL DEFAULT 1 CHECK (notify_support_deleted IN (0, 1))');
        },
    },
    {
        version: 5,
        name: 'REST-API-Tokens und Webhooks',
        up(db) {
            db.exec(`
                CREATE TABLE IF NOT EXISTS api_tokens (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
                    role TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('admin', 'agent')),
                    scopes_json TEXT NOT NULL DEFAULT '["read","write"]',
                    disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
                    created_at INTEGER NOT NULL, last_used_at INTEGER, expires_at INTEGER
                );
                CREATE TABLE IF NOT EXISTS webhooks (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL,
                    events_json TEXT NOT NULL DEFAULT '["*"]', enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
                    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS webhook_deliveries (
                    id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
                    event TEXT NOT NULL, payload_json TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivering', 'delivered', 'failed')),
                    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
                    response_status INTEGER, last_error TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER
                );
                CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);
            `);
        },
    },
];

const SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

function schemaVersion(db) {
    return db.prepare('PRAGMA user_version').get().user_version;
}

/*
 * Wendet alle ausstehenden Migrationen an und liefert die Liste der
 * angewendeten Versionen. Eine Datei mit *hoeherer* Version als dieser Code
 * kennt (Rollback auf ein aelteres Image nach einem Update) wird abgelehnt,
 * statt sie mit einem veralteten Schema weiterzubenutzen — dann das neuere
 * Image starten oder ein Backup von vor dem Update zurueckspielen.
 */
function applyMigrations(db, migrations = MIGRATIONS) {
    const target = migrations.reduce((max, m) => Math.max(max, m.version), 0);
    const current = schemaVersion(db);
    if (current > target) {
        const err = new Error(
            `Datenbank-Schema ist Version ${current}, diese App-Version kennt nur bis ${target}. `
            + 'Die Datenbank stammt von einer neueren Version — bitte diese starten oder ein '
            + 'Backup von vor dem Update wiederherstellen.'
        );
        err.code = 'schema_too_new';
        throw err;
    }
    const applied = [];
    for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
        if (migration.version <= current) continue;
        db.exec('BEGIN IMMEDIATE');
        try {
            migration.up(db);
            // PRAGMA nimmt keine Parameter — version ist eine Zahl aus dem
            // Code, nie Nutzereingabe
            db.exec(`PRAGMA user_version = ${Number(migration.version)}`);
            db.exec('COMMIT');
        } catch (err) {
            db.exec('ROLLBACK');
            err.message = `Migration ${migration.version} (${migration.name}) fehlgeschlagen: ${err.message}`;
            throw err;
        }
        applied.push(migration.version);
    }
    return applied;
}

/*
 * Regelmaessige Pflege (aus server.js stuendlich aufgerufen): PRAGMA optimize
 * aktualisiert bei Bedarf die Statistiken des Query-Planers, ein passiver
 * WAL-Checkpoint haelt die -wal-Datei klein, ohne auf Leser zu warten.
 */
function maintainDatabase(db) {
    db.exec('PRAGMA optimize');
    db.exec('PRAGMA wal_checkpoint(PASSIVE)');
}

/* Synchron wie DatabaseSync selbst — laeuft einmal beim App-Aufbau, nie in
   einem Request-Handler. ':memory:' (Tests) braucht kein Verzeichnis. */
function openDatabase(file, { migrations = MIGRATIONS } = {}) {
    if (file !== ':memory:') {
        fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    const db = new DatabaseSync(file);
    try {
        db.exec(PRAGMAS);
        db.exec(SCHEMA);
        db.exec(TICKET_SCHEMA);
        applyMigrations(db, migrations);
    } catch (err) {
        db.close();
        throw err;
    }
    return db;
}

module.exports = {
    openDatabase, applyMigrations, maintainDatabase, schemaVersion, MIGRATIONS, SCHEMA_VERSION,
};
