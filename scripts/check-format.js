'use strict';

/*
 * Dependency-freie Formatpruefung fuer alle Textdateien des Projekts.
 * JavaScript-Stil prueft ESLint; hier werden die gemeinsamen Regeln fuer
 * EJS, CSS, Markdown, YAML, Docker- und Konfigurationsdateien kontrolliert.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const IGNORE_DIRS = new Set(['.git', 'coverage', 'data', 'node_modules', 'tmp-uploads']);
const TEXT_EXTENSIONS = new Set([
    '.css', '.ejs', '.js', '.json', '.md', '.svg', '.txt', '.yaml', '.yml',
]);
const TEXT_FILENAMES = new Set([
    '.dockerignore', '.editorconfig', '.env.example', '.gitattributes', '.gitignore',
    'Caddyfile', 'Dockerfile',
]);

function collect(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) return [];
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return collect(full);
        if (!entry.isFile()) return [];
        return TEXT_EXTENSIONS.has(path.extname(entry.name)) || TEXT_FILENAMES.has(entry.name)
            ? [full]
            : [];
    });
}

const failures = [];
const files = collect(ROOT);

for (const file of files) {
    const relative = path.relative(ROOT, file);
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');

    if (text.startsWith('\uFEFF')) failures.push(`${relative}: UTF-8-BOM entfernen`);
    if (text.includes('\r')) failures.push(`${relative}: CRLF/CR durch LF ersetzen`);
    if (text.length > 0 && !text.endsWith('\n')) failures.push(`${relative}: abschliessende Leerzeile fehlt`);

    lines.forEach((line, index) => {
        if (/[ \t]+$/.test(line)) {
            failures.push(`${relative}:${index + 1}: Leerzeichen am Zeilenende entfernen`);
        }
    });
}

if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
} else {
    console.log(`${files.length}/${files.length} Textdateien einheitlich formatiert.`);
}
