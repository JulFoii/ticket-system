# Betriebshandbuch

Alles, was für den Produktivbetrieb des Ticketsystems nötig ist: Go-live-Checkliste, Deployment, Backups, Monitoring, Updates und Notfälle. Überblick, lokale Entwicklung und Architektur stehen in der `README.md`.

## Go-live-Checkliste

- [ ] DNS-Eintrag für die Domain zeigt auf den Server, Ports 80 und 443 sind offen, 3000 **nicht**
- [ ] `.env` aus `.env.example` angelegt, `chmod 600 .env`
- [ ] `DOMAIN`, `PUBLIC_URL` (https), `TRUST_PROXY=1` und ggf. `APP_NAME` gesetzt
- [ ] `METRICS_TOKEN` gesetzt (`openssl rand -hex 32`)
- [ ] SMTP konfiguriert und eine Testmail unter `/admin/ticket-settings` erfolgreich verschickt
- [ ] Erster Start: Admin-Passwort aus dem Log notiert (`docker compose logs ticket-system | grep 'generiertes Passwort'`) und sofort unter `/admin` → „Konto“ geändert
- [ ] Passkey **oder** TOTP für den Admin eingerichtet, Recovery-Codes offline abgelegt
- [ ] Automatische Datenbank-Sicherung unter `/admin` → „Backups“ aktiviert
- [ ] Offsite-Backup des Volumes eingerichtet (siehe unten) und **einmal testweise wiederhergestellt**
- [ ] Monitoring: `/healthz` von außen überwacht, `/metrics` gescrapt, Alerts aktiv
- [ ] Impressum (`views/imprint.ejs`) und Datenschutzerklärung (`views/privacy.ejs`) inhaltlich geprüft und die Platzhalter ersetzt: Betreiber, Mail-Anbieter als Auftragsverarbeiter, Speicherdauer der Server-Logfiles
- [ ] Löschfristen (`*_RETENTION_DAYS`) bewusst gewählt — die Datenschutzerklärung zeigt die eingestellten Werte automatisch an
- [ ] `npm run check:production` meldet keine Blocker (mit der produktiven `.env` und dem produktiven Datenverzeichnis ausführen)

## Deployment

```bash
cp .env.example .env && chmod 600 .env   # ausfüllen
docker compose --profile tls up -d --build
docker compose logs -f ticket-system
```

- **Mit mitgeliefertem Caddy** (`--profile tls`): Caddy holt das Let's-Encrypt-Zertifikat für `DOMAIN` automatisch und leitet http auf https um.
- **Mit eigenem Reverse Proxy** (nginx, Traefik, …): `docker compose up -d` startet nur die App auf `127.0.0.1:3000`. Der Proxy muss `X-Forwarded-For` **überschreiben** (nicht anhängen) und `X-Forwarded-Proto` setzen. Für Anhänge sollte das Body-Limit über `TICKET_ATTACHMENT_MAX_MB × 5` liegen (nginx: `client_max_body_size 64m;`).

- **Auf einem Mailcow-Host**: `deploy/mailcow/docker-compose.server.yml` verbindet die App zusätzlich mit Mailcows internem Docker-Netz. `deploy/mailcow/ticket-system.conf` ist ein updatefester Mailcow-nginx-vHost. Start: `docker compose -f docker-compose.yml -f deploy/mailcow/docker-compose.server.yml up -d --build`. Die Subdomain muss außerdem in Mailcows `ADDITIONAL_SAN` stehen; Details zur Zertifikatserneuerung bleiben bei Mailcow.

Die App startet im Produktivbetrieb **nicht**, wenn die Konfiguration unsicher ist (fehlendes `TRUST_PROXY`, `PUBLIC_URL` ohne https bei aktivem SMTP, …). Die Meldung im Log nennt alle Probleme auf einmal.

Vor dem Start prüft `npm run check:production` zusätzlich die `.env`, die Integrität der beiden SQLite-Datenbanken, vorhandene lokale Backups und die MFA-Abdeckung aktiver Support-Konten. Geheimnisse und personenbezogene Werte werden dabei nicht ausgegeben. Der Check ersetzt weder den externen TLS-/DNS-Test noch den Offsite-Restore-Test.

### Volume

| Pfad im Container | Inhalt | Backup |
|---|---|---|
| `/app/data` (Volume `ticket-system-data`) | SQLite-DB `ticket-system.db`, `events.db` (Event-Log), `backups/`, `ticket-attachments/`, `log-archive/` | **Pflicht** |

## Backups

