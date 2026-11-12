'use strict';

const { suppressUnusedWebauthnExperimentalWarnings } = require('./lib/runtime-warnings');
suppressUnusedWebauthnExperimentalWarnings();

const express = require('express');
const multer = require('multer');
const session = require('express-session');
const helmet = require('helmet');
const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');

const { safeCredentialId, safePasskeyLabel, safeUsername } = require('./lib/safe-name');
const { openDatabase } = require('./lib/db');
const { createShutdown, installProcessHandlers } = require('./lib/lifecycle');
const APP_VERSION = require('./package.json').version;
const { createSessionSecretStore } = require('./lib/session-secret-store');
const { createPasswordStore } = require('./lib/password-store');
const { createUsernameStore } = require('./lib/username-store');
const { createSupportUserStore, OWNER_ID } = require('./lib/support-user-store');
const { sweepTmpDir } = require('./lib/disk');
const { createRuntimeJobs } = require('./lib/runtime-jobs');
const { registerAccountRoutes, createCustomerAuth } = require('./lib/routes/account');
const { registerCustomerTicketRoutes } = require('./lib/routes/tickets-customer');
const { registerAdminTicketRoutes } = require('./lib/routes/tickets-admin');
const { registerKbRoutes } = require('./lib/routes/kb');
const { registerReportRoutes } = require('./lib/routes/reports');
const { generateSecret, verifyTotp, buildOtpauthUri } = require('./lib/totp');
const { createAuditLog } = require('./lib/audit-log');
const { createEventStore, diff } = require('./lib/event-store');
const { SEVERITY, moduleForPath } = require('./lib/event-catalog');
const { registerEventLogRoutes } = require('./lib/routes/event-log');
const { registerOpsRoutes } = require('./lib/routes/ops');
const { registerBackupRoutes } = require('./lib/routes/backups');
const { registerSupportUserRoutes } = require('./lib/routes/support-users');
const { registerApiV1 } = require('./lib/routes/api-v1');
const { registerIntegrationRoutes } = require('./lib/routes/integrations');
const { registerApiDocsRoutes } = require('./lib/routes/api-docs');
const { registerAdminSecurityRoutes } = require('./lib/routes/admin-security');
const { assertConfig } = require('./lib/config-check');
const { createClock } = require('./lib/time');
const { DEFAULT_ADMIN_USERNAME, envNumber, resolveAppConfig } = require('./lib/app-config');
const { createAppServices } = require('./lib/app-services');
const { registerAssetManifest } = require('./lib/asset-manifest');
const { createRateLimiters } = require('./lib/http/rate-limiters');
const { createAdminAuthorization } = require('./lib/http/admin-auth');
const {
    createSameOriginGuard, createSupportUserLoader, rpIdAndOrigin,
} = require('./lib/http/security-middleware');
const { configureViewLocals, createFragmentRenderer } = require('./lib/http/view-support');
const { createLogger, requestLogger, childLog } = require('./lib/logger');
const {
    generateRegistrationOptions, verifyRegistrationResponse,
    generateAuthenticationOptions, verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const SESSION_COOKIE = 'ts.sid';
const TMP_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/* ==========================================================================
   App-Aufbau

   Alles laeuft ueber createApp(), damit die Tests eine Instanz mit eigenen
   Verzeichnissen und eigenem Passwort bekommen, ohne den Prozess zu starten.
   Die Umgebungsvariablen sind nur die Defaults dieser Funktion.
   ========================================================================== */

function createApp(options = {}) {
    const {
        appName, tmpDir, dataDir, minFreeDiskMb, diskInfo, retentionPolicy,
        metricsToken, maintenanceIntervalMs, isProd, trustProxy, smtpHost,
        smtpSecure, smtpPort, smtpUser, smtpPass, smtpFrom, mailTransport,
        ticketNotifyEmail, imapHost, imapSecure, imapPort, imapUser, imapPass,
        imapMailbox, imapProcessedMailbox, imapPollSeconds, supportReplyTo,
        publicUrl, attachmentMaxMb, mailAttachmentMaxMb, imapAuthservId,
        ticketAutomationIntervalMs, startMailWorkers, passwordOption,
        usernameOption, secretOption, sweepTmpUploads, log, requestLog,
        adminIdleTimeoutMs, eventsFile, eventFlushIntervalMs, timeZone,
    } = resolveAppConfig(options, { rootDir: __dirname });

    const TMP_DIR = path.resolve(tmpDir);
    const DATA_DIR = path.resolve(dataDir);
    const IDLE_TIMEOUT_MS = adminIdleTimeoutMs;

    // Im Produktivbetrieb fatal (siehe lib/config-check.js): lieber gar nicht
    // starten als Mails mit localhost-Links verschicken oder nie ein
    // Session-Cookie setzen. Laeuft vor dem Oeffnen der DB, damit ein
    // Abbruch keine offene Datei und keine Timer hinterlaesst.
    const inboundEnabled = Boolean(imapHost && imapUser);
    // Wirft bei unbekannter APP_TIMEZONE (code 'invalid_config')
    const clock = createClock(timeZone);
    assertConfig({
        isProd, publicUrl, mailEnabled: Boolean(smtpHost || mailTransport), inboundEnabled, trustProxy,
        attachmentMaxMb, mailAttachmentMaxMb, imapAuthservId, metricsToken,
    }, log);

    /*
     * Eine einzige SQLite-Datenbank fuer den gesamten Zustand (siehe
     * lib/db.js). Synchron geoeffnet, weil DatabaseSync selbst synchron ist
     * und dies nur einmal beim App-Aufbau passiert, nie in einem
     * Request-Handler.
     */
    const DB_PATH = path.join(DATA_DIR, 'ticket-system.db');

    /*
     * Zentrales Event-Log (lib/event-store.js) — vor der Haupt-DB, damit
     * schon deren Abfragen gemessen werden (langsame Abfragen, Fehler) und
     * die Konfig-Warnungen oben (vom Logger gepuffert) hier landen. Die
     * Konsole bekommt ab hier nur noch das Wesentliche, siehe lib/logger.js.
     */
    let currentAdminName = usernameOption ?? process.env.ADMIN_USERNAME ?? DEFAULT_ADMIN_USERNAME;
    const events = createEventStore({
        file: eventsFile ?? path.join(DATA_DIR, 'events.db'),
        flushIntervalMs: eventFlushIntervalMs,
        auditDays: retentionPolicy.auditLogDays,
        archiveDir: path.join(DATA_DIR, 'log-archive'),
        adminName: () => currentAdminName,
    });
    log.attachSink?.(events.fromLog);
    // Nur Konsole, nie Senke: diese Meldungen stehen schon als eigenes
    // Ereignis im Event-Log (Request-Zeilen, unbehandelte Fehler)
    const httpConsole = childLog(log, 'http', { sink: false });

    let db;
    try {
        db = events.instrumentDatabase(openDatabase(DB_PATH));
    } catch (err) {
        log.detachSink?.();
        events.close();
        throw err;
    }

    /* ----------------------------------------------------------- Secrets --
       Bootstrap-Prinzip (siehe auch der Kommentar oben in lib/db.js): der aus
       Env-Var/Option berechnete Wert wird beim allerersten Start persistiert
       und gewinnt danach dauerhaft — eine spaeter geaenderte Env-Var wirkt
       sich nicht mehr aus, dieselbe Regel wie bei einer expliziten Aenderung
       ueber die Admin-UI. Ein Geheimnis, das dauerhaft in einer Env-Var
       steht, ist im Produktivbetrieb die schlechtere Aufbewahrung als die DB. */

    const ADMIN_PASSWORD = passwordOption ?? process.env.ADMIN_PASSWORD;
    /*
     * Der Session-Signierschluessel wird SYNCHRON persistiert, weil er noch
     * vor app.use(session(...)) unten feststehen muss — also vor dem
     * asynchronen start(). Erster Start: der aus SESSION_SECRET/Option
     * berechnete oder frisch generierte Wert wird sofort in die DB
     * geschrieben. Jeder weitere Start liest denselben Wert zurueck, egal was
     * SESSION_SECRET inzwischen sagt — ohne das wuerde ein Neustart ohne
     * gesetzte Env-Var alle Sitzungen ungueltig machen.
     */
    const sessionSecretStore = createSessionSecretStore({ db });
    let SESSION_SECRET = sessionSecretStore.read();
    if (!SESSION_SECRET) {
        const candidate = secretOption ?? process.env.SESSION_SECRET
            ?? crypto.randomBytes(32).toString('hex');
        if (!secretOption && !process.env.SESSION_SECRET) {
            log.warn(
                '⚠️  Kein SESSION_SECRET gesetzt — es wird jetzt einmalig ein zufälliges\n' +
                '    erzeugt und dauerhaft in der Datenbank gespeichert.\n'
            );
        }
        SESSION_SECRET = sessionSecretStore.ensure(candidate);
    }

    const passwordStore = createPasswordStore({ db });
    const usernameStore = createUsernameStore({ db });
    const supportUserStore = createSupportUserStore({ db });

    /*
     * ADMIN_USERNAME bleibt der Default/die Env-Var, bis start() (siehe
     * unten) den ersten Wert in die DB schreibt oder /admin-username ihn
     * explizit aendert — danach gewinnt in beiden Faellen die DB.
     */
    const ADMIN_USERNAME = usernameOption ?? process.env.ADMIN_USERNAME ?? DEFAULT_ADMIN_USERNAME;

    /* --------------------------------------------------------- Dienste -- */

    const {
        apiTokenStore, attachmentStore, auditLog, backupStore, configStore, customerStore,
        imapPoller, inboundProcessor, inboundStore, kbStore, mailer, notificationStore, outbox,
        retention, sessionStore, supportSecurityMail, ticketAutomation, ticketMail, ticketStore,
        totpStore, webauthnStore, webhookService, publicUrl: PUBLIC_URL,
        backupDir: BACKUP_DIR, inboundNewTickets,
    } = createAppServices({
        db, events, dataDir: DATA_DIR, tmpDir: TMP_DIR, publicUrl, ticketNotifyEmail,
        attachmentMaxMb, minFreeDiskMb, diskInfo, smtpHost, smtpPort, smtpSecure,
        smtpUser, smtpPass, smtpFrom, mailTransport, clock, appName, supportReplyTo,
        sessionSecret: SESSION_SECRET, inboundEnabled, mailAttachmentMaxMb,
        imapAuthservId, imapHost, imapPort, imapSecure, imapUser, imapPass,
        imapMailbox, imapPollSeconds, imapProcessedMailbox, retentionPolicy,
        createAuditLog, log,
    });
    const app = express();

    /* ------------------------------------------- Sicherheits-Middleware -- */

    app.disable('x-powered-by');

    // Zuerst, damit auch von spaeteren Middlewares abgelehnte Requests
    // (CSRF, Rate-Limit) im Log stehen und eine Request-ID haben
    if (requestLog) app.use(requestLogger(httpConsole, { onFinish: events.recordRequest }));
    // Request-Kontext fuer das Event-Log (Akteur, IP, User-Agent, Session-
    // Hash), ohne ihn durch jede Funktion reichen zu muessen
    app.use(events.middleware());

    // Hinter einem Reverse Proxy (TLS-Terminierung) korrekt Secure-Cookies
    // setzen. Eine reine Zahl muss als Number uebergeben werden (Anzahl Hops)
    // — als String interpretiert Express sie sonst als Adressliste, und
    // req.secure bliebe false.
    if (trustProxy) {
        app.set(
            'trust proxy',
            /^\d+$/.test(String(trustProxy)) ? Number(trustProxy) : trustProxy
        );
    }

    // Security-Header inkl. CSP. Alles wird selbst gehostet, daher 'self';
    // data: nur fuer das Grain-SVG und das Favicon; keine Inline-Skripte.
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'"],
                imgSrc: ["'self'", 'data:'],
                fontSrc: ["'self'"],
                connectSrc: ["'self'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'"],
                frameAncestors: ["'none'"],
                upgradeInsecureRequests: isProd ? [] : null,
            },
        },
        hsts: isProd,
        crossOriginResourcePolicy: { policy: 'same-origin' },
        // same-origin: eigene Requests behalten den Referer (dient dem
        // CSRF-Check als Fallback), zu fremden Seiten wird nichts geleakt.
        referrerPolicy: { policy: 'same-origin' },
    }));

    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));
    app.locals.appName = appName;
    // In jedem render() verfuegbar, ohne dass jede Route sie einzeln
    // durchreichen muss — public/js/idle-timer.js liest sie ueber
    // partials/navbar.ejs aus dem Abmelden-Link.
    app.locals.adminIdleTimeoutMs = IDLE_TIMEOUT_MS;
    // Fuer die Datenschutzerklaerung — zeigt die tatsaechlich wirksamen Fristen
    app.locals.retentionPolicy = retention.policy;
    // Fristen des Event-Logs (zur Laufzeit unter /admin/logs/settings
    // aenderbar, darum eine Funktion statt eines festen Werts)
    app.locals.eventRetention = function eventRetention() {
        const settings = events.readSettings();
        // DEBUG zaehlt nur, wenn es ueberhaupt gespeichert wird
        const days = [
            ...(settings.storeDebug ? [settings.debugDays] : []),
            settings.infoDays, settings.warningDays, settings.errorDays, settings.criticalDays,
        ];
        const active = days.filter(value => value > 0);
        return {
            min: active.length > 0 ? Math.min(...active) : null,
            // null: mindestens eine Stufe ist unbefristet (0 = nie loeschen)
            max: active.length === days.length ? Math.max(...active) : null,
            info: settings.infoDays,
            archiveDays: settings.archiveEnabled && settings.archiveDays > 0 ? settings.archiveDays : null,
        };
    };

    // Nur public/ statisch ausliefern. Ticket-Anhaenge liegen unter DATA_DIR
    // und gehen ausschliesslich ueber /attachments/:id mit Rechtepruefung raus.
    app.use(express.static(path.join(__dirname, 'public'), {
        maxAge: '1h',
        dotfiles: 'ignore',
    }));

    registerAssetManifest({ app, rootDir: __dirname });

    // Bewusst kleine Body-Limits — Formulare und kleine JSON-Koerper. Anhaenge
    // kommen als multipart/form-data und gehen an multer, nicht hierher.
    app.use(express.urlencoded({ extended: false, limit: '16kb' }));
    app.use(express.json({ limit: '16kb' }));

    app.use(session({
        name: SESSION_COOKIE,
        secret: SESSION_SECRET,
        store: sessionStore,
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            // sameSite:'strict' blockiert das Mitsenden bei Cross-Site-
            // Requests und ist damit die primaere CSRF-Abwehr.
            sameSite: 'strict',
            // Secure sobald prod oder hinter Proxy — sonst waere lokal ohne
            // TLS gar kein Login moeglich.
            secure: isProd || Boolean(trustProxy),
            maxAge: 1000 * 60 * 60 * 24,
        },
    }));

    app.use(createSupportUserLoader({ supportUserStore, ownerId: OWNER_ID }));
    app.use(createSameOriginGuard({ auditLog }));

    /* Kunden-Session fuer jede Anfrage aufloesen — siehe
       createCustomerAuth() in lib/routes/account.js. */
    const customerAuth = createCustomerAuth({ customerStore, ticketStore });
    app.use(customerAuth.loadCustomer);

    const {
        accountLimiters, customerLoginLimiters, loginLimiterGlobal,
        loginLimiterPerIp, pollLimiter, ticketWriteLimiters,
        ticketWritePerCustomer,
    } = createRateLimiters({ auditLog });

    configureViewLocals({ app, clock });

    const { checkAuth, requireAdmin, requireOwner } = createAdminAuthorization({
        auditLog, idleTimeoutMs: IDLE_TIMEOUT_MS, sessionCookie: SESSION_COOKIE,
    });

    const { renderNavCount, renderPartial } = createFragmentRenderer(app);

    /*
     * Gemeinsame Render-Daten fuer das Admin-Dashboard (admin.ejs) — die
     * Seite wird von GET /admin und den Fehler-Pfaden von POST
     * /admin-password, /admin-username und /admin/backup-settings gerendert,
     * alle mit denselben Grunddaten plus je einem eigenen Fehlerfeld.
     */
    async function adminPageData({
        passwordError = null, usernameError = null, backupSettingsError = null,
    } = {}) {
        const [passkeys, currentUsername, totpEnabled, auditEntries, backups] = await Promise.all([
            webauthnStore.listCredentials(),
            usernameStore.read().then(name => name ?? ADMIN_USERNAME),
            totpStore.isEnabled(),
            auditLog.read({ limit: 8 }),
            backupStore.listBackups(),
        ]);
        return {
            passkeys, currentUsername, totpEnabled, auditEntries, passwordError, usernameError,
            backups, backupSettings: backupStore.readSettings(), backupSettingsError,
            ticketStats: ticketStore.stats(),
            recentTickets: ticketStore.listTickets({ view: 'active', perPage: 6 }).tickets,
            customerCount: customerStore.countCustomers(),
            mailEnabled: mailer.enabled,
            inboundEnabled,
        };
    }

    /* ============================================================ Routen */

    // Die Startseite ist das Support-Portal (lib/routes/kb.js)
    app.get('/', (req, res) => {
        res.redirect('/support');
    });

    /*
     * Nur der Ticket-Zaehler der Navigation — fuer Seiten ohne eigenes
     * Polling (Impressum, Hilfeartikel-Editor, Event-Detail …), die ihn
     * trotzdem zeigen, sobald jemand angemeldet ist (live-regions.js).
     * Ohne checkAuth: ein Admin bekommt seinen Zaehler, ein Kunde seinen,
     * alle anderen einen leeren Bereich; lastActivity bleibt unberuehrt.
     */
    app.get('/partials/nav', pollLimiter, async (req, res, next) => {
        try {
            res.json({ regions: { 'nav-count': await renderNavCount(res) } });
        } catch (err) {
            next(err);
        }
    });

    const opsRoutes = registerOpsRoutes({
        app, db, events, metricsToken, appVersion: APP_VERSION, dataDir: DATA_DIR, dbPath: DB_PATH, diskInfo,
        backupStore, outbox, ticketStore, customerStore, attachmentStore, imapPoller, inboundProcessor,
    });

    registerAdminSecurityRoutes({
        app, loginLimiterGlobal, loginLimiterPerIp, supportUserStore, totpStore, log,
        auditLog, verifyTotp, ownerId: OWNER_ID, getCurrentAdminName: () => currentAdminName,
        checkAuth, adminPageData, requireOwner, passwordStore, usernameStore,
        adminUsername: ADMIN_USERNAME, safeUsername, diff,
        setCurrentAdminName: value => { currentAdminName = value; }, rpIdAndOrigin,
        webauthnStore, generateRegistrationOptions, appName, safePasskeyLabel,
        verifyRegistrationResponse, safeCredentialId, generateAuthenticationOptions,
        verifyAuthenticationResponse, generateSecret, buildOtpauthUri, sessionStore,
    });
    const runtimeJobs = createRuntimeJobs({
        db, events, log, tmpDir: TMP_DIR, sweepTmpUploads, tmpSweepIntervalMs: TMP_SWEEP_INTERVAL_MS,
        backupStore, startMailWorkers, outbox, imapPoller, ticketAutomation,
        ticketAutomationIntervalMs, customerStore, retention, attachmentStore, inboundStore,
        maintenanceIntervalMs, webhookService,
    });

    registerBackupRoutes({
        app, checkAuth: requireAdmin, backupStore, auditLog, events, log,
        backupDir: BACKUP_DIR, dataDir: DATA_DIR, dbPath: DB_PATH,
        adminPageData, armBackupTimer: runtimeJobs.armBackupTimer,
    });

    /*
     * Keepalive fuer public/js/idle-timer.js: wird ausschliesslich durch
     * echte Nutzeraktivitaet (Klick/Taste/Maus, dort throttled) ausgeloest,
     * nie automatisch wie das Polling der Live-Bereiche — checkAuth erneuert
     * lastActivity also tatsaechlich. Keine eigene Nutzlast, nur der
     * Seiteneffekt in checkAuth zaehlt.
     */
    app.get('/admin/ping', checkAuth, pollLimiter, (req, res) => {
        res.status(204).end();
    });

    /* ---------------------------------------------------- Ticketsystem --
       Kundenkonten, Kunden- und Admin-Sicht der Tickets, Wissensdatenbank
       und Berichte — ausgelagert nach lib/routes/. Reihenfolge wichtig:
       registerAccountRoutes() stellt checkCustomer und ein paar Helfer im
       Kontext bereit, die die anderen Module brauchen. */

    const attachmentUpload = multer({
        dest: TMP_DIR,
        // Browser schicken den Dateinamen als rohes UTF-8 ohne charset-
        // Angabe; busboys Default latin1 machte aus "Größe.png" sonst
        // "GrÃ¶Ãe.png".
        defParamCharset: 'utf8',
        limits: {
            fileSize: attachmentStore.maxBytes,
            files: attachmentStore.maxFiles,
            fields: 30,
            fieldSize: 128 * 1024,
        },
    });

    const ticketContext = {
        app, log, auditLog, sessionStore, checkAuth, requireAdmin, renderPartial, checkCustomer: customerAuth.checkCustomer,
        customerStore, ticketStore, configStore, notificationStore, attachmentStore, ticketMail, outbox, mailer, imapPoller,
        attachmentUpload, inboundEnabled, mailEnabled: mailer.enabled, notifyEmail: ticketNotifyEmail || null,
        publicUrl: PUBLIC_URL, kbStore, clock, inboundNewTickets, supportAddress: supportReplyTo || null,
        supportUserStore,
        // Fuer Routen, die Admin *oder* Kunde bedienen (/attachments/:id) und
        // darum nicht hinter checkAuth haengen: dieselbe Idle-Regel wie dort,
        // nur ohne Seiteneffekte — eine abgelaufene, aber noch nicht
        // zerstoerte Admin-Session zaehlt nicht mehr als Admin.
        isActiveAdmin: req => Boolean(req.session && req.session.loggedIn)
            && Date.now() - (req.session.lastActivity ?? Date.now()) <= IDLE_TIMEOUT_MS,
        // Fallback fuer {agent} in der Grussformel, solange kein eigener
        // Anzeigename unter /admin/ticket-settings hinterlegt ist.
        adminUsername: async () => (await usernameStore.read()) ?? ADMIN_USERNAME,
        limiters: {
            accountPerIp: accountLimiters.perIp,
            accountGlobal: accountLimiters.global,
            customerLoginPerIp: customerLoginLimiters.perIp,
            customerLoginGlobal: customerLoginLimiters.global,
            ticketWritePerIp: ticketWriteLimiters.perIp,
            ticketWriteGlobal: ticketWriteLimiters.global,
            ticketWritePerCustomer,
            poll: pollLimiter,
        },
    };
    registerAccountRoutes(ticketContext);
    registerCustomerTicketRoutes(ticketContext);
    registerAdminTicketRoutes(ticketContext);
    registerKbRoutes(ticketContext);
    registerReportRoutes(ticketContext);
    registerSupportUserRoutes({ app, requireAdmin, supportUserStore, auditLog, supportSecurityMail, sessionStore });

    registerApiV1({
        app, apiTokenStore, webhookService, ticketStore, customerStore, configStore, kbStore,
        supportUserStore, attachmentStore, ticketMail, auditLog, events, backupStore, clock,
    });
    registerIntegrationRoutes({ app, requireAdmin, apiTokenStore, webhookService, auditLog });
    registerApiDocsRoutes({ app, requireAdmin });

    /* Event-Log-Dashboard (/admin/logs*), siehe lib/routes/event-log.js */
    registerEventLogRoutes({ app, events, auditLog, checkAuth: requireAdmin, renderPartial, pollLimiter, clock });

    app.get('/logout', (req, res) => {
        // ?idle=1 kommt von public/js/idle-timer.js, wenn der clientseitige
        // Countdown abgelaufen ist (oder der Keepalive-Ping mit 401
        // antwortet) — derselbe Fall wie der serverseitige Idle-Timeout in
        // checkAuth oben, nur clientseitig erkannt. Landet daher ebenfalls
        // auf /login?idle=1 statt auf '/', sonst faehrt der Nutzer ohne jede
        // Meldung auf der oeffentlichen Startseite auf.
        const idle = req.query.idle === '1';
        if (idle) {
            auditLog.log('session_idle_timeout', { ip: req.ip });
        }
        req.session.destroy(() => {
            res.clearCookie(SESSION_COOKIE);
            res.redirect(idle ? '/login?idle=1' : '/');
        });
    });

    app.get('/privacy', (req, res) => {
        res.render('privacy', { loggedIn: Boolean(req.session && req.session.loggedIn) });
    });

    app.get('/imprint', (req, res) => {
        res.render('imprint', { loggedIn: Boolean(req.session && req.session.loggedIn) });
    });

    /* ------------------------------------------------- Fehlerbehandlung --
       Nie Stacktraces nach aussen. */

    app.use((req, res) => {
        res.status(404).send('Nicht gefunden');
    });

    app.use((err, req, res, next) => {
        events.record({
            event: 'unhandled_error', module: moduleForPath(req.path), severity: SEVERITY.ERROR,
            outcome: 'failure', error: err, req,
        });
        httpConsole.error('Unhandled error:', err, { reqId: req.id, method: req.method, path: req.path });
        if (res.headersSent) return next(err);
        if (req.path.startsWith('/api/v1/')) {
            if (err.type === 'entity.parse.failed' || err.status === 400) {
                return res.status(400).type('application/problem+json').json({
                    type: 'https://docs.ticket-system.local/problems/invalid_json',
                    title: 'Der JSON-Request ist ungültig.', status: 400, code: 'invalid_json',
                });
            }
            if (err.type === 'entity.too.large' || err.status === 413) {
                return res.status(413).type('application/problem+json').json({
                    type: 'https://docs.ticket-system.local/problems/payload_too_large',
                    title: 'Der Request ist zu groß.', status: 413, code: 'payload_too_large',
                });
            }
            if (err.code === 'email_taken') {
                return res.status(409).type('application/problem+json').json({
                    type: 'https://docs.ticket-system.local/problems/email_conflict',
                    title: 'E-Mail-Adresse ist bereits vergeben.', status: 409, code: 'email_conflict',
                });
            }
            return res.status(500).type('application/problem+json').json({
                type: 'https://docs.ticket-system.local/problems/internal_error',
                title: 'Interner Serverfehler.', status: 500, code: 'internal_error',
            });
        }
        res.status(500).send('Serverfehler');
    });

    async function start() {
        await fsp.mkdir(TMP_DIR, { recursive: true });

        // Bootstrap: existiert noch kein persistiertes Passwort, wird der
        // wirksame Wert sofort persistiert — ADMIN_PASSWORD, falls gesetzt,
        // sonst ein frisch generiertes. Ab hier gewinnt in jedem Fall die DB
        // (siehe Kommentar oben bei den Secrets); eine spaeter gesetzte oder
        // geaenderte ADMIN_PASSWORD-Env-Var hat danach keine Wirkung mehr.
        if (!(await passwordStore.read())) {
            if (ADMIN_PASSWORD) {
                await passwordStore.setPassword(ADMIN_PASSWORD);
            } else {
                const generated = crypto.randomBytes(18).toString('base64url');
                await passwordStore.setPassword(generated);
                log.warn(
                    '\n⚠️  Kein ADMIN_PASSWORD gesetzt. Einmalig generiertes Passwort ' +
                    `(dauerhaft gespeichert in ${DB_PATH}):\n` +
                    `    ${generated}\n` +
                    '    Wird bei einem Neustart NICHT erneut angezeigt. Ändern jederzeit\n' +
                    '    unter /admin (Reiter „Konto“).\n'
                );
            }
        }

        // Derselbe Bootstrap fuer den Benutzernamen: der wirksame Wert
        // (ADMIN_USERNAME/Default 'admin') wird beim ersten Start
        // persistiert, danach gewinnt die DB — genau wie beim Passwort.
        if (!(await usernameStore.read())) {
            await usernameStore.write(ADMIN_USERNAME);
        }
        currentAdminName = (await usernameStore.read()) ?? ADMIN_USERNAME;
        await supportUserStore.ensureOwner({
            username: currentAdminName,
            passwordRecord: await passwordStore.read(),
        });

        if (sweepTmpUploads) await sweepTmpDir(TMP_DIR).catch(() => {});
        if (maintenanceIntervalMs > 0) await runtimeJobs.runMaintenance();
    }

    /*
     * Timer abbauen, Datenbank schliessen. Alle Schreibvorgaenge in den
     * Stores oben sind synchrone SQLite-Operationen — es gibt nichts mehr im
     * Speicher zu puffern oder "settled" abzuwarten.
     */
    async function stop() {
        runtimeJobs.stop();
        opsRoutes.close();
        outbox.stop();
        imapPoller.stop();
        await outbox.whenIdle().catch(() => {});
        try {
            sessionStore.close();
            db.close();
        } finally {
            // Zuletzt und auch dann, wenn die Haupt-DB schon zu war (nach
            // einem Restore): schreibt die Queue weg und gibt events.db frei
            log.detachSink?.();
            events.close();
        }
    }

    return {
        app,
        start,
        stop,
        // fuer Tests und /healthz
        services: {
            db, sessionStore, webauthnStore, passwordStore, usernameStore, supportUserStore, totpStore, auditLog,
            backupStore, ticketStore, mailer, customerStore, configStore, notificationStore, attachmentStore,
            outbox, ticketMail, inboundProcessor, imapPoller, ticketAutomation, retention, events, kbStore,
            apiTokenStore, webhookService,
        },
    };
}

