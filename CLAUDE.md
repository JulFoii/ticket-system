# CLAUDE.md

Hinweise für Claude Code (claude.ai/code) zur Arbeit in diesem Repository. Überblick, Setup und Funktionen: `README.md`; Betrieb: `OPERATIONS.md`.

## Befehle

```bash
npm install
npm start            # http://localhost:3000/support, Admin unter /login
npm test             # node --test test/*.test.js (Unit + Integration, echte Instanzen auf Zufallsports)
npm run test:coverage # Tests mit verbindlichen Coverage-Grenzen
npm run lint         # ESLint auf allen .js-Dateien
npm run check:syntax # node --check auf allen .js-Dateien
```

## Architektur

- **Node ≥ 22.5, Express 5, EJS**, serverseitiges Rendering, Bootstrap **6.0.0-alpha.1**, kein Build-Schritt. Kurze Abhängigkeitsliste ist Absicht — neue Dependencies nur mit gutem Grund.
- **`server.js`**: schlanker Composition Root; `createApp(options)` verdrahtet Datenbank, Services, HTTP-Module, Routen und Lifecycle. Konfigurationsauflösung liegt in `lib/app-config.js`, Store-/Mail-/Job-Komposition in `lib/app-services.js`, HTTP-Querschnitt in `lib/http/` und Admin-Login/Passkey/TOTP in `lib/routes/admin-security.js`. Backup-/Restore-Routen liegen in `lib/routes/backups.js`, Health/Metriken in `lib/routes/ops.js`, Hintergrundtimer in `lib/runtime-jobs.js`. Optionen überschreiben Env-Vars (Tests nutzen das).
- **Datenbank**: eine SQLite-Datei `DATA_DIR/ticket-system.db` über `node:sqlite` (`DatabaseSync`, synchron, einmal beim App-Aufbau geöffnet). Schema und Migrationen in `lib/db.js`: Migrationen sind eine nummerierte, nur anzuhängende Liste (`PRAGMA user_version`); Änderungen an bestehenden Tabellen immer als neue Migration. Das Event-Log liegt separat in `DATA_DIR/events.db` (`lib/event-store.js`).
- **Stores** in `lib/` kapseln je eine Tabellengruppe (`ticket-store`, `customer-store`, `ticket-config-store`, `attachment-store`, `kb-store`, `mail-outbox`, …). Reine Ticket-Domänenwerte, SQL-Ansichten und Row-Mapper liegen in `lib/tickets/model.js`; Event-Redaktion und -Serialisierung in `lib/events/format.js`. `lib/db-tx.js` liefert verschachtelbare Transaktionen; `attachment-store.commit()` schreibt Ticket/Nachricht und Anhänge atomar.
- **Routen**: `lib/routes/account.js` (Kundenkonten, `loadCustomer`/`checkCustomer`), `admin-security.js`, `tickets-customer.js`, `tickets-admin.js`, `kb.js`, `reports.js`, `event-log.js`; gemeinsame Helfer in `helpers.js`. HTTP-Autorisierung, CSRF, Rate-Limits und View-Setup liegen getrennt in `lib/http/`.
- **Mail**: alles Ausgehende über die Outbox (`lib/mail-outbox.js`, asynchron mit Retry); Inhalte in `lib/ticket-mail.js`/`lib/mail-templates.js`; Eingang per IMAP (`lib/imap-poller.js` → `lib/mail-inbound.js`, DKIM/DMARC-Prüfung in `lib/mail-auth.js`).
- **Zeit**: gespeichert wird UTC (Epoch-ms); Anzeige nur über `lib/time.js` (`APP_TIMEZONE`) bzw. die `app.locals`-Formatierer — nie `toLocaleString()` in Views.
- **Logging**: `lib/logger.js` (Konsole bewusst knapp) + Event-Log. Audit-Ereignisse über `auditLog.log(event, detail)`; nie Passwörter, Tokens oder Nachrichtentexte loggen.

## Frontend-Konventionen

- Bootstrap 6: `btn-solid theme-primary`, `btn-outline theme-secondary`, `btn-text theme-danger`; Eingaben und Selects verwenden `form-control`. Keine Bootstrap-5-Klassen übernehmen. Die npm-Distribution wird lokal über zwei feste `/vendor/bootstrap/`-Routen mit Asset-Hashes ausgeliefert; JavaScript ist ESM. `tokens.css` verwendet Bootstrap-Variablen; eigene Komponenten heißen bei Namenskollisionen `app-*`. Theme-Wechsel synchronisieren `data-theme` und `data-bs-theme`.

- Skripte/Styles immer über `asset('/js/x.js')` einbinden (Cache-Busting per Inhalts-Hash).
- Browser-Skripte in `public/js/` sind kleine IIFEs, deklarativ über `data-*`-Attribute verdrahtet.
- **Live-Updates**: Seiten mit `<body data-live-page>` werden von `live-regions.js` alle 20 s neu abgefragt (Header `X-Idle-Background: 1`, verlängert den Admin-Idle-Timeout nicht); jeder `[data-live-region="key"]` wird ersetzt, wenn sich das Server-Markup geändert hat und niemand darin arbeitet. Ein Bereich muss auch leer im Markup stehen. `live-regions.js` vor den anderen Skripten einbinden. Seiten, die auch aus einem POST-Fehlerpfad gerendert werden, brauchen `data-live-url`.
- Bestätigungen nur über `public/js/confirm.js` (`data-confirm` bzw. `window.appConfirm()`), nie `window.confirm()`.
- CSP verbietet Inline-Skripte und -Styles.

## Sicherheit (beim Ändern erhalten)

- CSRF: `SameSite=strict` + Origin/Referer-Check für POST/PUT/PATCH/DELETE.
- Admin (`req.session.loggedIn`, `checkAuth`) und Kunden (`req.session.customerId`, `checkCustomer`) sind getrennte Vertrauensgrenzen; beide Logins rufen `session.regenerate()`.
- Kunden sehen nur eigene Tickets (`getForCustomer()`), interne Notizen nie.
- Jede ID/jeder Name aus einer Anfrage läuft durch `lib/safe-name.js`.
- Links in Mails nur aus `PUBLIC_URL`, nie aus dem `Host`-Header.
- Wissensdatenbank-HTML entsteht ausschließlich in `lib/markdown.js` (erst escapen, dann Tags) — die einzige Stelle mit `<%- %>` für Nutzertext.
- Im Produktivmodus verweigert `lib/config-check.js` den Start bei unsicherer Konfiguration — Fehler nicht zu Warnungen herabstufen.
- Löschfristen erscheinen automatisch in `views/privacy.ejs` (`app.locals.retentionPolicy`/`eventRetention()`); neue Fristen dort ebenfalls anzeigen.