Die eingebauten Sicherungen (`/admin` → „Backups“) sind konsistente Snapshots der **Datenbank** (`VACUUM INTO`). Sie liegen aber auf demselben Volume wie die Datenbank selbst und enthalten keine Ticket-Anhänge. Ein Plattendefekt nimmt sie also mit. Für den Produktivbetrieb deshalb zusätzlich das Volume außer Haus sichern, z. B. mit restic:

Ein manueller Snapshot lässt sich ohne Browser auch mit `npm run backup:create` erzeugen (im Container: `docker exec ticket-system-app node scripts/create-backup.js`).

```bash
# Auf dem Docker-Host aus dem Compose-Verzeichnis ausführen.
# Für Cron als eigenes Shell-Skript ablegen; absolute Pfade verwenden.
set -eu
VOL=$(docker volume inspect -f '{{.Mountpoint}}' ticket-system_ticket-system-data)
test -n "$VOL" && test -d "$VOL"
# Kurzes Wartungsfenster: keine offenen SQLite-Dateien oder laufenden
# Uploads während der Sicherung. Bei Fehlern die App trotzdem starten.
trap 'docker compose start ticket-system' EXIT
docker compose stop ticket-system
restic -r sftp:backup@host:/ticket-system backup "$VOL"
docker compose start ticket-system
trap - EXIT
restic -r sftp:backup@host:/ticket-system forget --keep-daily 14 --keep-weekly 8 --prune
```

Gesichert wird das vollständige gestoppte Volume einschließlich `ticket-system.db`, `events.db`, eventuell vorhandener WAL-/SHM-Dateien, `backups/`, `ticket-attachments/` und `log-archive/`. Der Volume-Name ist an die Installation anzupassen. Während des Backups ist die App nicht erreichbar; die Sicherung überwachen und einen Restore regelmäßig testen. Eine Kopie der offenen SQLite-Dateien im laufenden Betrieb ersetzt diese Sicherung nicht.

### Wiederherstellen

- **Einzelner DB-Stand**: `/admin` → „Backups“ → „Wiederherstellen“. Die App legt vorher automatisch einen `pre-restore-`-Snapshot an und beendet sich danach; die Restart-Policy (`restart: unless-stopped`) startet sie neu.
- **Komplettverlust**: App stoppen, Volume neu anlegen und den gesamten Inhalt eines gemeinsamen Restic-Snapshots wiederherstellen (beide Datenbanken samt zugehörigen WAL-/SHM-Dateien, Anhänge, Backups und Log-Archiv). Eigentümer und Zugriffsrechte für den Container prüfen, dann starten. Keine Dateien verschiedener Sicherungszeitpunkte mischen. Ältere Schema-Versionen werden beim Start automatisch migriert. Anschließend Login, Tickets mit Anhängen und historische Audit-Ereignisse prüfen.

> Ohne Prozess-Supervisor (z. B. `npm start` direkt im Terminal) bleibt die App nach einem Restore beendet und muss von Hand neu gestartet werden.

## Monitoring

- **Liveness**: `GET /healthz` → `200 {"status":"ok","db":"ok"}`, bei nicht erreichbarer DB `503`. Der Docker-Healthcheck nutzt denselben Endpunkt. Zusätzlich von außen prüfen (z. B. Uptime Kuma), um Ausfälle von Caddy, DNS und Zertifikat mitzubekommen.
- **Metriken**: `GET /metrics` (Prometheus-Format, mit `Authorization: Bearer $METRICS_TOKEN`): Tickets je Ansicht (`ticket_system_tickets{view}` inkl. `overdue`), Kundenkonten, Anhänge, Mail-Outbox, IMAP-Status, Backups, freier Speicher, Event-Log-Zustand, Build-Info und Event-Loop-Lag (`ticket_system_event_loop_lag_seconds`).
- **Event-Log** (`/admin/logs`): alle Ereignisse der App in `DATA_DIR/events.db`, einer eigenen SQLite-Datei neben der Haupt-DB — Anmeldungen, Rechte- und Datenänderungen mit Vorher-Nachher-Zustand, jeder HTTP-Request mit Status und Dauer, Hintergrund-Jobs, langsame Datenbankabfragen und DB-Fehler, Rate-Limit-Sperren, CSRF-Abweisungen, Mailversand und unbehandelte Fehler mit Stacktrace. Kennzahlen, Grafiken, Filter nach Schweregrad/Modul/Zeitraum, Volltextsuche und Export als CSV/JSON. Jede Antwort trägt einen `X-Request-Id`-Header; nennt ein Nutzer diese ID, zeigt `/admin/logs?range=all&req=<id>` alle Ereignisse dieses Requests. Query-Strings werden nie gespeichert, weil dort Einmal-Tokens stehen; Session-IDs nur als gekürzter Hash.
- **Konsole**: bewusst knapp — Start, Herunterfahren, Konfigurationswarnungen und alles ab `warn`. Einzelne Requests, Mails und Jobs erscheinen dort nur mit `LOG_CONSOLE_LEVEL=info` (oder `debug`).
- `events.db` ist **nicht** Teil der eingebauten DB-Sicherungen (sonst würde ein Restore das Protokoll zurückdrehen). Wer sie außer Haus sichern will: `sqlite3 events.db ".backup events-copy.db"` oder die Archivdateien aus `log-archive/` mitnehmen.

