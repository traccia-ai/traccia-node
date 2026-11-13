/**
 * Spans are exported when the process ends without an explicit stopTracing() (TRC-364):
 * on natural exit (the event loop runs out of work) and on SIGINT/SIGTERM, which must also
 * still terminate the process. These run the built CommonJS SDK in a child Node process,
 * because beforeExit and signals only happen in a real process lifecycle.
 */
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SDK = path.join(__dirname, '../../dist/index.js');

/** Prologue for child scripts: an in-memory exporter that logs what it receives. */
function prologue(label = 'A'): string {
  return `
const sdk = require(${JSON.stringify(SDK)});
function exporter(label) {
  return {
    export: async (spans) => {
      await new Promise((r) => setTimeout(r, 20)); // real async I/O, like a network export
      console.log('EXPORTED ' + label + ' ' + spans.length);
      return true;
    },
    shutdown: async () => console.log('SHUTDOWN ' + label),
  };
}
const base = { loadEnv: false, enableCostTracking: false, enableTokenCounting: false };
const initWith = (label) => sdk.init({ ...base, exporter: exporter(label ?? ${JSON.stringify(label)}) });
const endSpan = (name) => sdk.getTracer('lifecycle').startSpan(name).end();
`;
}

function writeScript(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traccia-lifecycle-'));
  const file = path.join(dir, 'main.cjs');
  fs.writeFileSync(file, prologue() + body);
  return file;
}

function runToExit(body: string): { status: number | null; lines: string[]; stderr: string } {
  const result = spawnSync(process.execPath, [writeScript(body)], { encoding: 'utf8', timeout: 30000 });
  return {
    status: result.status,
    lines: result.stdout.split(/\r?\n/).filter(Boolean),
    stderr: result.stderr,
  };
}

