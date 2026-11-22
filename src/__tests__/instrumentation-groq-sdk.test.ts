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
  interrupted: Array<string | null>;
  usage: Array<{ source?: string; prompt?: number; completion?: number }>;
  aborted: boolean[];
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
      `export { _setPepHttpClientForTests, settleOpenCalls, drainOpenCalls } from ${from('governance/pep')};`,
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
      expect(result.usage).toEqual([{ source: 'provider_usage', prompt: 12, completion: 3 }]);
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

  it.each(['streamDroppedUnread', 'streamDroppedPartlyRead'])(
    '%s: a dropped stream ends its span and settles once collected',
    (name) => {
      const result = run.results[name];
      expect(result.error).toBeUndefined();
      expect(result.checks).toBe(1);
      expect(result.spans).toEqual([{ ended: 1, vendor: 'groq' }]);
      // Dropped unfinished: the request is aborted, so Groq stops generating it, and what it
      // generated is unknown without usage, so the call is charged its full reservation.
      expect(result.settles).toEqual([
        { agent_id: 'agent-a', reserved_usd: 0.5, actual_usd: 0.5, release: false },
      ]);
      expect(result.aborted).toEqual([true]);
      expect(result.interrupted).toEqual(['abandoned']);
    }
  );

  it('a stream open at shutdown is aborted, charged its reservation, and records its estimate', () => {
    const result = run.results.streamOpenAtShutdown;
    expect(result.error).toBeUndefined();
    expect(result.checks).toBe(1);
    expect(result.spans).toEqual([{ ended: 1, vendor: 'groq' }]);
    expect(result.settles).toEqual([
      { agent_id: 'agent-a', reserved_usd: 0.5, actual_usd: 0.5, release: false },
    ]);
    expect(result.aborted).toEqual([true]);
    expect(result.interrupted).toEqual(['shutdown']);
    expect(result.usage).toEqual([{ source: 'estimated', prompt: 4, completion: 1 }]);
  });

  it('a dropped stream records the estimate of what was read, and nothing when nothing was', () => {
    // 'Capital of France?' is 4 prompt tokens; 'Par' is 1 output token.
    expect(run.results.streamDroppedPartlyRead.usage).toEqual([{ source: 'estimated', prompt: 4, completion: 1 }]);
    expect(run.results.streamDroppedUnread.usage).toEqual([{}]);
    expect(run.results.fireAndForget.usage).toEqual([{}]);
  });

  it('a loop stopped with break settles an estimate, not the reservation', () => {
    const result = run.results.streamBreak;
    expect(result.settles).toEqual([
      expect.objectContaining({ release: false, model: 'llama-3.3-70b-versatile', output_tokens: 1 }),
    ]);
    expect(result.settles[0].actual_usd).not.toBe(0.5);
    // The span records the counts settled.
    expect(result.usage).toEqual([
      { source: 'estimated', prompt: result.settles[0].input_tokens, completion: result.settles[0].output_tokens },
    ]);
    // Not interrupted (the fixture's JSON output turns the missing attribute into null).
    expect(result.interrupted).toEqual([null]);
  });

  it.each(['asResponseSlowRequest', 'asResponseSlowCheck'])(
    '%s: collecting the create() promise mid-flight neither ends nor settles the call early',
    (name) => {
      const result = run.results[name] as Scenario & { endedBeforeResponse: number };
      expect(result.error).toBeUndefined();
      expect(result.endedBeforeResponse).toBe(0);
      expect(result.checks).toBe(1);
      expect(result.spans).toEqual([{ ended: 1, vendor: 'groq' }]);
      // Settled with the usage read from the raw response, not the full reservation.
      expect(result.settles).toEqual([PRICED_SETTLE]);
    }
  );

  it('a call never awaited, collected while its policy check is pending, settles that check', () => {
    const result = run.results.fireAndForgetSlowCheck;
    expect(result.checks).toBe(1);
    expect(result.spans).toEqual([{ ended: 1, vendor: 'groq' }]);
    expect(result.settles).toEqual([
      { agent_id: 'agent-a', reserved_usd: 0.5, actual_usd: 0.5, release: false },
    ]);
  });

  it.each(['secondIterator', 'teeAfterReading'])(
    '%s: a refused second reader does not end the call, which settles its usage',
    (name) => {
      const result = run.results[name] as Scenario & { refused?: string };
      expect(result.refused).toMatch(/consumed stream/);
      expect(result.error).toBeUndefined();
      expect(result.spans).toEqual([{ ended: 1, vendor: 'groq' }]);
      expect(result.settles).toEqual([PRICED_SETTLE]);
      expect(result.usage).toEqual([{ source: 'provider_usage', prompt: 12, completion: 3 }]);
    }
  );

  it.each(['returnBeforeNext', 'cancelReadableBeforeReading'])(
    '%s: a reader that never read leaves the stream to be read in full, which settles its usage',
    (name) => {
      const result = run.results[name] as Scenario & { text?: string };
      expect(result.error).toBeUndefined();
      expect(result.text).toBe('Paris.');
      expect(result.spans).toEqual([{ ended: 1, vendor: 'groq' }]);
      expect(result.settles).toEqual([PRICED_SETTLE]);
      expect(result.usage).toEqual([{ source: 'provider_usage', prompt: 12, completion: 3 }]);
      expect(result.aborted).toEqual([false]);
    }
  );

  it('a stream cancelled before reading and then dropped is stopped and charged once collected', () => {
    const result = run.results.cancelReadableThenDrop;
    expect(result.spans).toEqual([{ ended: 1, vendor: 'groq' }]);
    expect(result.interrupted).toEqual(['abandoned']);
    expect(result.aborted).toEqual([true]);
    expect(result.settles).toEqual([{ agent_id: 'agent-a', reserved_usd: 0.5, actual_usd: 0.5, release: false }]);
  });

  it.each(['ungovernedStopThenDrop', 'drainTimeoutThenDrop'])(
    '%s: a stream left going at shutdown is stopped once the app drops it, settled once',
    (name) => {
      const result = run.results[name] as Scenario & { abortedBeforeDrop: boolean };
      expect(result.abortedBeforeDrop).toBe(false);
      expect(result.aborted).toEqual([true]);
      expect(result.spans).toEqual([{ ended: 1, vendor: 'groq' }]);
      expect(result.interrupted).toEqual(['shutdown']);
      // Ungoverned: no check and nothing to settle.
      expect(result.checks).toBe(name === 'drainTimeoutThenDrop' ? 1 : 0);
      expect(result.settles).toEqual(
        name === 'drainTimeoutThenDrop'
          ? [{ agent_id: 'agent-a', reserved_usd: 0.5, actual_usd: 0.5, release: false }]
          : []
      );
    }
  );

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
