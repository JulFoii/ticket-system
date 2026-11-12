'use strict';

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { once } = require('events');

const { createApp } = require('../server');

const QUIET = {
    log() {}, info() {}, warn() {}, error() {},
    attachSink() {}, detachSink() {},
};

async function main() {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ticket-system-loadtest-'));
    const instance = createApp({
        dataDir: path.join(root, 'data'),
        tmpDir: path.join(root, 'tmp'),
        adminPassword: 'loadtest-only-password',
        sessionSecret: 'loadtest-only-session-secret',
        smtpHost: null,
        imapHost: null,
        startMailWorkers: false,
        sweepTmpUploads: false,
        maintenanceIntervalMs: 0,
        minFreeDiskMb: 0,
        requestLog: false,
        log: QUIET,
    });
    await instance.start();
    const server = instance.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();

    try {
        const child = spawn(process.execPath, [path.join(__dirname, 'load-test.js')], {
            stdio: 'inherit',
            env: {
                ...process.env,
                LOAD_TEST_URL: `http://127.0.0.1:${port}`,
                LOAD_TEST_SECONDS: process.env.LOAD_TEST_SECONDS || '5',
                LOAD_TEST_CONCURRENCY: process.env.LOAD_TEST_CONCURRENCY || '4',
            },
        });
        const [code] = await once(child, 'exit');
        if (code !== 0) process.exitCode = code || 1;
    } finally {
        await new Promise(resolve => server.close(resolve));
        await instance.stop();
        await fsp.rm(root, { recursive: true, force: true });
    }
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
