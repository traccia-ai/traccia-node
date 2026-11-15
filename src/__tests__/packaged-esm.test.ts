/**
 * The ES module builds (package.json "exports" → "import") load in a real ES module process.
 * They once threw at import ("Dynamic require of ... is not supported") because require() in the
 * source has no ES module counterpart. Runs against the built dist, like packaged-cost.test.ts.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.join(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  exports: Record<string, { import?: { default?: string }; require?: { default?: string } }>;
};

/** Run an ES module script in a child Node process; returns its stdout. */
function runModule(source: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traccia-esm-'));
  const file = path.join(dir, 'main.mjs');
  fs.writeFileSync(file, source);
  const result = spawnSync(process.execPath, [file], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60000,
    env: { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir },
  });
  if (result.status !== 0) {
    throw new Error(`exit ${String(result.status)}: ${result.stderr || String(result.error)}`);
  }
  return result.stdout;
}

/**
 * ES module body (after importing init/getTracer/stopTracing) that sends a span over OTLP to a
 * collector in the same process and prints whether it arrived. init() builds the OTLP exporter,
 * whose dependencies once needed require().
 */
const EXPORT_CHECK = `
import http from 'http';
let received = 0;
const collector = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => { received += 1; res.end(); });
});
await new Promise((resolve) => collector.listen(0, '127.0.0.1', resolve));
await init({
  apiKey: 'tr_test_esm',
  endpoint: 'http://127.0.0.1:' + collector.address().port + '/v1/traces',
  useOtlp: true,
});
getTracer('esm-check').startSpan('esm-span').end();
await stopTracing();
collector.close();
console.log(received > 0 ? 'exported' : 'not exported');
`;

const entries = Object.entries(pkg.exports).filter(
  ([, target]) => target.import?.default?.endsWith('.mjs') && target.require?.default
);

describe('packaged ES module builds', () => {
  test('package.json exports ES module builds', () => {
    expect(entries.map(([name]) => name)).toEqual(expect.arrayContaining(['.', './auto']));
  });

  test.each(entries)('%s loads as an ES module with the CommonJS build exports', (_name, target) => {
    const esm = path.join(ROOT, target.import!.default!);
    const cjs = path.join(ROOT, target.require!.default!);
    expect(fs.existsSync(esm)).toBe(true);
    const out = runModule(`
import { createRequire } from 'module';
const esm = await import(${JSON.stringify(pathToFileURL(esm).href)});
const cjs = createRequire(import.meta.url)(${JSON.stringify(cjs)});
console.log(JSON.stringify({ esm: Object.keys(esm).sort(), cjs: Object.keys(cjs).sort() }));
`);
    const keys = JSON.parse(out.trim().split('\n').pop()!) as { esm: string[]; cjs: string[] };
    expect(keys.esm.length).toBeGreaterThan(0);
    expect(keys.esm).toEqual(keys.cjs.filter((key) => key !== 'default' && key !== '__esModule'));
  });

  test('init() and stopTracing() from @traccia/sdk/auto run in an ES module app', () => {
    const auto = pathToFileURL(path.join(ROOT, pkg.exports['./auto'].import!.default!)).href;
    const out = runModule(`
import { init, getTracer, stopTracing } from ${JSON.stringify(auto)};
${EXPORT_CHECK}
`);
    expect(out.trim().split('\n').pop()).toBe('exported');
  });

  test('a "type": "module" app imports @traccia/sdk and @traccia/sdk/auto by name', () => {
    // Install the package by linking it into the app's node_modules, so the bare specifiers
    // resolve through package.json "exports" as they do for a user.
    const app = fs.mkdtempSync(path.join(os.tmpdir(), 'traccia-esm-app-'));
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'esm-app', type: 'module' }));
    fs.mkdirSync(path.join(app, 'node_modules', '@traccia'), { recursive: true });
    fs.symlinkSync(ROOT, path.join(app, 'node_modules', '@traccia', 'sdk'), 'junction');
    fs.writeFileSync(
      path.join(app, 'main.js'),
      `
import * as sdk from '@traccia/sdk';
import { init, getTracer, stopTracing } from '@traccia/sdk/auto';
if (typeof sdk.init !== 'function') throw new Error('@traccia/sdk has no init');
${EXPORT_CHECK}
`,
    );
    const result = spawnSync(process.execPath, ['main.js'], {
      cwd: app,
      encoding: 'utf8',
      timeout: 60000,
      env: { PATH: process.env.PATH, HOME: app, USERPROFILE: app },
    });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(result.stdout.trim().split('\n').pop()).toBe('exported');
  });
});