Beispiel-Alertregeln (Prometheus):

```yaml
groups:
  - name: ticket-system
    rules:
      - alert: TicketSystemDown
        expr: up{job="ticket-system"} == 0
        for: 5m
      - alert: TicketSystemDiskAlmostFull
        expr: ticket_system_disk_free_bytes < 5 * 1024^3
        for: 15m
      - alert: TicketSystemOverdueTickets
        expr: ticket_system_tickets{view="overdue"} > 0
        for: 1h
      - alert: TicketSystemMailFailed
        expr: ticket_system_mail_outbox{status="failed"} > 0
      - alert: TicketSystemMailBacklog
        expr: ticket_system_mail_outbox{status="pending"} > 20
        for: 30m
      - alert: TicketSystemBackupStale
        expr: time() - ticket_system_backup_last_timestamp_seconds > 2 * 86400
      - alert: TicketSystemImapFailing
        expr: ticket_system_imap_last_poll_ok == 0
        for: 30m
      - alert: TicketSystemEventLogFailing
        expr: increase(ticket_system_events_write_failures_total[15m]) > 0
      - alert: TicketSystemEventLoopLag
        expr: ticket_system_event_loop_lag_seconds{quantile="0.95"} > 0.25
        for: 10m
```

Vor größeren Releases kann die laufende Instanz mit `npm run loadtest` geprüft werden. Der Test verwendet standardmäßig nur `/healthz`, `/support` und die Wissensdatenbank-Suche. Authentifizierte, weiterhin nur lesende Pfade lassen sich über `LOAD_TEST_PATHS` und `LOAD_TEST_COOKIE` ergänzen. Er schlägt bei mehr als 1 % Fehlern oder einem p95 über `LOAD_TEST_MAX_P95_MS` fehl.

## Tickets per E-Mail

Mit IMAP (`IMAP_HOST`/`IMAP_USER`) nimmt die App Antworten auf bestehende Tickets an. Welche Mails neu sind, merkt sie sich über die IMAP-UID (Tabelle `imap_state`), nicht über das Gelesen-Flag — wer das Postfach nebenbei im Mailprogramm liest, verschluckt also keine Antworten. Beim allerersten Abruf werden nur ungelesene Mails übernommen. Mit `IMAP_PROCESSED_MAILBOX` (z. B. `Verarbeitet`, bei manchen Servern `INBOX.Verarbeitet`) wandern verarbeitete Mails in diesen Ordner, sonst bleiben sie gelesen im Postfach. Jede Mail wird höchstens einmal verarbeitet (Message-ID, 90 Tage gemerkt).

Damit Kunden auch **neue** Tickets per Mail eröffnen können, muss zusätzlich `IMAP_AUTHSERV_ID` gesetzt sein:

1. Vom Konto eines Testkunden eine Mail an die Support-Adresse schicken.
2. Im Webmailer/Mailprogramm des Support-Postfachs die Kopfzeilen (Quelltext) dieser Mail öffnen.
3. Den **obersten** `Authentication-Results:`-Header suchen. Das erste Wort vor dem Semikolon ist die authserv-id, z. B. `Authentication-Results: mx.example.com; dkim=pass …` → `IMAP_AUTHSERV_ID=mx.example.com`.

Die App vertraut nur diesem Header (ein Absender kann beliebige weitere mitschicken) und akzeptiert nur `dmarc=pass` für die Absenderdomain oder `dkim=pass` mit passender Signaturdomain. Außerdem muss die Absenderadresse ein bestätigtes, nicht gesperrtes Kundenkonto sein; höchstens 5 neue Tickets je Konto und Stunde. Alles andere wird still verworfen und erscheint im Event-Log als `mail_inbound_rejected` mit Grund (`no_account`, `unverified`, `auth_failed`, `rate_limited` …).

