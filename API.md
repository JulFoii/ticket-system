# REST API v1 und Webhooks

Die API liegt unter `/api/v1` und verwendet JSON. Erzeuge das erste Token als Administrator unter
`/admin/integrations`. Der geheime Tokenwert wird nur einmal angezeigt.

Die vollständige interaktive Swagger UI ist für angemeldete Administratoren unter `/api/docs`
erreichbar. Das zugrunde liegende OpenAPI-3.1-Dokument liegt unter `/api/openapi.json`.

```http
Authorization: Bearer tsapi_...
Content-Type: application/json
```

Tokens besitzen die Scopes `read`, `write` und `admin`. `admin` setzt zusätzlich die Rolle `admin`
voraus. Fehler verwenden `application/problem+json` mit `status`, `code` und `title`. Zeitpunkte in
Antworten sind Epoch-Millisekunden; Eingabezeitpunkte wie `until` sind ISO-8601-Zeichenketten.

## Endpunkte

| Methode | Pfad | Scope | Zweck |
|---|---|---|---|
| GET | `/api/v1` | read | Version und Ressourcen |
| GET, POST | `/api/v1/tickets` | read / write | Tickets suchen oder anlegen |
| GET, PATCH, DELETE | `/api/v1/tickets/:number` | read / write / admin | Ticket lesen, ändern oder löschen |
| POST | `/api/v1/tickets/:number/replies` | write | Öffentliche Support-Antwort |
| POST | `/api/v1/tickets/:number/notes` | write | Interne Notiz |
| POST, DELETE | `/api/v1/tickets/:number/snooze` | write | Wiedervorlage setzen/aufheben |
| POST | `/api/v1/tickets/:number/merge` | write | In `targetNumber` zusammenführen |
| POST | `/api/v1/tickets/:number/split` | write | Nachrichten in neues Ticket aufteilen |
| GET, POST | `/api/v1/customers` | read / write | Kunden suchen oder anlegen |
| GET, PATCH | `/api/v1/customers/:id` | read / write | Kunde und Tickets lesen/ändern |
| GET, POST | `/api/v1/knowledge-base/articles` | read / write | KB-Artikel auflisten/anlegen |
| GET, PATCH, DELETE | `/api/v1/knowledge-base/articles/:id` | read / write | KB-Artikel verwalten |
| GET, POST | `/api/v1/categories` | read / admin | Kategorien auflisten/anlegen |
| PATCH, DELETE | `/api/v1/categories/:id` | admin | Kategorie ändern/löschen |
| GET, POST | `/api/v1/canned-responses` | read / write | Textbausteine auflisten/anlegen |
| PATCH, DELETE | `/api/v1/canned-responses/:id` | write | Textbaustein ändern/löschen |
| GET | `/api/v1/settings` | admin | Automatik, SLA und Antwortvorlage |
| PATCH | `/api/v1/settings/automation` | admin | Automatik-Fristen ändern |
| PATCH | `/api/v1/settings/sla` | admin | SLA je Priorität ändern |
| PATCH | `/api/v1/settings/reply-template` | admin | Antwortvorlage ändern |
| GET, POST | `/api/v1/support-users` | admin | Support-Team auflisten/anlegen |
| PATCH, DELETE | `/api/v1/support-users/:id` | admin | Teammitglied ändern/löschen |
| GET | `/api/v1/reports?from=&to=` | read | Berichte; Zeitpunkte als Epoch-ms |
| GET | `/api/v1/events` | admin | Event-Log mit Filtern und Cursor |
| GET | `/api/v1/events/:id` | admin | Einzelnes Ereignis |
| GET, POST | `/api/v1/backups` | admin | Backups auflisten/anlegen |
| DELETE | `/api/v1/backups/:file` | admin | Backup löschen |
| GET, POST | `/api/v1/api-tokens` | admin | Tokens auflisten/anlegen |
| PATCH, DELETE | `/api/v1/api-tokens/:id` | admin | Token ändern/löschen |
| GET, POST | `/api/v1/webhooks` | admin | Webhooks auflisten/anlegen |
| PATCH, DELETE | `/api/v1/webhooks/:id` | admin | Webhook ändern/löschen |
| GET | `/api/v1/webhook-deliveries` | admin | Zustellungen einsehen |
| POST | `/api/v1/webhook-deliveries/:id/retry` | admin | Fehlgeschlagene Zustellung wiederholen |

Ticketlisten unterstützen `view`, `q`, `customerId`, `categoryId`, `priority`, `assignedTo`, `sort`,
`page` und `perPage` (maximal 100). Eventlisten übernehmen die Filter des Event-Logs und verwenden
`before` als Cursor.

## Webhooks

Ein Webhook abonniert eine Liste von Audit-Ereignissen oder `*`. Die Nutzlast ist:

```json
{
  "id": "eindeutige Ereignis-ID",
  "event": "api_ticket_created",
  "createdAt": "2026-11-08T12:00:00.000Z",
  "data": { "ticket": 1001 }
}
```

Jede Zustellung enthält `X-Ticket-Event`, `X-Ticket-Delivery`, `X-Ticket-Timestamp` und
`X-Ticket-Signature-256`. Die Signatur ist
`sha256=HMAC_SHA256(secret, timestamp + "." + rawRequestBody)`. Vor der Verarbeitung sollte der
Empfänger Signatur und Zeitstempel prüfen und Zustellungs-IDs idempotent behandeln. Fehlversuche
werden persistent mit exponentiellem Abstand bis zu achtmal wiederholt. Antworten mit jedem
HTTP-Status von 200 bis 299 gelten als erfolgreich.

## Beispiele

```bash
curl -H "Authorization: Bearer $TOKEN" https://support.example.com/api/v1/tickets?view=open

curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"customerId":"...","subject":"Aus CRM","message":"Bitte prüfen","priority":"high"}' \
  https://support.example.com/api/v1/tickets
```