/* ==========================================================================
   Prozessstart — nur wenn direkt aufgerufen, nicht beim require aus Tests
   ========================================================================== */

if (require.main === module) {
    // Lokale Konfiguration aus .env laden (Node-Bordmittel, keine
    // dotenv-Dependency). Bereits gesetzte Umgebungsvariablen — etwa die von
    // docker-compose.yml — behalten Vorrang; die .env selbst landet per
    // .dockerignore nie im Image. Fehlt die Datei, laeuft alles wie bisher.
    try {
        process.loadEnvFile(path.join(__dirname, '.env'));
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error('⚠️  .env konnte nicht gelesen werden:', err.message);
        }
    }

    const PORT = process.env.PORT || 3000;
    const log = createLogger({
        format: process.env.LOG_FORMAT || undefined,
        level: process.env.LOG_LEVEL || 'info',
        // Detailmeldungen der Module (Requests, Mails, Jobs) erst ab diesem
        // Level auf der Konsole; im Event-Log (/admin/logs) stehen sie immer
        detailLevel: process.env.LOG_CONSOLE_LEVEL || 'warn',
    });

    let instance;
    try {
        instance = createApp({ log });
    } catch (err) {
        // Z. B. ungueltige Konfiguration (lib/config-check.js) oder ein zu
        // neues DB-Schema (lib/db.js) — die Meldung sagt, was zu tun ist
        log.error('Start fehlgeschlagen:', err);
        process.exit(1);
    }

    instance.start()
        .then(() => {
            const server = instance.app.listen(PORT, () => {
                log.info(`🚀 Server läuft auf Port ${PORT}`, { port: Number(PORT), version: APP_VERSION });
            });
            // Laenger als das Keep-alive des Reverse Proxys, sonst schliesst
            // Node eine Verbindung, die der Proxy gerade wiederverwenden will
            // (sporadische 502). Caddy/nginx nutzen 60 s bzw. weniger.
            server.keepAliveTimeout = 65_000;
            server.headersTimeout = 66_000;

            const shutdown = createShutdown({
                server,
                stop: () => instance.stop(),
                log,
                timeoutMs: envNumber('SHUTDOWN_TIMEOUT_MS', 30_000),
            });
            installProcessHandlers({ shutdown, log });
        })
        .catch(err => {
            log.error('Start fehlgeschlagen:', err);
            process.exit(1);
        });
}

module.exports = { createApp };