Mit gesetzter `IMAP_AUTHSERV_ID` gilt dieselbe DKIM/DMARC-Prüfung auch für **Antworten** auf bestehende Tickets.

Schutz vor Mail-Schleifen: Automatische Mails (`Auto-Submitted`, `Precedence: bulk/list`, `List-Id`, leerer `Return-Path`, `mailer-daemon`/`postmaster`) werden nie zu Nachrichten. Den Hinweis „Ticket ist geschlossen“ bekommt ein Kunde höchstens einmal je Ticket und 24 h, und nie auf eine Mail mit `X-Auto-Response-Suppress`/`X-Loop`.

Ticket-Anhänge unterliegen der Speicherreserve `MIN_FREE_DISK_MB`: passt ein Upload nicht mehr, lehnt das Formular ihn mit einer Meldung ab; per Mail kommt die Nachricht ohne die Anhänge und mit Hinweis an. Verwaiste Anhang-Dateien räumt die stündliche Wartung weg. Anhänge gehen als echte Dateien mit Ticket-Mails mit, bis ihre Summe `MAIL_ATTACHMENT_MAX_MB` (Default 10) erreicht.

## Updates

```bash
git pull
docker compose --profile tls up -d --build
docker compose logs -f ticket-system    # auf "Server läuft" und Migrationen achten
```

- Vor jedem Update unter `/admin` → „Backups“ eine manuelle Sicherung anlegen.
- Schema-Änderungen laufen beim Start automatisch und transaktional (`PRAGMA user_version`, siehe `lib/db.js`).
- **Rollback**: Ein älteres Image verweigert den Start mit einer DB, deren Schema neuer ist, statt sie zu beschädigen. In diesem Fall die vor dem Update angelegte Sicherung zurückspielen oder wieder das neuere Image starten.
- `docker stop` wartet bis zu 40 s, laufende Requests dürfen in dieser Zeit zu Ende laufen.

## Löschfristen

Laufen stündlich und beim Start (`lib/retention.js`), jeweils in Tagen, `0` schaltet ab:

| Variable | Default | Was |
|---|---|---|
| `AUDIT_LOG_RETENTION_DAYS` | 90 | Audit-Log-Einträge (mit IP-Adressen) |
| `UNVERIFIED_ACCOUNT_RETENTION_DAYS` | 30 | nie bestätigte Kundenkonten (ohne Benachrichtigung) |
| `CLOSED_TICKET_RETENTION_DAYS` | 0 (aus) | geschlossene Tickets samt Anhängen, gezählt ab Schließung |

Das Event-Log hat eigene Fristen je Schweregrad (Default DEBUG 3, INFO 30, WARNING 90, ERROR/CRITICAL 365 Tage) plus eine Obergrenze der Eintragszahl, einstellbar zur Laufzeit unter `/admin/logs/settings`. Die Datenschutzerklärung nennt automatisch die wirksamen Werte.

Achtung, wenn der Mailversand fehlt: Neue Kundenkonten müssen dann manuell unter `/admin/customers` freigeschaltet werden, sonst fallen sie nach `UNVERIFIED_ACCOUNT_RETENTION_DAYS` weg.

## Notfälle

| Symptom | Ursache / Abhilfe |
|---|---|
| Container startet nicht, Log „Ungültige Konfiguration“ | Die Meldung nennt jede fehlende oder unsichere Variable; `.env` korrigieren |
| Log „Datenbank-Schema ist Version X“ | Älteres Image gegen neuere DB, siehe Rollback |
| Login schlägt ohne Fehlermeldung fehl | Aufruf nicht über https bzw. `TRUST_PROXY` falsch; das secure-Cookie wird nicht gesetzt |
| Anhang-Upload endet mit „Speicher voll“ | Volume voll bzw. Reserve `MIN_FREE_DISK_MB` unterschritten; Platz schaffen |
| Admin-Passwort vergessen | Zeile löschen und mit `ADMIN_PASSWORD` neu starten: `docker compose exec ticket-system node -e "const{DatabaseSync}=require('node:sqlite');new DatabaseSync('/app/data/ticket-system.db').exec('DELETE FROM admin_password')"`, danach `ADMIN_PASSWORD` setzen und neu starten (siehe „Bootstrap-once“ in der README) |
| Mails bleiben hängen | `/admin/ticket-settings` → Outbox: Fehlermeldung des SMTP-Servers; nach Korrektur „Erneut senden“ |
