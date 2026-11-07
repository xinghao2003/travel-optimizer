// Fresh Chromium per trial, identical solver inputs, no provider calls.
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { chromium } = require('../frontend/node_modules/@playwright/test');
const root = path.resolve(__dirname, '..');
const trials = Number(process.argv[2] || 1);
const baseURL = process.env.POC_BASE_URL || 'http://127.0.0.1:5174';
const cache = process.env.POC_PYODIDE_CACHE;

async function browserBytes(browser) {
  if (process.platform !== 'win32') return null;
  const cdp = await browser.newBrowserCDPSession();
  const info = await cdp.send('SystemInfo.getProcessInfo');
  await cdp.detach();
  const ids = [...new Set(info.processInfo.map(item => item.id).filter(id => Number.isInteger(id) && id > 0))];
  const command = `(Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum`;
  const output = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true });
  return Number(output.stdout.trim());
}

(async () => {
  const artifact = JSON.parse(await fs.readFile(path.join(root, 'data/diagnostics/native-comparison/saved-trip.json'), 'utf8'));
  const report = { source: '2525466', trials: [], memory_scope: 'Sum of Chromium process working sets after a complete solve with solver checkpoints retained; not peak or unique physical memory.' };
  for (let trial = 0; trial < trials; trial++) {
    for (const kind of trial % 2 ? ['python', 'native'] : ['native', 'python']) {
      console.log(JSON.stringify({ trial: trial + 1, kind, phase: 'starting' }));
      const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'chrome' : undefined, headless: true, args: ['--js-flags=--expose-gc'] });
      try {
        const page = await browser.newPage();
        if (cache) await page.route('https://cdn.jsdelivr.net/pyodide/v314.0.7/full/**', async route => {
          const name = new URL(route.request().url()).pathname.split('/').pop();
          await route.fulfill({ body: await fs.readFile(path.join(cache, name)), contentType: /\.m?js$/.test(name) ? 'text/javascript' : name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream', headers: { 'Access-Control-Allow-Origin': '*' } });
        });
        await page.route('**/benchmark-blank', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Solver benchmark</title>' }));
        await page.goto(baseURL + '/benchmark-blank');
        const baseline = await browserBytes(browser);
        const metrics = await page.evaluate(async ({ kind, artifact }) => {
          const { SolverRunner, firstDifference } = await import('/src/prototype/comparison.ts');
          const runner = new SolverRunner(kind);
          globalThis.benchmarkRunner = runner;
          const measurement = await runner.run(artifact.input);
          const mismatch = firstDifference(artifact.expected, measurement.result);
          return { solve_ms: measurement.solve_ms, wall_ms: measurement.wall_ms, validation_ms: measurement.validation_ms,
            wasm_memory_bytes: measurement.wasm_memory_bytes, mismatch,
            expanded: measurement.result.expanded_labels, pruned: measurement.result.pruned_labels,
            feasible: measurement.result.feasible_count, routes: measurement.result.routes.length,
            complete: measurement.result.optimization_complete };
        }, { kind, artifact });
        const after = await browserBytes(browser);
        const gc = await page.workers()[0].evaluate(() => { if (typeof globalThis.gc === 'function') { globalThis.gc(); return true; } return false; });
        await page.evaluate(() => { if (typeof globalThis.gc === 'function') globalThis.gc(); });
        const afterGc = await browserBytes(browser);
        const row = { trial: trial + 1, kind, ...metrics, browser_before_bytes: baseline, browser_after_bytes: after, browser_increase_bytes: after === null ? null : after - baseline,
          gc_available: gc, browser_after_gc_bytes: afterGc, browser_increase_after_gc_bytes: afterGc === null ? null : afterGc - baseline };
        report.trials.push(row);
        console.log(JSON.stringify(row));
        await fs.writeFile(path.join(root, 'data/diagnostics/native-comparison/browser-benchmark.json'), JSON.stringify(report, null, 2));
        if (row.mismatch || !row.complete) process.exitCode = 1;
      } finally { await browser.close(); }
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
