'use strict';

/*
 * Audit-Log als duenne Fassade ueber das zentrale Event-Log
 * (lib/event-store.js). Die rund 60 Aufrufstellen behalten ihre
 * Schnittstelle auditLog.log(event, detail); jeder Eintrag landet als
 * Ereignis mit audit = 1, Modul und Schweregrad aus lib/event-catalog.js
 * und dem Kontext des laufenden Requests (Akteur, IP, User-Agent,
 * Session-Hash, Request-ID).
 *
 * Audit-Eintraege werden sofort geschrieben, nicht gepuffert — ein direkt
 * folgendes read() (Dashboard, Tests) sieht sie also schon.
 *
 * `detail.changes` (siehe diff() in lib/event-store.js) traegt bei
 * Aenderungen den Vorher-Nachher-Zustand.
 */

function createAuditLog({ events }) {
    if (!events) throw new Error('audit log braucht den event store');

    /*
     * Bewusst ohne await/.catch beim Aufrufer gedacht: ein Audit-Log-Fehler
     * darf niemals die eigentliche Aktion (Login, Upload, Loeschen) scheitern
     * lassen — record() faengt selbst alles ab.
     */
    const listeners = new Set();
    async function log(event, detail = {}) {
        events.audit(event, detail);
        for (const listener of listeners) {
            try { listener(event, detail); } catch { /* Auditierung darf nie scheitern */ }
        }
    }

    /* Neueste zuerst: { id, ts, event, ip?, ...detail }. `id` wird
       aufsteigend vergeben (Dashboard-Widget, Live-Bereich "audit"). */
    async function read({ limit = 200 } = {}) {
        return events.readAudit({ limit });
    }

    function subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    return { log, read, subscribe };
}

module.exports = { createAuditLog };
