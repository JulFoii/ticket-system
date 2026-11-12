'use strict';

const APP_VERSION = require('../package.json').version;

const ref = name => ({ $ref: `#/components/schemas/${name}` });
const jsonBody = schema => ({ required: true, content: { 'application/json': { schema } } });
const response = (description, schema = null) => ({ description, ...(schema ? { content: { 'application/json': { schema } } } : {}) });
const problemResponses = {
    401: response('API-Token fehlt oder ist ungültig.', ref('Problem')),
    403: response('Token besitzt nicht die erforderliche Rolle oder den erforderlichen Scope.', ref('Problem')),
    422: response('Validierung fehlgeschlagen.', ref('Problem')),
    500: response('Interner Serverfehler.', ref('Problem')),
};
const pathParam = (name, description, schema = { type: 'string' }) => ({ name, in: 'path', required: true, description, schema });
const queryParam = (name, description, schema = { type: 'string' }) => ({ name, in: 'query', description, schema });
const op = ({ tag, summary, description, scope = 'read', parameters, body, responses = {}, operationId }) => ({
    tags: [tag], summary, ...(description ? { description } : {}), operationId,
    security: [{ bearerAuth: [] }],
    ...(scope ? { 'x-required-scope': scope } : {}),
    ...(parameters ? { parameters } : {}), ...(body ? { requestBody: body } : {}),
    responses: { ...problemResponses, ...responses },
});

