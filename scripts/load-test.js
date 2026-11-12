'use strict';

const { performance } = require('perf_hooks');

const baseUrl = new URL(process.env.LOAD_TEST_URL || 'http://127.0.0.1:3000');
const durationSeconds = positiveNumber(process.env.LOAD_TEST_SECONDS, 20);
const concurrency = positiveNumber(process.env.LOAD_TEST_CONCURRENCY, 8);
const maxP95Ms = positiveNumber(process.env.LOAD_TEST_MAX_P95_MS, 750);
const cookie = process.env.LOAD_TEST_COOKIE || '';
const paths = String(process.env.LOAD_TEST_PATHS || '/healthz,/support,/support?q=passwort')
    .split(',')
    .map(value => value.trim())
    .filter(value => value.startsWith('/') && !value.startsWith('//'));

function positiveNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(values, fraction) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function main() {
    if (paths.length === 0) throw new Error('LOAD_TEST_PATHS enthält keinen sicheren relativen Pfad.');

    const deadline = performance.now() + durationSeconds * 1000;
    const latencies = [];
    const failures = [];
    let requests = 0;
    let cursor = 0;

    async function worker() {
        while (performance.now() < deadline) {
            const path = paths[cursor++ % paths.length];
            const started = performance.now();
            try {
                const response = await fetch(new URL(path, baseUrl), {
                    headers: cookie ? { Cookie: cookie } : {},
                    redirect: 'manual',
                    signal: AbortSignal.timeout(10_000),
                });
                await response.arrayBuffer();
                if (response.status >= 500 || response.status === 429) {
                    failures.push(`${path}: HTTP ${response.status}`);
                }
            } catch (err) {
                failures.push(`${path}: ${err.message}`);
            } finally {
                latencies.push(performance.now() - started);
                requests++;
            }
        }
    }

    const started = performance.now();
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    const elapsedSeconds = (performance.now() - started) / 1000;
    const p50 = percentile(latencies, 0.50);
    const p95 = percentile(latencies, 0.95);
    const p99 = percentile(latencies, 0.99);
    const errorRate = requests > 0 ? failures.length / requests : 1;

    console.log(JSON.stringify({
        baseUrl: baseUrl.origin,
        paths,
        durationSeconds: Number(elapsedSeconds.toFixed(2)),
        concurrency,
        requests,
        requestsPerSecond: Number((requests / elapsedSeconds).toFixed(1)),
        latencyMs: { p50: Number(p50.toFixed(1)), p95: Number(p95.toFixed(1)), p99: Number(p99.toFixed(1)) },
        errors: failures.length,
        errorRate: Number(errorRate.toFixed(4)),
        examples: failures.slice(0, 5),
    }, null, 2));

    if (errorRate > 0.01) throw new Error(`Fehlerrate ${(errorRate * 100).toFixed(2)} % ist größer als 1 %.`);
    if (p95 > maxP95Ms) throw new Error(`p95 ${p95.toFixed(1)} ms überschreitet ${maxP95Ms} ms.`);
}

main().catch(err => {
    console.error(`Lasttest fehlgeschlagen: ${err.message}`);
    process.exitCode = 1;
});
