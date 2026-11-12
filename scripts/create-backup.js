'use strict';

const path = require('node:path');
const { openDatabase } = require('../lib/db');
const { createBackupStore } = require('../lib/backup-store');

async function main() {
    const dataDir = path.resolve(process.env.DATA_DIR || 'data');
    const db = openDatabase(path.join(dataDir, 'ticket-system.db'));
    try {
        const store = createBackupStore({ db, backupDir: path.join(dataDir, 'backups') });
        const result = await store.createBackup('manual');
        console.log(`Backup erstellt: ${result.file}`);
    } finally {
        db.close();
    }
}

main().catch(error => {
    console.error(`Backup fehlgeschlagen: ${error.message}`);
    process.exitCode = 1;
});
