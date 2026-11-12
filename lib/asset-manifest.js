'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function contentVersion(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
}

function registerAssetManifest({ app, rootDir }) {
    const versions = new Map();
    const vendorAssets = [
        ['/vendor/bootstrap/bootstrap.min.css', 'bootstrap/dist/css/bootstrap.min.css'],
        ['/vendor/bootstrap/bootstrap.bundle.min.js', 'bootstrap/dist/js/bootstrap.bundle.min.js'],
    ];

    for (const [url, modulePath] of vendorAssets) {
        const file = require.resolve(modulePath);
        versions.set(url, contentVersion(file));
        app.get(url, (_req, res) => res.sendFile(file, { maxAge: '1h' }));
    }

    for (const dir of ['js', 'css']) {
        const directory = path.join(rootDir, 'public', dir);
        for (const file of fs.readdirSync(directory)) {
            versions.set(`/${dir}/${file}`, contentVersion(path.join(directory, file)));
        }
    }

    app.locals.asset = url => {
        const version = versions.get(url);
        return version ? `${url}?v=${version}` : url;
    };
}

module.exports = { contentVersion, registerAssetManifest };
