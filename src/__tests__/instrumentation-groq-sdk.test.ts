/**
 * Regression tests against the real groq-sdk (a devDependency), loaded both as an ES module
 * and as CommonJS. ES module loading needs a real Node process, so the integration is bundled
 * with esbuild and driven by fixtures/groq-sdk-e2e.mjs in a child process.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildSync } from 'esbuild';
import { SpanStatus } from '../types';

const SRC = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'groq-sdk-e2e.mjs');
const PRICED_SETTLE = {
  agent_id: 'agent-a',
  reserved_usd: 0.5,
  release: false,
  model: 'llama-3.3-70b-versatile',
  vendor: 'groq',
  input_tokens: 12,
  output_tokens: 3,
};
const RELEASE_SETTLE = { agent_id: 'agent-a', reserved_usd: 0.5, release: true };

interface Scenario {
  error?: string;
  checks: number;
  settles: Array<Record<string, unknown>>;
  spans: Array<{ ended: number; vendor: string; status?: SpanStatus }>;
}
interface Run {
  patchGroq: boolean;
  patchGroqEsm: boolean;
  results: Record<string, Scenario>;
}

let workDir: string;
let libPath: string;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traccia-groq-e2e-'));
  const entry = path.join(workDir, 'entry.ts');
  const from = (rel: string): string => JSON.stringify(path.join(SRC, rel).replace(/\\/g, '/'));
  fs.writeFileSync(
    entry,
    [
      `export { patchGroq, patchGroqEsm } from ${from('instrumentation/groq')};`,
      `export { setTracerProvider } from ${from('auto')};`,
      `export { _setPepHttpClientForTests } from ${from('governance/pep')};`,
      `export { runIdentity } from ${from('config/runtime-config')};`,
    ].join('\n')
  );
  libPath = path.join(workDir, 'lib.cjs');
  buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: libPath,
    external: ['groq-sdk', 'groq-sdk/*'],
    logLevel: 'silent',
  });
}, 60000);

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function runFixture(mode: 'esm' | 'cjs'): Run {
  // cwd is the package root, as an app's would be, so groq-sdk resolves from it.
  const out = spawnSync(process.execPath, ['--expose-gc', FIXTURE, libPath, mode], {
    cwd: path.resolve(SRC, '..'),
    encoding: 'utf-8',
    timeout: 60000,
  });
  if (out.status !== 0) {
    throw new Error(`fixture failed (${String(out.status)}): ${out.stderr}`);
  }
  return JSON.parse(out.stdout) as Run;
}

describe.each(['esm', 'cjs'] as const)('real groq-sdk loaded as %s', (mode) => {
  let run: Run;

  beforeAll(() => {
    run = runFixture(mode);
  }, 60000);

  it('patches both builds of groq-sdk', () => {
    expect(run.patchGroq).toBe(true);
    expect(run.patchGroqEsm).toBe(true);
  });

  it.each(['await', 'withResponse', 'stream', 'toReadableStream', 'tee'])(
    '%s: one policy check, one span ended once, one priced settle',
    (name) => {
      const result = run.results[name];
      expect(result.error).toBeUndefined();
      expect(result.checks).toBe(1);
      expect(result.spans).toEqual([{ ended: 1, vendor: 'groq' }]);
      expect(result.settles).toEqual([PRICED_SETTLE]);
    }
  );

  it('a loop stopped on the first chunk settles once and is charged', () => {
    const result = run.results.streamBreak;
    expect(result.checks).toBe(1);
    expect(result.spans).toEqual([{ ended: 1, vendor: 'groq' }]);
    expect(result.settles).toHaveLength(1);
    expect(result.settles[0].release).toBe(false);
  });

  it('a call that is never awaited still ends its span and is charged once collected', () => {
    const result = run.results.fireAndForget;
    expect(result.checks).toBe(1);
    expect(result.spans).toEqual([{ ended: 1, vendor: 'groq' }]);
    // Nothing of the response was read, so its usage is unknown: the full reservation.
    expect(result.settles).toEqual([
      { agent_id: 'agent-a', reserved_usd: 0.5, actual_usd: 0.5, release: false },
    ]);
  });

  it.each(['httpError', 'abortedBeforeSend'])(
    '%s: the error reaches the caller, the span errors, and the reservation is released',
    (name) => {
      const result = run.results[name];
      expect(result.error).toBeDefined();
      expect(result.checks).toBe(1);
      expect(result.spans).toEqual([{ ended: 1, vendor: 'groq', status: SpanStatus.ERROR }]);
      expect(result.settles).toEqual([RELEASE_SETTLE]);
    }
  );
});