function createOpenApiDocument() {
    return {
        openapi: '3.1.0',
        info: {
            title: 'Ticketsystem REST API', version: APP_VERSION,
            description: 'Vollständige REST-API für Tickets, Kunden, Wissensdatenbank, Konfiguration, Berichte, Backups und Integrationen. Zeitstempel in Antworten sind Epoch-Millisekunden.',
        },
        // Absichtlich relativ: Swagger muss auch dann dieselbe Origin nutzen,
        // wenn die Seite ueber 127.0.0.1, einen Proxy oder einen Alias geoeffnet wird.
        servers: [{ url: '/api/v1', description: 'Diese Ticketsystem-Instanz' }],
        tags: [
            ['System', 'API-Metadaten'], ['Tickets', 'Tickets und Nachrichten'], ['Kunden', 'Kundenkonten'],
            ['Wissensdatenbank', 'Hilfeartikel'], ['Konfiguration', 'Kategorien, Textbausteine und Einstellungen'],
            ['Support-Team', 'Support-Nutzer'], ['Berichte', 'Kennzahlen'], ['Event-Log', 'System- und Audit-Ereignisse'],
            ['Backups', 'Datenbanksicherungen'], ['API-Tokens', 'API-Zugänge'], ['Webhooks', 'Webhooks und Zustellungen'],
        ].map(([name, description]) => ({ name, description })),
        paths: {
            '/': { get: op({ tag: 'System', summary: 'API-Ressourcen anzeigen', operationId: 'getApiIndex', responses: { 200: response('API-Index.', ref('ApiIndex')) } }) },
            '/tickets': {
                get: op({ tag: 'Tickets', summary: 'Tickets suchen und auflisten', operationId: 'listTickets', parameters: [
                    queryParam('view', 'Ansicht.', { type: 'string', enum: ['active', 'new', 'open', 'pending', 'urgent', 'unread', 'snoozed', 'overdue', 'resolved', 'closed', 'done', 'all'], default: 'active' }),
                    queryParam('q', 'Volltextsuche.'), queryParam('customerId', 'Kunden-ID.'), queryParam('categoryId', 'Kategorie-ID.', { type: 'integer' }),
                    queryParam('priority', 'Priorität.', ref('Priority')), queryParam('assignedTo', 'Support-Nutzer-ID oder `unassigned`.'),
                    queryParam('sort', 'Sortierung.', { type: 'string', enum: ['updated', 'created', 'oldest', 'priority', 'number', 'due', 'snooze'], default: 'updated' }),
                    queryParam('page', 'Seite.', { type: 'integer', minimum: 1, default: 1 }), queryParam('perPage', 'Einträge je Seite.', { type: 'integer', minimum: 1, maximum: 100, default: 25 }),
                ], responses: { 200: response('Paginierte Ticketliste.', ref('TicketList')) } }),
                post: op({ tag: 'Tickets', summary: 'Ticket für einen Kunden erstellen', operationId: 'createTicket', scope: 'write', body: jsonBody(ref('TicketCreate')), responses: { 201: response('Ticket erstellt.', ref('TicketDetail')) } }),
            },
            '/tickets/{number}': {
                get: op({ tag: 'Tickets', summary: 'Ticket mit Verlauf abrufen', operationId: 'getTicket', parameters: [pathParam('number', 'Ticketnummer.', { type: 'integer' })], responses: { 200: response('Ticketdetail.', ref('TicketDetail')), 404: response('Ticket nicht gefunden.', ref('Problem')) } }),
                patch: op({ tag: 'Tickets', summary: 'Ticket-Eigenschaften ändern', operationId: 'updateTicket', scope: 'write', parameters: [pathParam('number', 'Ticketnummer.', { type: 'integer' })], body: jsonBody(ref('TicketUpdate')), responses: { 200: response('Aktualisiertes Ticket.', ref('TicketEnvelope')), 404: response('Ticket nicht gefunden.', ref('Problem')) } }),
                delete: op({ tag: 'Tickets', summary: 'Ticket endgültig löschen', operationId: 'deleteTicket', scope: 'admin', parameters: [pathParam('number', 'Ticketnummer.', { type: 'integer' })], responses: { 204: response('Ticket gelöscht.'), 404: response('Ticket nicht gefunden.', ref('Problem')) } }),
            },
            '/tickets/{number}/replies': { post: op({ tag: 'Tickets', summary: 'Öffentliche Support-Antwort schreiben', operationId: 'replyTicket', scope: 'write', parameters: [pathParam('number', 'Ticketnummer.', { type: 'integer' })], body: jsonBody(ref('MessageCreate')), responses: { 201: response('Antwort erstellt.', ref('MessageResult')), 404: response('Ticket nicht gefunden.', ref('Problem')) } }) },
            '/tickets/{number}/notes': { post: op({ tag: 'Tickets', summary: 'Interne Notiz schreiben', operationId: 'noteTicket', scope: 'write', parameters: [pathParam('number', 'Ticketnummer.', { type: 'integer' })], body: jsonBody(ref('NoteCreate')), responses: { 201: response('Notiz erstellt.', ref('MessageResult')), 404: response('Ticket nicht gefunden.', ref('Problem')) } }) },
            '/tickets/{number}/snooze': {
                post: op({ tag: 'Tickets', summary: 'Ticket auf Wiedervorlage setzen', operationId: 'snoozeTicket', scope: 'write', parameters: [pathParam('number', 'Ticketnummer.', { type: 'integer' })], body: jsonBody(ref('SnoozeCreate')), responses: { 200: response('Ticket zurückgestellt.', ref('TicketEnvelope')), 409: response('Wiedervorlage nicht möglich.', ref('Problem')) } }),
                delete: op({ tag: 'Tickets', summary: 'Wiedervorlage aufheben', operationId: 'unsnoozeTicket', scope: 'write', parameters: [pathParam('number', 'Ticketnummer.', { type: 'integer' })], responses: { 200: response('Aktualisiertes Ticket.', ref('TicketEnvelope')), 409: response('Ticket war nicht zurückgestellt.', ref('Problem')) } }),
            },
            '/tickets/{number}/merge': { post: op({ tag: 'Tickets', summary: 'Ticket in ein anderes zusammenführen', operationId: 'mergeTicket', scope: 'write', parameters: [pathParam('number', 'Quell-Ticketnummer.', { type: 'integer' })], body: jsonBody(ref('MergeCreate')), responses: { 200: response('Tickets zusammengeführt.', ref('MergeResult')), 409: response('Zusammenführen nicht möglich.', ref('Problem')) } }) },
            '/tickets/{number}/split': { post: op({ tag: 'Tickets', summary: 'Nachrichten in ein neues Ticket aufteilen', operationId: 'splitTicket', scope: 'write', parameters: [pathParam('number', 'Quell-Ticketnummer.', { type: 'integer' })], body: jsonBody(ref('SplitCreate')), responses: { 201: response('Ticket aufgeteilt.', ref('SplitResult')), 409: response('Aufteilen nicht möglich.', ref('Problem')) } }) },
            '/customers': {
                get: op({ tag: 'Kunden', summary: 'Kunden suchen und auflisten', operationId: 'listCustomers', parameters: [queryParam('q', 'Name oder E-Mail.'), queryParam('page', 'Seite.', { type: 'integer', minimum: 1 }), queryParam('perPage', 'Einträge je Seite.', { type: 'integer', minimum: 1, maximum: 100 })], responses: { 200: response('Kundenliste.', ref('CustomerList')) } }),
                post: op({ tag: 'Kunden', summary: 'Kundenkonto erstellen', operationId: 'createCustomer', scope: 'write', body: jsonBody(ref('CustomerCreate')), responses: { 201: response('Kunde erstellt.', ref('CustomerEnvelope')), 409: response('E-Mail bereits vergeben.', ref('Problem')) } }),
            },
            '/customers/{id}': {
                get: op({ tag: 'Kunden', summary: 'Kunde mit Tickets abrufen', operationId: 'getCustomer', parameters: [pathParam('id', 'Kunden-ID.')], responses: { 200: response('Kundendetail.', ref('CustomerDetail')), 404: response('Kunde nicht gefunden.', ref('Problem')) } }),
                patch: op({ tag: 'Kunden', summary: 'Kunde ändern', operationId: 'updateCustomer', scope: 'write', parameters: [pathParam('id', 'Kunden-ID.')], body: jsonBody(ref('CustomerUpdate')), responses: { 200: response('Aktualisierter Kunde.', ref('CustomerEnvelope')), 404: response('Kunde nicht gefunden.', ref('Problem')), 409: response('E-Mail bereits vergeben.', ref('Problem')) } }),
            },
            '/knowledge-base/articles': {
                get: op({ tag: 'Wissensdatenbank', summary: 'Artikel suchen und auflisten', operationId: 'listArticles', parameters: [queryParam('q', 'Suchtext.'), queryParam('categoryId', 'Kategorie-ID.', { type: 'integer' }), queryParam('publishedOnly', 'Nur veröffentlichte Artikel.', { type: 'boolean' }), queryParam('limit', 'Maximale Treffer.', { type: 'integer', minimum: 1, maximum: 500 })], responses: { 200: response('Artikelliste.', ref('ArticleList')) } }),
                post: op({ tag: 'Wissensdatenbank', summary: 'Artikel erstellen', operationId: 'createArticle', scope: 'write', body: jsonBody(ref('ArticleWrite')), responses: { 201: response('Artikel erstellt.', ref('ArticleEnvelope')) } }),
            },
            '/knowledge-base/articles/{id}': {
                get: op({ tag: 'Wissensdatenbank', summary: 'Artikel abrufen', operationId: 'getArticle', parameters: [pathParam('id', 'Artikel-ID.', { type: 'integer' })], responses: { 200: response('Artikel.', ref('ArticleEnvelope')), 404: response('Artikel nicht gefunden.', ref('Problem')) } }),
                patch: op({ tag: 'Wissensdatenbank', summary: 'Artikel ändern', operationId: 'updateArticle', scope: 'write', parameters: [pathParam('id', 'Artikel-ID.', { type: 'integer' })], body: jsonBody(ref('ArticleWrite')), responses: { 200: response('Aktualisierter Artikel.', ref('ArticleEnvelope')) } }),
                delete: op({ tag: 'Wissensdatenbank', summary: 'Artikel löschen', operationId: 'deleteArticle', scope: 'admin', parameters: [pathParam('id', 'Artikel-ID.', { type: 'integer' })], responses: { 204: response('Artikel gelöscht.'), 404: response('Artikel nicht gefunden.', ref('Problem')) } }),
            },
            '/categories': {
                get: op({ tag: 'Konfiguration', summary: 'Kategorien auflisten', operationId: 'listCategories', responses: { 200: response('Kategorien.', ref('CategoryList')) } }),
                post: op({ tag: 'Konfiguration', summary: 'Kategorie erstellen', operationId: 'createCategory', scope: 'admin', body: jsonBody(ref('CategoryWrite')), responses: { 201: response('Kategorie erstellt.', ref('CategoryEnvelope')), 409: response('Name bereits vergeben.', ref('Problem')) } }),
            },
            '/categories/{id}': {
                patch: op({ tag: 'Konfiguration', summary: 'Kategorie umbenennen', operationId: 'updateCategory', scope: 'admin', parameters: [pathParam('id', 'Kategorie-ID.', { type: 'integer' })], body: jsonBody(ref('CategoryWrite')), responses: { 200: response('Kategorie aktualisiert.', ref('CategoryEnvelope')) } }),
                delete: op({ tag: 'Konfiguration', summary: 'Kategorie löschen', operationId: 'deleteCategory', scope: 'admin', parameters: [pathParam('id', 'Kategorie-ID.', { type: 'integer' })], responses: { 204: response('Kategorie gelöscht.') } }),
            },
            '/canned-responses': {
                get: op({ tag: 'Konfiguration', summary: 'Textbausteine auflisten', operationId: 'listCannedResponses', responses: { 200: response('Textbausteine.', ref('CannedList')) } }),
                post: op({ tag: 'Konfiguration', summary: 'Textbaustein erstellen', operationId: 'createCannedResponse', scope: 'write', body: jsonBody(ref('CannedWrite')), responses: { 201: response('Textbaustein erstellt.', ref('CannedEnvelope')) } }),
            },
            '/canned-responses/{id}': {
                patch: op({ tag: 'Konfiguration', summary: 'Textbaustein ändern', operationId: 'updateCannedResponse', scope: 'write', parameters: [pathParam('id', 'Textbaustein-ID.', { type: 'integer' })], body: jsonBody(ref('CannedWrite')), responses: { 200: response('Textbaustein aktualisiert.', ref('CannedEnvelope')) } }),
                delete: op({ tag: 'Konfiguration', summary: 'Textbaustein löschen', operationId: 'deleteCannedResponse', scope: 'write', parameters: [pathParam('id', 'Textbaustein-ID.', { type: 'integer' })], responses: { 204: response('Textbaustein gelöscht.') } }),
            },
            '/settings': { get: op({ tag: 'Konfiguration', summary: 'Ticket-Einstellungen abrufen', operationId: 'getSettings', scope: 'admin', responses: { 200: response('Einstellungen.', ref('Settings')) } }) },
            '/settings/automation': { patch: op({ tag: 'Konfiguration', summary: 'Automatik-Fristen ändern', operationId: 'updateAutomationSettings', scope: 'admin', body: jsonBody(ref('AutomationSettings')), responses: { 200: response('Gespeicherte Einstellungen.', { type: 'object' }) } }) },
            '/settings/sla': { patch: op({ tag: 'Konfiguration', summary: 'SLA-Fristen ändern', operationId: 'updateSlaSettings', scope: 'admin', body: jsonBody(ref('SlaSettings')), responses: { 200: response('Gespeicherte SLA-Fristen.', { type: 'object' }) } }) },
            '/settings/reply-template': { patch: op({ tag: 'Konfiguration', summary: 'Antwortvorlage ändern', operationId: 'updateReplyTemplate', scope: 'admin', body: jsonBody(ref('ReplyTemplate')), responses: { 200: response('Gespeicherte Vorlage.', { type: 'object' }) } }) },
            '/support-users': {
                get: op({ tag: 'Support-Team', summary: 'Support-Nutzer auflisten', operationId: 'listSupportUsers', scope: 'admin', responses: { 200: response('Support-Nutzer.', ref('SupportUserList')) } }),
                post: op({ tag: 'Support-Team', summary: 'Support-Nutzer erstellen', operationId: 'createSupportUser', scope: 'admin', body: jsonBody(ref('SupportUserCreate')), responses: { 201: response('Nutzer erstellt.', ref('SupportUserEnvelope')), 409: response('Benutzername vergeben.', ref('Problem')) } }),
            },
            '/support-users/{id}': {
                patch: op({ tag: 'Support-Team', summary: 'Support-Nutzer ändern', operationId: 'updateSupportUser', scope: 'admin', parameters: [pathParam('id', 'Support-Nutzer-ID.')], body: jsonBody(ref('SupportUserUpdate')), responses: { 200: response('Nutzer aktualisiert.', ref('SupportUserEnvelope')) } }),
                delete: op({ tag: 'Support-Team', summary: 'Support-Nutzer löschen', operationId: 'deleteSupportUser', scope: 'admin', parameters: [pathParam('id', 'Support-Nutzer-ID.')], responses: { 204: response('Nutzer gelöscht.'), 409: response('Owner kann nicht gelöscht werden.', ref('Problem')) } }),
            },
            '/reports': { get: op({ tag: 'Berichte', summary: 'Ticket- und KB-Bericht abrufen', operationId: 'getReports', parameters: [queryParam('from', 'Beginn als Epoch-ms.', { type: 'integer', format: 'int64' }), queryParam('to', 'Ende als Epoch-ms.', { type: 'integer', format: 'int64' })], responses: { 200: response('Bericht.', { type: 'object', properties: { report: { type: 'object', additionalProperties: true } } }) } }) },
            '/events': { get: op({ tag: 'Event-Log', summary: 'Ereignisse suchen und auflisten', operationId: 'listEvents', scope: 'admin', parameters: [queryParam('q', 'Volltextsuche.'), queryParam('event', 'Ereignistyp.'), queryParam('module', 'Modul.'), queryParam('severity', 'Schweregrad.', { type: 'integer' }), queryParam('actorType', 'Akteurtyp.'), queryParam('before', 'Cursor-ID.', { type: 'integer' }), queryParam('limit', 'Einträge.', { type: 'integer', minimum: 1, maximum: 1000 })], responses: { 200: response('Ereignisse.', ref('EventList')) } }) },
            '/events/{id}': { get: op({ tag: 'Event-Log', summary: 'Ereignis abrufen', operationId: 'getEvent', scope: 'admin', parameters: [pathParam('id', 'Ereignis-ID.', { type: 'integer' })], responses: { 200: response('Ereignis.', ref('EventEnvelope')), 404: response('Ereignis nicht gefunden.', ref('Problem')) } }) },
            '/backups': {
                get: op({ tag: 'Backups', summary: 'Backups auflisten', operationId: 'listBackups', scope: 'admin', responses: { 200: response('Backups und Einstellungen.', ref('BackupList')) } }),
                post: op({ tag: 'Backups', summary: 'Backup erstellen', operationId: 'createBackup', scope: 'admin', responses: { 201: response('Backup erstellt.', ref('BackupEnvelope')) } }),
            },
            '/backups/{file}': { delete: op({ tag: 'Backups', summary: 'Backup löschen', operationId: 'deleteBackup', scope: 'admin', parameters: [pathParam('file', 'Serverseitiger Backup-Dateiname.')], responses: { 204: response('Backup gelöscht.'), 404: response('Backup nicht gefunden.', ref('Problem')) } }) },
            '/api-tokens': {
                get: op({ tag: 'API-Tokens', summary: 'API-Tokens auflisten', operationId: 'listApiTokens', scope: 'admin', responses: { 200: response('Tokens ohne Geheimnisse.', ref('ApiTokenList')) } }),
                post: op({ tag: 'API-Tokens', summary: 'API-Token erstellen', description: 'Das Feld `secret` wird nur in dieser Antwort ausgegeben.', operationId: 'createApiToken', scope: 'admin', body: jsonBody(ref('ApiTokenCreate')), responses: { 201: response('Token und einmaliges Geheimnis.', ref('ApiTokenCreated')) } }),
            },
            '/api-tokens/{id}': {
                patch: op({ tag: 'API-Tokens', summary: 'API-Token ändern', operationId: 'updateApiToken', scope: 'admin', parameters: [pathParam('id', 'Token-ID.')], body: jsonBody(ref('ApiTokenUpdate')), responses: { 200: response('Aktualisiertes Token.', ref('ApiTokenEnvelope')) } }),
                delete: op({ tag: 'API-Tokens', summary: 'API-Token löschen', operationId: 'deleteApiToken', scope: 'admin', parameters: [pathParam('id', 'Token-ID.')], responses: { 204: response('Token gelöscht.'), 409: response('Aktuell verwendetes Token kann sich nicht löschen.', ref('Problem')) } }),
            },
            '/webhooks': {
                get: op({ tag: 'Webhooks', summary: 'Webhooks auflisten', operationId: 'listWebhooks', scope: 'admin', responses: { 200: response('Webhooks ohne Geheimnisse.', ref('WebhookList')) } }),
                post: op({ tag: 'Webhooks', summary: 'Webhook erstellen', description: 'Das Feld `secret` wird nur in dieser Antwort ausgegeben.', operationId: 'createWebhook', scope: 'admin', body: jsonBody(ref('WebhookCreate')), responses: { 201: response('Webhook und einmaliges Signiergeheimnis.', ref('WebhookCreated')) } }),
            },
            '/webhooks/{id}': {
                patch: op({ tag: 'Webhooks', summary: 'Webhook ändern', operationId: 'updateWebhook', scope: 'admin', parameters: [pathParam('id', 'Webhook-ID.')], body: jsonBody(ref('WebhookUpdate')), responses: { 200: response('Aktualisierter Webhook.', ref('WebhookEnvelope')) } }),
                delete: op({ tag: 'Webhooks', summary: 'Webhook löschen', operationId: 'deleteWebhook', scope: 'admin', parameters: [pathParam('id', 'Webhook-ID.')], responses: { 204: response('Webhook samt Zustellungen gelöscht.') } }),
            },
            '/webhook-deliveries': { get: op({ tag: 'Webhooks', summary: 'Webhook-Zustellungen auflisten', operationId: 'listWebhookDeliveries', scope: 'admin', parameters: [queryParam('webhookId', 'Auf einen Webhook begrenzen.'), queryParam('limit', 'Einträge.', { type: 'integer', minimum: 1, maximum: 500 })], responses: { 200: response('Zustellungen.', ref('DeliveryList')) } }) },
            '/webhook-deliveries/{id}/retry': { post: op({ tag: 'Webhooks', summary: 'Zustellung erneut einplanen', operationId: 'retryWebhookDelivery', scope: 'admin', parameters: [pathParam('id', 'Zustellungs-ID.')], responses: { 202: response('Erneut eingeplant.', { type: 'object', properties: { queued: { const: true } } }), 404: response('Zustellung nicht gefunden.', ref('Problem')) } }) },
        },
        components: {
            securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'tsapi_*', description: 'API-Token aus „Admin → API“. Nur den Tokenwert ohne das Wort Bearer eingeben.' } },
            schemas: {
                Problem: { type: 'object', required: ['title', 'status', 'code'], properties: { type: { type: 'string', format: 'uri' }, title: { type: 'string' }, status: { type: 'integer' }, code: { type: 'string' }, details: {} } },
                Status: { type: 'string', enum: ['new', 'open', 'pending', 'resolved', 'closed'] },
                Priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
                Timestamp: { type: ['integer', 'null'], format: 'int64', description: 'Epoch-Millisekunden.' },
                ApiIndex: { type: 'object', properties: { version: { const: 'v1' }, resources: { type: 'array', items: { type: 'string' } } } },
                Attachment: { type: 'object', properties: { id: { type: 'string' }, filename: { type: 'string' }, mime: { type: 'string' }, size: { type: 'integer' }, sha256: { type: 'string' } } },
                Message: { type: 'object', properties: { id: { type: 'integer' }, author: { type: 'string', enum: ['customer', 'admin', 'system'] }, kind: { type: 'string', enum: ['reply', 'note', 'event'] }, internal: { type: 'boolean' }, body: { type: 'string' }, via: { type: 'string' }, createdAt: ref('Timestamp'), supportUserId: { type: ['string', 'null'] }, supportUserName: { type: ['string', 'null'] }, attachments: { type: 'array', items: ref('Attachment') } } },
                Ticket: { type: 'object', required: ['id', 'number', 'subject', 'status', 'priority'], properties: { id: { type: 'string', format: 'uuid' }, number: { type: 'integer' }, customerId: { type: ['string', 'null'] }, requesterEmail: { type: 'string', format: 'email' }, requesterName: { type: ['string', 'null'] }, subject: { type: 'string' }, status: ref('Status'), priority: ref('Priority'), categoryId: { type: ['integer', 'null'] }, categoryName: { type: ['string', 'null'] }, tags: { type: 'array', items: { type: 'string' } }, source: { type: 'string' }, assignedToUserId: { type: ['string', 'null'] }, assignedToName: { type: ['string', 'null'] }, createdAt: ref('Timestamp'), updatedAt: ref('Timestamp'), slaDueAt: ref('Timestamp'), snoozedUntil: ref('Timestamp'), rating: { type: ['integer', 'null'], minimum: 1, maximum: 5 } }, additionalProperties: true },
                TicketEnvelope: { type: 'object', properties: { ticket: ref('Ticket') } },
                TicketDetail: { type: 'object', properties: { ticket: ref('Ticket'), message: ref('Message'), messages: { type: 'array', items: ref('Message') }, splitChildren: { type: 'array', items: ref('Ticket') } }, additionalProperties: true },
                TicketList: { type: 'object', properties: { tickets: { type: 'array', items: ref('Ticket') }, total: { type: 'integer' }, page: { type: 'integer' }, pages: { type: 'integer' }, perPage: { type: 'integer' } } },
                TicketCreate: { type: 'object', required: ['customerId', 'subject', 'message'], properties: { customerId: { type: 'string' }, subject: { type: 'string', maxLength: 200 }, message: { type: 'string', maxLength: 10000 }, priority: ref('Priority'), categoryId: { type: ['integer', 'null'] }, status: { type: 'string', enum: ['pending', 'open', 'resolved'] } } },
                TicketUpdate: { type: 'object', minProperties: 1, properties: { status: ref('Status'), priority: ref('Priority'), categoryId: { type: ['integer', 'null'] }, tags: { type: 'array', maxItems: 20, items: { type: 'string' } }, assignedToUserId: { type: ['string', 'null'] } } },
                MessageCreate: { type: 'object', required: ['message'], properties: { message: { type: 'string', maxLength: 10000 }, status: ref('Status') } },
                NoteCreate: { type: 'object', required: ['message'], properties: { message: { type: 'string', maxLength: 10000 } } },
                MessageResult: { type: 'object', properties: { message: ref('Message'), ticket: ref('Ticket'), previousStatus: ref('Status') } },
                SnoozeCreate: { type: 'object', required: ['until'], properties: { until: { type: 'string', format: 'date-time' }, note: { type: 'string' } } },
                MergeCreate: { type: 'object', required: ['targetNumber'], properties: { targetNumber: { type: 'integer' } } },
                MergeResult: { type: 'object', properties: { source: ref('Ticket'), target: ref('Ticket') } },
                SplitCreate: { type: 'object', required: ['messageIds', 'subject'], properties: { messageIds: { type: 'array', minItems: 1, items: { type: 'integer' } }, subject: { type: 'string' }, priority: ref('Priority'), categoryId: { type: ['integer', 'null'] } } },
                SplitResult: { type: 'object', properties: { source: ref('Ticket'), target: ref('Ticket'), moved: { type: 'integer' } } },
                Customer: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, email: { type: 'string', format: 'email' }, name: { type: 'string' }, verified: { type: 'boolean' }, disabled: { type: 'boolean' }, notifications: { type: 'object', additionalProperties: { type: 'boolean' } }, createdAt: ref('Timestamp'), lastLoginAt: ref('Timestamp'), ticketCount: { type: 'integer' } } },
                CustomerEnvelope: { type: 'object', properties: { customer: ref('Customer') } }, CustomerList: { type: 'object', properties: { customers: { type: 'array', items: ref('Customer') }, total: { type: 'integer' }, page: { type: 'integer' } } }, CustomerDetail: { type: 'object', properties: { customer: ref('Customer'), tickets: ref('TicketList') } },
                CustomerCreate: { type: 'object', required: ['email', 'name', 'password'], properties: { email: { type: 'string', format: 'email' }, name: { type: 'string', minLength: 1, maxLength: 80 }, password: { type: 'string', format: 'password', minLength: 10, maxLength: 200 }, verified: { type: 'boolean', default: false } } },
                CustomerUpdate: { type: 'object', minProperties: 1, properties: { email: { type: 'string', format: 'email' }, name: { type: 'string' }, disabled: { type: 'boolean' }, verified: { type: 'boolean' }, notifications: { type: 'object', additionalProperties: { type: 'boolean' } } } },
                Article: { type: 'object', properties: { id: { type: 'integer' }, slug: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, categoryId: { type: ['integer', 'null'] }, categoryName: { type: ['string', 'null'] }, published: { type: 'boolean' }, position: { type: 'integer' }, views: { type: 'integer' }, createdAt: ref('Timestamp'), updatedAt: ref('Timestamp') } },
                ArticleEnvelope: { type: 'object', properties: { article: ref('Article') } }, ArticleList: { type: 'object', properties: { articles: { type: 'array', items: ref('Article') } } }, ArticleWrite: { type: 'object', required: ['title', 'body'], properties: { slug: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, categoryId: { type: ['integer', 'null'] }, published: { type: 'boolean' } } },
                Category: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } }, CategoryEnvelope: { type: 'object', properties: { category: ref('Category') } }, CategoryList: { type: 'object', properties: { categories: { type: 'array', items: ref('Category') } } }, CategoryWrite: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
                Canned: { type: 'object', properties: { id: { type: 'integer' }, title: { type: 'string' }, body: { type: 'string' }, updatedAt: ref('Timestamp') } }, CannedEnvelope: { type: 'object', properties: { cannedResponse: ref('Canned') } }, CannedList: { type: 'object', properties: { cannedResponses: { type: 'array', items: ref('Canned') } } }, CannedWrite: { type: 'object', required: ['title', 'body'], properties: { title: { type: 'string' }, body: { type: 'string' } } },
                AutomationSettings: { type: 'object', required: ['pendingReminderDays', 'pendingAutoResolveDays', 'autoCloseDays'], properties: { pendingReminderDays: { type: 'integer', minimum: 1, maximum: 60 }, pendingAutoResolveDays: { type: 'integer', minimum: 1, maximum: 90 }, autoCloseDays: { type: 'integer', minimum: 1, maximum: 90 } } },
                SlaTarget: { type: 'object', required: ['firstResponseHours', 'nextResponseHours'], properties: { firstResponseHours: { type: 'number', minimum: 0, maximum: 720, multipleOf: 0.25 }, nextResponseHours: { type: 'number', minimum: 0, maximum: 720, multipleOf: 0.25 } } }, SlaSettings: { type: 'object', required: ['low', 'normal', 'high', 'urgent'], properties: { low: ref('SlaTarget'), normal: ref('SlaTarget'), high: ref('SlaTarget'), urgent: ref('SlaTarget') } },
                ReplyTemplate: { type: 'object', properties: { greeting: { type: 'string' }, signature: { type: 'string' }, agentName: { type: 'string' } } }, Settings: { type: 'object', properties: { automation: ref('AutomationSettings'), sla: ref('SlaSettings'), replyTemplate: ref('ReplyTemplate') } },
                SupportUser: { type: 'object', properties: { id: { type: 'string' }, username: { type: 'string' }, displayName: { type: 'string' }, role: { type: 'string', enum: ['admin', 'agent'] }, disabled: { type: 'boolean' }, isOwner: { type: 'boolean' }, createdAt: ref('Timestamp'), lastLoginAt: ref('Timestamp') } }, SupportUserEnvelope: { type: 'object', properties: { user: ref('SupportUser') } }, SupportUserList: { type: 'object', properties: { users: { type: 'array', items: ref('SupportUser') } } }, SupportUserCreate: { type: 'object', required: ['username', 'displayName', 'role', 'password'], properties: { username: { type: 'string' }, displayName: { type: 'string' }, role: { type: 'string', enum: ['admin', 'agent'] }, password: { type: 'string', format: 'password' } } }, SupportUserUpdate: { type: 'object', properties: { username: { type: 'string' }, displayName: { type: 'string' }, role: { type: 'string', enum: ['admin', 'agent'] }, disabled: { type: 'boolean' } } },
                Event: { type: 'object', properties: { id: { type: 'integer' }, ts: ref('Timestamp'), event: { type: 'string' }, module: { type: 'string' }, severity: { type: 'integer' }, message: { type: ['string', 'null'] }, actorType: { type: ['string', 'null'] }, actorId: { type: ['string', 'null'] }, payload: {} }, additionalProperties: true }, EventEnvelope: { type: 'object', properties: { event: ref('Event') } }, EventList: { type: 'object', properties: { events: { type: 'array', items: ref('Event') }, nextCursor: { type: ['integer', 'null'] } } },
                Backup: { type: 'object', properties: { file: { type: 'string' }, size: { type: 'integer' }, createdAt: ref('Timestamp'), sha256: { type: 'string' } } }, BackupEnvelope: { type: 'object', properties: { backup: ref('Backup') } }, BackupList: { type: 'object', properties: { backups: { type: 'array', items: ref('Backup') }, settings: { type: 'object', additionalProperties: true } } },
                ApiToken: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' }, role: { type: 'string', enum: ['admin', 'agent'] }, scopes: { type: 'array', items: { type: 'string', enum: ['read', 'write', 'admin'] } }, disabled: { type: 'boolean' }, createdAt: ref('Timestamp'), lastUsedAt: ref('Timestamp'), expiresAt: ref('Timestamp') } }, ApiTokenEnvelope: { type: 'object', properties: { token: ref('ApiToken') } }, ApiTokenList: { type: 'object', properties: { tokens: { type: 'array', items: ref('ApiToken') } } }, ApiTokenCreate: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 100 }, role: { type: 'string', enum: ['admin', 'agent'], default: 'agent' }, scopes: { type: 'array', items: { type: 'string', enum: ['read', 'write', 'admin'] }, default: ['read', 'write'] }, expiresAt: ref('Timestamp') } }, ApiTokenUpdate: { type: 'object', properties: { name: { type: 'string' }, role: { type: 'string', enum: ['admin', 'agent'] }, scopes: { type: 'array', items: { type: 'string', enum: ['read', 'write', 'admin'] } }, disabled: { type: 'boolean' }, expiresAt: ref('Timestamp') } }, ApiTokenCreated: { allOf: [ref('ApiTokenEnvelope'), { type: 'object', properties: { secret: { type: 'string', pattern: '^tsapi_' } } }] },
                Webhook: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' }, url: { type: 'string', format: 'uri' }, events: { type: 'array', items: { type: 'string' } }, enabled: { type: 'boolean' }, createdAt: ref('Timestamp'), updatedAt: ref('Timestamp') } }, WebhookEnvelope: { type: 'object', properties: { webhook: ref('Webhook') } }, WebhookList: { type: 'object', properties: { webhooks: { type: 'array', items: ref('Webhook') } } }, WebhookCreate: { type: 'object', required: ['name', 'url'], properties: { name: { type: 'string', maxLength: 100 }, url: { type: 'string', format: 'uri' }, events: { type: 'array', items: { type: 'string' }, default: ['*'] } } }, WebhookUpdate: { type: 'object', properties: { name: { type: 'string' }, url: { type: 'string', format: 'uri' }, events: { type: 'array', items: { type: 'string' } }, enabled: { type: 'boolean' } } }, WebhookCreated: { allOf: [ref('WebhookEnvelope'), { type: 'object', properties: { secret: { type: 'string', pattern: '^tswhsec_' } } }] },
                Delivery: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, webhookId: { type: 'string', format: 'uuid' }, event: { type: 'string' }, status: { type: 'string', enum: ['pending', 'delivering', 'delivered', 'failed'] }, attempts: { type: 'integer' }, responseStatus: { type: ['integer', 'null'] }, lastError: { type: ['string', 'null'] }, createdAt: ref('Timestamp'), deliveredAt: ref('Timestamp'), nextAttemptAt: ref('Timestamp') } }, DeliveryList: { type: 'object', properties: { deliveries: { type: 'array', items: ref('Delivery') } } },
            },
        },
    };
}

module.exports = { createOpenApiDocument };
