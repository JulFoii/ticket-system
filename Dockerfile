# >=22.5 fuer node:sqlite (siehe lib/db.js) — v26 wird im Produktionsimage
# ausgeliefert. Die eingebaute SQLite-API laeuft damit ohne
# --experimental-sqlite-Flag und ohne ExperimentalWarning.
# Tag plus OCI-Index-Digest: Builds desselben Commits verwenden bytegenau
# dasselbe Multi-Arch-Basisimage. Dependabot aktualisiert beides per PR.
FROM node:26.12-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797

WORKDIR /app

# Erst nur die Paketdateien, damit der npm-ci-Layer bei reinen Code-
# Aenderungen aus dem Cache kommt. Danach fliegen npm und corepack raus:
# gestartet wird direkt mit node, und das mitgelieferte npm bringt eigene
# verwundbare Abhaengigkeiten (tar, undici, ...) ins Image.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /root/.npm

# Anwendungscode — was NICHT ins Image darf (data/, .env, ...) regelt
# .dockerignore
COPY . .

# data/ haelt die SQLite-Datenbank, Event-Log, Backups und Ticket-Anhaenge
# und wird als Volume eingehaengt (siehe docker-compose.yml); tmp-uploads/
# ist multers Zwischenablage. Die Verzeichnisse existieren hier nur, damit
# sie dem node-User gehoeren.
RUN mkdir -p tmp-uploads data && \
    chown -R node:node tmp-uploads data

USER node

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
