'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { envNumber, resolveAppConfig } = require('../lib/app-config');

test('envNumber preserves zero and falls back for empty or invalid values', () => {
    assert.equal(envNumber('VALUE', 42, { VALUE: '0' }), 0);
    assert.equal(envNumber('VALUE', 42, { VALUE: '' }), 42);
    assert.equal(envNumber('VALUE', 42, { VALUE: 'invalid' }), 42);
});

test('resolveAppConfig centralizes environment defaults and derived mail settings', () => {
    const rootDir = path.join('project', 'root');
    const config = resolveAppConfig({}, {
        rootDir,
        env: {
            APP_NAME: 'Helpdesk',
            SMTP_SECURE: 'false',
            IMAP_USER: 'support@example.test',
            MIN_FREE_DISK_MB: '0',
        },
    });

    assert.equal(config.appName, 'Helpdesk');
    assert.equal(config.tmpDir, path.join(rootDir, 'tmp-uploads'));
    assert.equal(config.smtpSecure, false);
    assert.equal(config.smtpPort, 587);
    assert.equal(config.supportReplyTo, 'support@example.test');
    assert.equal(config.minFreeDiskMb, 0);
});

test('resolveAppConfig keeps explicit injectable values including null, false and zero', () => {
    const config = resolveAppConfig({
        metricsToken: null,
        startMailWorkers: false,
        maintenanceIntervalMs: 0,
        smtpPort: 0,
    }, {
        rootDir: '.',
        env: { METRICS_TOKEN: 'from-env', SMTP_PORT: '465' },
    });

    assert.equal(config.metricsToken, null);
    assert.equal(config.startMailWorkers, false);
    assert.equal(config.maintenanceIntervalMs, 0);
    assert.equal(config.smtpPort, 0);
});