describe('process lifecycle (TRC-364)', () => {
  beforeAll(() => {
    expect(fs.existsSync(SDK)).toBe(true);
  });

  test('natural exit exports ended spans once and shuts the exporter down', () => {
    const { status, lines, stderr } = runToExit(`
(async () => {
  await initWith();
  endSpan('natural-exit');
  console.log('SPAN_ENDED');
})();
`);
    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(lines).toEqual(['SPAN_ENDED', 'EXPORTED A 1', 'SHUTDOWN A']);
  });

  test('explicit stopTracing() is not followed by a second teardown at exit', () => {
    const { status, lines } = runToExit(`
(async () => {
  await initWith();
  endSpan('explicit-stop');
  await sdk.stopTracing();
  console.log('STOPPED');
})();
`);
    expect(status).toBe(0);
    expect(lines).toEqual(['EXPORTED A 1', 'SHUTDOWN A', 'STOPPED']);
  });

  test('concurrent stopTracing() calls tear down once', () => {
    const { status, lines } = runToExit(`
(async () => {
  await initWith();
  endSpan('concurrent-stop');
  await Promise.all([sdk.stopTracing(), sdk.stopTracing()]);
  console.log('STOPPED');
})();
`);
    expect(status).toBe(0);
    expect(lines).toEqual(['EXPORTED A 1', 'SHUTDOWN A', 'STOPPED']);
  });

  test('after stopTracing() and a second init(), exit flushes the new provider', () => {
    const { status, lines } = runToExit(`
(async () => {
  await initWith('A');
  await sdk.stopTracing();
  await initWith('B');
  endSpan('second-init');
})();
`);
    expect(status).toBe(0);
    expect(lines).toEqual(['SHUTDOWN A', 'EXPORTED B 1', 'SHUTDOWN B']);
  });

  test('init() while stopTracing() is running starts a fresh provider', () => {
    const { status, lines } = runToExit(`
(async () => {
  await initWith('A');
  const stopping = sdk.stopTracing();
  await initWith('B');
  await stopping;
  endSpan('after-race');
})();
`);
    expect(status).toBe(0);
    expect(lines).toEqual(['SHUTDOWN A', 'EXPORTED B 1', 'SHUTDOWN B']);
  });

  test('a provider swapped in during stopTracing() does not block the next init()', () => {
    const { status, lines } = runToExit(`
(async () => {
  await initWith('A');
  const stopping = sdk.stopTracing();
  sdk.setTracerProvider(new sdk.TracerProvider());
  await stopping;
  await initWith('B');
  endSpan('after-swap');
})();
`);
    expect(status).toBe(0);
    expect(lines).toEqual(['SHUTDOWN A', 'EXPORTED B 1', 'SHUTDOWN B']);
  });

  test('an export that cannot finish delays natural exit only up to the deadline', () => {
    const started = Date.now();
    const { status, lines } = runToExit(`
(async () => {
  await sdk.init({ ...base, exporter: {
    // Like an exporter retrying an unreachable endpoint: referenced timers, no result.
    export: () => new Promise((resolve) => setTimeout(() => resolve(true), 60000)),
    shutdown: async () => console.log('SHUTDOWN'),
  } });
  endSpan('unreachable');
  process.exitCode = 3;
  console.log('ENDED');
})();
`);
    const elapsed = Date.now() - started;
    expect(lines).toEqual(['ENDED']);
    expect(status).toBe(3); // the app's exit code is kept
    expect(elapsed).toBeLessThan(15000);
  }, 30000);

  // Windows has no catchable POSIX signals: child.kill() there always terminates at once.
  const posix = process.platform === 'win32' ? describe.skip : describe;

  type Exit = { code: number | null; signal: NodeJS.Signals | null; lines: string[] };

  /** Start a child, send `signals` (one per READY/...) once it prints READY, wait for exit. */
  async function signalChild(body: string, signals: NodeJS.Signals[]): Promise<Exit> {
    const child = spawn(process.execPath, [writeScript(body)]);
    let stdout = '';
    let sent = false;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!sent && stdout.includes('READY')) {
        sent = true;
        signals.forEach((sig, i) => setTimeout(() => child.kill(sig), i * 300));
      }
    });
    return new Promise<Exit>((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
      child.on('exit', (code, sig) => {
        clearTimeout(timer);
        resolve({ code, signal: sig, lines: stdout.split(/\r?\n/).filter(Boolean) });
      });
    });
  }

  posix.each(['SIGINT', 'SIGTERM'] as const)('%s', (signal) => {
    test('flushes, then terminates by the signal even with a referenced handle alive', async () => {
      const exit = await signalChild(
        `
(async () => {
  await initWith();
  setInterval(() => {}, 1000); // keeps the event loop alive, like a server
  endSpan('signal');
  console.log('READY');
})();
`,
        [signal],
      );
      expect(exit).toEqual({ code: null, signal, lines: ['READY', 'EXPORTED A 1', 'SHUTDOWN A'] });
    }, 20000);

    test('leaves termination to the app when it handles the signal itself', async () => {
      const exit = await signalChild(
        `
(async () => {
  await initWith();
  const keepAlive = setInterval(() => {}, 1000);
  process.on(${JSON.stringify(signal)}, () => {
    // An app draining connections: it exits on its own schedule.
    setTimeout(() => { clearInterval(keepAlive); console.log('APP_EXIT'); process.exit(7); }, 500);
  });
  endSpan('app-handler');
  console.log('READY');
})();
`,
        [signal],
      );
      expect(exit.code).toBe(7);
      expect(exit.lines).toEqual(['READY', 'EXPORTED A 1', 'SHUTDOWN A', 'APP_EXIT']);
    }, 20000);

    test('a second signal terminates while an export hangs', async () => {
      const exit = await signalChild(
        `
(async () => {
  await sdk.init({ ...base, exporter: {
    export: () => new Promise(() => console.log('HANGING')),
    shutdown: async () => console.log('SHUTDOWN'),
  } });
  setInterval(() => {}, 1000);
  endSpan('hang');
  console.log('READY');
})();
`,
        [signal, signal],
      );
      expect(exit.signal).toBe(signal);
      expect(exit.lines).toEqual(['READY', 'HANGING']);
    }, 20000);
  });
});
