# Ticketsystem

Ein selbst gehostetes, schlankes Helpdesk-/Ticketsystem mit Kundenportal, Wissensdatenbank, E-Mail-Anbindung (SMTP + IMAP) und einem Admin-Bereich mit Posteingang, SLA-Fristen, Berichten und Event-Log.

Kunden registrieren sich im Portal, eröffnen Tickets (im Browser oder per E-Mail), hängen Dateien an und verfolgen den Verlauf. Das Support-Team bearbeitet alles in einem Posteingang mit Ansichten, Filtern, Sammelaktionen, internen Notizen, Textbausteinen, Wiedervorlage, Zusammenführen und Aufteilen von Tickets.

---

## Inhalt

1. [Funktionen](#funktionen)
2. [Technologien](#technologien)
3. [Voraussetzungen](#voraussetzungen)
4. [Installation](#installation)
5. [Umgebungsvariablen](#umgebungsvariablen)
6. [Datenbank](#datenbank)
7. [Lokal starten](#lokal-starten)
8. [Production-Build & Deployment](#production-build--deployment)
9. [Tests](#tests)
10. [Projektstruktur](#projektstruktur)
11. [Sicherheit](#sicherheit)

---

## Funktionen

**Kundenportal** (`/support`, `/account/*`)
- Registrierung mit E-Mail-Bestätigung, Login, „Passwort vergessen“, E-Mail-Adresse ändern
- Tickets anlegen mit Kategorie, Dringlichkeit und bis zu 5 Anhängen (Drag & Drop, Screenshots einfügen)
- Ticketverlauf mit Live-Updates, Antworten, „Problem gelöst“, Zufriedenheitsbewertung (CSAT)
- Benachrichtigungs-Einstellungen, vollständiger Datenexport (DSGVO) und Konto-Löschung
- Wissensdatenbank mit Suche, Artikelvorschlägen beim Anlegen eines Tickets und anonymem Hilfreichkeits-Feedback

**Admin-Bereich** (`/admin*`)
- **Dashboard** mit Kennzahlen, jüngsten Tickets, Sicherheit (Passkeys, TOTP, Audit-Log), Backups und Konto
- **Posteingang**: Ansichten (neu, offen, wartend, überfällig, Wiedervorlage, ungelesen …), Volltextsuche, Filter, Sortierung, Paginierung, Sammelaktionen sowie „Meine“ und nicht zugewiesene Tickets
- **Ticket-Detail**: Antworten und interne Notizen mit Anhängen, Textbausteine, vorbelegte Anrede/Grußformel, Status/Priorität/Kategorie/Tags, Bearbeiter, Wiedervorlage, Zusammenführen und Aufteilen, Zeitleiste
- **Ticket-Status**: `new` → `pending` ⇄ `open` → `resolved` → `closed`
- **SLA**: Fristen für Erst- und Folgeantwort je Priorität, Ansicht „überfällig“, einmalige Benachrichtigung bei Überschreitung
- **Automatik**: Erinnerung an Kunden, automatisches Lösen und Schließen nach einstellbaren Fristen
- **Kundenverwaltung**: freischalten, sperren, löschen, Tickets eines Kunden
- **Einstellungen**: Kategorien, Textbausteine, Automatik-Fristen, SLA, Grußformel, Mail-Outbox und IMAP-Status
- **Wissensdatenbank-Editor** (Markdown, Vorschau, Entwürfe)
- **Berichte**: Ticketaufkommen, Antwort-/Lösungszeiten, SLA-Quote, CSAT, Verteilungen sowie KB-Hilfreichkeitsquote, Suchlücken, Vorschlagsklicks und Übergänge zur Ticketerstellung
- **Event-Log** (`/admin/logs`): alle Ereignisse mit Filtern, Diagrammen, Volltextsuche und CSV/JSON-Export
- **Datenbank-Backups** mit Zeitplan, Download und Wiederherstellung
- **REST API v1 und Webhooks**: scoped Bearer-Tokens, vollständige Integrationsendpunkte, admin-geschützte Swagger UI unter `/api/docs` sowie persistente, HMAC-signierte Zustellungen mit Wiederholungen (siehe [API.md](API.md))

**E-Mail**
- Ausgehende Mails über eine persistente Outbox mit Wiederholungen (HTML + Text, Hell/Dunkel, Outlook-kompatibel)
- Antworten der Kunden per Mail landen im Ticket (IMAP, signierte Thread-Referenzen)
- Optional neue Tickets per Mail (nur mit DKIM/DMARC-Prüfung)

**Rollen und Berechtigungen**
- **Owner**: bisheriges Admin-Konto mit Passwort-Login, optionalem TOTP oder Passkey (WebAuthn) und Verwaltung des Support-Teams
- **Administratoren**: eigene Zugänge; Team, Systemeinstellungen, Backups und Logs verwalten
- **Agenten**: eigene Zugänge; Tickets, Kunden, Wissensdatenbank und Berichte bearbeiten, aber keine Systemkonfiguration oder endgültigen Löschungen
- Antworten und interne Notizen werden dem tatsächlichen Support-Nutzer zugeordnet; deaktivierte Zugänge verlieren sofort den Zugriff
- **Kunden**: eigene Konten, sehen ausschließlich ihre eigenen Tickets und nie interne Notizen

## Technologien

| Bereich | Technologie |
|---|---|
| Laufzeit | Node.js ≥ 22.13 (Produktionsimage: 26) |
| Web-Framework | Express 5 |
| Templates | EJS (serverseitiges Rendering) |
| Datenbank | SQLite über das eingebaute `node:sqlite` (keine externe DB nötig) |
| Sessions | `express-session` mit eigenem SQLite-Store |
| Sicherheit | `helmet` (CSP), `express-rate-limit`, `scrypt`, `@simplewebauthn/server` (Passkeys), TOTP selbst implementiert |
| Uploads | `multer` (Ticket-Anhänge, Typprüfung per Magic Bytes) |
| E-Mail | `nodemailer` (SMTP), `imapflow` (IMAP) |
| Frontend | Bootstrap 6.0.0-alpha.1, anwendungsspezifisches CSS und kleine Vanilla-JS-Module; lokal ausgeliefert, kein CDN und kein Build-Schritt |
| Tests | Eingebauter Node-Test-Runner (`node --test`) |
| Deployment | Docker, Docker Compose, optional Caddy für TLS |

## Voraussetzungen

- **Node.js 22.13 oder neuer** (getestet mit 22, 24 und 26) und npm
- **Browser:** Chrome/Edge 130+, Firefox 132+ oder Safari 18+ (Bootstrap 6).
- Optional: **Docker** und **Docker Compose** für den Produktivbetrieb
- Optional: SMTP-Zugang (Mailversand) und IMAP-Postfach (Antworten per Mail)

## Installation

Bootstrap ist exakt auf `6.0.0-alpha.1` festgelegt. Die Alpha kann sich vor der
stabilen Veröffentlichung noch ändern. CSS und das ESM-Bundle werden direkt
aus dem installierten npm-Paket über zwei feste `/vendor/bootstrap/`-Routen
mit Inhalts-Hash ausgeliefert; es gibt keine CDN-Anfragen. `tokens.css` bindet
die Ticket-Komponenten an die Bootstrap-Variablen an. Bei Bootstrap-Updates
Kundenportal, Adminbereich, Dialoge sowie beide Farbschemata prüfen.

```bash
git clone <repository-url> ticket-system
cd ticket-system
npm install
```

## Umgebungsvariablen

Alle Einstellungen werden über Umgebungsvariablen gesetzt. Für die lokale Entwicklung genügt eine `.env`-Datei im Projektordner, die beim Start automatisch gelesen wird (bereits gesetzte Variablen haben Vorrang):

```bash
cp .env.example .env
```

Ohne weitere Angaben startet die App sofort lokal — alle Variablen sind optional. Die wichtigsten:

| Variable | Default | Beschreibung |
|---|---|---|
| `APP_NAME` | `Ticketsystem` | Anzeigename in Navigation, Titeln, Mails und Authenticator-App |
| `PORT` | `3000` | HTTP-Port |
| `DATA_DIR` | `./data` | Datenbank, Event-Log, Backups, Anhänge |
| `PUBLIC_URL` | `http://localhost:PORT` | Basis-URL für Links in Mails (in Produktion **https** und Pflicht, sobald SMTP aktiv ist) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / zufällig | Nur beim allerersten Start gelesen (siehe unten) |
| `SESSION_SECRET` | zufällig | Nur beim allerersten Start gelesen |
| `NODE_ENV` | – | `production` aktiviert strenge Konfigurationsprüfungen |
| `TRUST_PROXY` | – | Anzahl Proxy-Hops (Pflicht in Produktion hinter Reverse Proxy) |
| `APP_TIMEZONE` | `Europe/Berlin` | Anzeige-Zeitzone (gespeichert wird UTC) |
| `SMTP_*`, `TICKET_NOTIFY_EMAIL` | – | Mailversand; ohne `SMTP_HOST` ist er aus. `TICKET_NOTIFY_EMAIL` ist der Anfangswert für Admin-Mails; Empfänger und Ereignisse lassen sich danach unter „Einstellungen & E-Mail“ ändern. |
| `IMAP_*`, `SUPPORT_REPLY_TO` | – | Antworten per Mail; ohne `IMAP_HOST` aus |
| `TICKET_ATTACHMENT_MAX_MB` | `10` | Maximale Größe je Anhang |
| `*_RETENTION_DAYS` | 90 / 30 / 0 | Löschfristen (Audit-Log, unbestätigte Konten, geschlossene Tickets) |
| `METRICS_TOKEN` | – | Schützt `/metrics` per Bearer-Token |

Die vollständige, kommentierte Liste steht in [`.env.example`](.env.example).

**Bootstrap-once:** `ADMIN_PASSWORD`, `ADMIN_USERNAME` und `SESSION_SECRET` werden nur beim allerersten Start gelesen und dann in der Datenbank gespeichert. Danach gilt dauerhaft der Wert aus der Datenbank; Passwort und Benutzername ändert man unter `/admin` → „Konto“. Ist `ADMIN_PASSWORD` beim ersten Start leer, wird ein zufälliges Passwort erzeugt und **einmalig** in der Konsole ausgegeben.

> Niemals echte Zugangsdaten committen — `.env` ist per `.gitignore` ausgeschlossen.

## Datenbank

Es ist **keine Einrichtung nötig**. Beim Start wird automatisch eine SQLite-Datenbank unter `DATA_DIR/ticket-system.db` angelegt (WAL-Modus), alle Tabellen werden erstellt und ausstehende Migrationen angewendet. Das Event-Log liegt in einer eigenen Datei `DATA_DIR/events.db`, Ticket-Anhänge unter `DATA_DIR/ticket-attachments/`.

- **Migrationen**: versioniert über `PRAGMA user_version` in `lib/db.js` (`MIGRATIONS`, nur anhängen, nie bestehende ändern). Neue Tabellen können als `CREATE TABLE IF NOT EXISTS` ins Schema; Änderungen an bestehenden Tabellen gehören in eine neue Migration.
- **Backups**: im Admin-Dashboard („Backups“) manuell oder per Zeitplan; Details in [OPERATIONS.md](OPERATIONS.md).
- **Datenbank ansehen** (auch im laufenden Betrieb, nur lesend):

  ```bash
  node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('./data/ticket-system.db', { readOnly: true });
  console.log(db.prepare('SELECT number, subject, status FROM tickets').all());
  db.close();
  "
  ```

  Alternativ mit „DB Browser for SQLite“ (schreibgeschützt öffnen).

## Lokal starten

```bash
npm start          # oder: npm run dev (Neustart bei Dateiänderungen)
```

- Kundenportal: <http://localhost:3000/support>
- Admin-Login: <http://localhost:3000/login> (Benutzer `admin`, Passwort aus der Konsole bzw. `ADMIN_PASSWORD`)
- Health-Check: <http://localhost:3000/healthz>

Ohne SMTP werden keine Mails verschickt; neue Kundenkonten schaltet der Admin dann unter `/admin/customers` frei.

## Production-Build & Deployment

Das Projekt braucht **keinen Build-Schritt** (kein Bundler, kein Transpiler) — Templates werden serverseitig gerendert, eigene CSS/JS-Dateien aus `public/` und Bootstrap-Dateien aus dem npm-Paket ausgeliefert, jeweils per Inhalts-Hash versioniert. „Production-Build“ heißt hier: Abhängigkeiten ohne Dev-Pakete installieren bzw. das Docker-Image bauen.

**Mit Docker (empfohlen):**

```bash
cp .env.example .env && chmod 600 .env    # DOMAIN, PUBLIC_URL, TRUST_PROXY=1 usw. ausfüllen
docker compose build                       # Image bauen
docker compose --profile tls up -d         # App + Caddy (automatisches TLS)
docker compose logs -f ticket-system
```

**Ohne Docker:**

```bash
npm ci --omit=dev
NODE_ENV=production TRUST_PROXY=1 PUBLIC_URL=https://support.example.com node server.js
```

Die App muss hinter einem Reverse Proxy mit TLS laufen (Node terminiert kein TLS). Im Produktivmodus verweigert sie den Start bei unsicherer Konfiguration und nennt alle Probleme auf einmal. Go-live-Checkliste, Backups, Monitoring und Notfälle: [OPERATIONS.md](OPERATIONS.md).

## Tests

```bash
npm test               # Unit- und Integrationstests
npm run test:coverage  # Tests plus Mindestwerte fuer Lines/Branches/Functions
npm run lint           # ESLint: statische Analyse aller JavaScript-Dateien
npm run check:syntax   # schneller Syntax-Check mit node --check
```

Die Integrationstests starten echte Instanzen auf zufälligen Ports mit temporären Verzeichnissen und einem Fake-Mailtransport — es wird weder ein Mailserver noch eine externe Datenbank benötigt. Die Coverage-Grenzen liegen bei 90 % Lines, 75 % Branches und 85 % Functions. Die GitHub-Actions-Pipeline (`.github/workflows/node.js.yml`) führt Syntaxprüfung, ESLint und Coverage-Tests auf Node 22, 24 und 26 aus, baut das Docker-Image, macht einen Smoke-Test, scannt es mit Trivy und archiviert eine CycloneDX-SBOM.

Ein nicht-destruktiver Lasttest gegen eine laufende Instanz ist ebenfalls enthalten:

```bash
npm run loadtest
# Anpassbar: LOAD_TEST_URL, LOAD_TEST_SECONDS, LOAD_TEST_CONCURRENCY,
# LOAD_TEST_PATHS, LOAD_TEST_COOKIE und LOAD_TEST_MAX_P95_MS
npm run loadtest:local # isolierte Wegwerf-Instanz, standardmäßig 5 Sekunden
```

## Projektstruktur

```text
ticket-system/
├── server.js                 # App-Aufbau: Middleware, Admin-Login und Router-Komposition
├── lib/
│   ├── db.js                 # SQLite-Schema und Migrationen
│   ├── db-tx.js              # verschachtelbare Transaktionen
│   ├── ticket-store.js       # Tickets, Nachrichten, Status, SLA, Ansichten, Merge/Split, Wiedervorlage
│   ├── customer-store.js     # Kundenkonten und Einmal-Tokens
│   ├── ticket-config-store.js# Kategorien, Textbausteine, Automatik, SLA, Grußformel
│   ├── attachment-store.js   # Anhänge (Magic-Byte-Prüfung, atomares Speichern)
│   ├── kb-store.js, markdown.js
│   ├── ticket-automation.js, ticket-reports.js, snooze.js, reply-template.js
│   ├── mailer.js, mail-outbox.js, mail-templates.js, ticket-mail.js
│   ├── imap-poller.js, mail-inbound.js, mail-auth.js, inbound-mail-store.js
│   ├── session-store.js, session-secret-store.js, password-store.js, username-store.js, support-user-store.js
│   ├── totp.js, totp-store.js, webauthn-store.js
│   ├── event-store.js, event-catalog.js, audit-log.js, logger.js
│   ├── backup-store.js, retention.js, lifecycle.js, runtime-jobs.js, config-check.js, time.js, disk.js
│   ├── safe-name.js          # zentrale Eingabevalidierung
│   └── routes/               # Fachrouter inkl. account, tickets, backups, ops, kb und event-log
├── views/                    # EJS-Templates (Kundenportal, Admin, Partials)
├── public/                   # CSS-Designsystem, Browser-Skripte, Favicon
├── test/                     # Unit- und Integrationstests
├── scripts/check-syntax.js   # npm run lint
├── Dockerfile, docker-compose.yml, Caddyfile
├── .env.example, .gitignore, .dockerignore
└── OPERATIONS.md             # Betriebshandbuch
```

## Sicherheit

- **Strikte CSP** (nur `'self'`, keine Inline-Skripte), `frame-ancestors 'none'`, `nosniff`, HSTS in Produktion
- **CSRF**: `SameSite=strict`-Cookie plus Origin/Referer-Prüfung bei jeder schreibenden Anfrage
- **Sessions** in SQLite, `httpOnly`, `secure` hinter Proxy, Neuvergabe beim Login, Admin-Idle-Timeout
- **Passwörter** mit `scrypt`; Login-Rate-Limits pro IP plus globaler Backstop; keine Benutzer-Enumeration
- **Zwei-Faktor**: TOTP mit Recovery-Codes oder Passkeys (WebAuthn)
- **Kundendaten getrennt**: Kunden sehen nur eigene Tickets; fremde Tickets sind nicht von nicht vorhandenen zu unterscheiden
- **Anhänge**: Typ nur per Magic Bytes, kein SVG/HTML, Auslieferung mit `nosniff` und Sandbox-CSP
- **Mail**: Links nur aus `PUBLIC_URL` (kein Host-Header-Poisoning), eingehende Antworten nur mit HMAC-signierter Thread-Referenz, neue Tickets per Mail nur mit DKIM/DMARC
- **Datenschutz**: konfigurierbare Löschfristen, die in der Datenschutzerklärung automatisch angezeigt werden; das Event-Log speichert keine Query-Strings, Passwörter oder Tokens

Impressum (`views/imprint.ejs`) und Datenschutzerklärung (`views/privacy.ejs`) enthalten betreiberspezifische Angaben, die vor dem Go-live rechtlich und inhaltlich geprüft werden müssen.

## Lizenz

ISC (siehe `package.json`). Bei Bedarf vor der Veröffentlichung eine eigene `LICENSE`-Datei ergänzen.
