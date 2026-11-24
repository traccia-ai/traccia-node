/**
 * TRC-297: concurrent or failed init() must not leave an incomplete singleton.
 */
import { init, stopTracing, isTracingStarted, runtimeState, getTracerProvider } from '../auto';
import { loadPricingWithSource } from '../config/pricing-config';
import { loadConfig } from '../config/config';
import { configureGovernance } from '../governance/config';
import { getClientConfig, setClientConfig, clearClientConfig } from '../config/client-config';
import { getResolver, setResolver, peekResolver, restoreResolver, CostResolver } from '../processor/cost-resolver';
import { TracerProvider } from '../tracer/provider';
import { ISpanExporter, ISpanProcessor, SDKConfig } from '../types';

jest.mock('../config/config', () => ({
  loadConfig: jest.fn(),
  findConfigFile: jest.fn().mockReturnValue(undefined),
  ENV_VAR_MAPPING: {},
}));

jest.mock('../config/pricing-config', () => {
  const actual = jest.requireActual('../config/pricing-config');
  return { ...actual, loadPricingWithSource: jest.fn() };
});

jest.mock('../governance/config', () => {
  const actual = jest.requireActual('../governance/config');
  return { ...actual, configureGovernance: jest.fn(actual.configureGovernance) };
});

const mockLoadPricing = loadPricingWithSource as jest.MockedFunction<typeof loadPricingWithSource>;
const mockLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>;
const mockConfigureGovernance = configureGovernance as jest.MockedFunction<typeof configureGovernance>;

const PRICING_OK: Awaited<ReturnType<typeof loadPricingWithSource>> = [
  { 'gpt-4o': { inputCost: 1, outputCost: 2 } } as never,
  'override' as never,
  'test' as never,
];

function baseLoadedConfig(): ReturnType<typeof loadConfig> {
  return {
    tracing: { use_otlp: true },
    exporters: { enable_console: false },
    instrumentation: { enable_patching: false },
    rate_limiting: {},
    logging: {},
    advanced: {},
  } as unknown as ReturnType<typeof loadConfig>;
}

/** Every deferred a test created, so afterEach can release a setup a failed test left paused. */
const pendingDeferreds: Array<{ resolve: (v: never) => void }> = [];

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const d = { promise, resolve, reject };
  pendingDeferreds.push(d as unknown as { resolve: (v: never) => void });
  return d;
}

function fakeExporter(): ISpanExporter & { export: jest.Mock; shutdown: jest.Mock } {
  return {
    export: jest.fn().mockResolvedValue(true),
    shutdown: jest.fn().mockResolvedValue(undefined),
  };
}

function processorsOf(provider: TracerProvider): ISpanProcessor[] {
  return (provider as unknown as { spanProcessors: ISpanProcessor[] }).spanProcessors;
}

function cfg(extra: SDKConfig = {}): SDKConfig {
  return { loadEnv: false, exporter: fakeExporter(), ...extra };
}

/** Let pending microtasks and a macrotask run. */
async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

/** Processors a clean, successful init() adds with these settings. */
let expectedProcessorCount: number;
/** The SIGTERM/SIGINT listener init() registers. */
let signalHook: () => Promise<void>;

beforeAll(async () => {
  mockLoadConfig.mockReturnValue(baseLoadedConfig());
  mockLoadPricing.mockResolvedValue(PRICING_OK);
  const before = process.listeners('SIGTERM');
  const provider = await init(cfg());
  const added = process.listeners('SIGTERM').filter((l) => !before.includes(l));
  expect(added).toHaveLength(1);
  signalHook = added[0] as () => Promise<void>;
  expectedProcessorCount = processorsOf(provider).length;
  await stopTracing();
});

beforeEach(async () => {
  await stopTracing();
  const state = runtimeState();
  state.provider = null;
  state.started = false;
  state.initializing = undefined;
  jest.clearAllMocks();
  mockLoadConfig.mockReturnValue(baseLoadedConfig());
  mockLoadPricing.mockResolvedValue(PRICING_OK);
});

afterEach(async () => {
  // A test that failed before settling its pricing promise would otherwise leave init() paused,
  // and every later stopTracing() would wait on it. Resolve (not reject), so the abandoned init()
  // does not surface as an unhandled rejection in the next test. Settling twice is a no-op.
  for (const d of pendingDeferreds.splice(0)) d.resolve(PRICING_OK as never);
  await runtimeState().initializing?.catch(() => undefined);
});

afterAll(async () => {
  await stopTracing();
});

describe('TRC-297 init lifecycle', () => {
  it('sanity: a clean init adds the full processor chain', () => {
    // Token counting, cost, agent enrichment, guardrail, governance, batch.
    expect(expectedProcessorCount).toBe(6);
  });

  describe('concurrent init()', () => {
    it('second call waits for the first and gets the fully configured provider', async () => {
      const pricing = deferred<typeof PRICING_OK>();
      mockLoadPricing.mockReturnValueOnce(pricing.promise);

      const first = init(cfg());
      await flush();
      // Setup is parked inside pricing: not started yet.
      expect(isTracingStarted()).toBe(false);

      let secondSettled = false;
      const second = init(cfg()).then((p) => {
        secondSettled = true;
        return p;
      });
      await flush();
      expect(secondSettled).toBe(false);

      pricing.resolve(PRICING_OK);
      const [p1, p2] = await Promise.all([first, second]);

      expect(p2).toBe(p1);
      expect(processorsOf(p2)).toHaveLength(expectedProcessorCount);
      expect(isTracingStarted()).toBe(true);
      // One setup, not two.
      expect(mockLoadPricing).toHaveBeenCalledTimes(1);
      expect(mockLoadConfig).toHaveBeenCalledTimes(1);
    });

    it('many concurrent calls share one setup and add no duplicate processors', async () => {
      const pricing = deferred<typeof PRICING_OK>();
      mockLoadPricing.mockReturnValueOnce(pricing.promise);

      let settledEarly = 0;
      const calls = Array.from({ length: 10 }, () =>
        init(cfg()).then((p) => {
          // Every caller must see the whole chain the moment it resolves.
          if (processorsOf(p).length !== expectedProcessorCount) settledEarly++;
          return p;
        }),
      );
      await flush();
      expect(isTracingStarted()).toBe(false);
      pricing.resolve(PRICING_OK);
      const providers = await Promise.all(calls);

      expect(settledEarly).toBe(0);
      expect(new Set(providers).size).toBe(1);
      expect(processorsOf(providers[0])).toHaveLength(expectedProcessorCount);
      expect(mockLoadPricing).toHaveBeenCalledTimes(1);
    });

    it("applies a waiting call's governance config after setup, like a call after start (TRC-342)", async () => {
      const pricing = deferred<typeof PRICING_OK>();
      mockLoadPricing.mockReturnValueOnce(pricing.promise);

      const first = init(cfg({ policyFailMode: 'open' }));
      await flush();
      const second = init(cfg({ policyFailMode: 'closed' }));
      await flush();
      pricing.resolve(PRICING_OK);
      await Promise.all([first, second]);

      const modes = mockConfigureGovernance.mock.calls.map((c) => c[0]?.policyFailMode);
      expect(modes).toEqual(['open', 'closed']);
    });

    it('init() after a successful start returns the same provider without re-running setup', async () => {
      const p1 = await init(cfg());
      const p2 = await init(cfg());
      expect(p2).toBe(p1);
      expect(processorsOf(p1)).toHaveLength(expectedProcessorCount);
      expect(mockLoadPricing).toHaveBeenCalledTimes(1);
    });
  });

  describe('failed init()', () => {
    it('leaves started false and rolls back the partial setup', async () => {
      const provider = getTracerProvider();
      expect(processorsOf(provider)).toHaveLength(0);
      expect(provider.getSampler()).toBeUndefined();
      const resolverBefore = getResolver();
      expect(getClientConfig()).toBeUndefined();

      mockLoadPricing.mockRejectedValueOnce(new Error('pricing boom'));
      await expect(init(cfg({ apiKey: 'k-1', endpoint: 'https://x.example/v1/traces' }))).rejects.toThrow(
        'pricing boom',
      );

      expect(isTracingStarted()).toBe(false);
      expect(runtimeState().initializing).toBeUndefined();
      expect(processorsOf(provider)).toHaveLength(0);
      expect(provider.getSampler()).toBeUndefined();
      expect(getClientConfig()).toBeUndefined();
      expect(getResolver()).toBe(resolverBefore);
    });

    it('shuts down the processors the failed attempt added', async () => {
      const provider = getTracerProvider();
      const before = processorsOf(provider).slice();
      const pricing = deferred<typeof PRICING_OK>();
      mockLoadPricing.mockReturnValueOnce(pricing.promise);

      const attempt = init(cfg());
      await flush();
      // Token counting was added before pricing; spy on it.
      const added = processorsOf(provider).filter((p) => !before.includes(p));
      expect(added.length).toBeGreaterThan(0);
      const spies = added.map((p) => jest.spyOn(p, 'shutdown'));

      pricing.reject(new Error('late failure'));
      await expect(attempt).rejects.toThrow('late failure');
      for (const spy of spies) expect(spy).toHaveBeenCalled();
    });

    it('a retry after failure runs setup again and fully configures the provider', async () => {
      mockLoadPricing.mockRejectedValueOnce(new Error('pricing boom'));
      await expect(init(cfg())).rejects.toThrow('pricing boom');

      const provider = await init(cfg());
      expect(isTracingStarted()).toBe(true);
      expect(processorsOf(provider)).toHaveLength(expectedProcessorCount);
      expect(provider.getSampler()).toBeDefined();
      expect(mockLoadPricing).toHaveBeenCalledTimes(2);
    });

    it('repeated failures do not accumulate processors', async () => {
      for (let i = 0; i < 3; i++) {
        mockLoadPricing.mockRejectedValueOnce(new Error(`boom ${i}`));
        await expect(init(cfg())).rejects.toThrow(`boom ${i}`);
        expect(processorsOf(getTracerProvider())).toHaveLength(0);
        expect(isTracingStarted()).toBe(false);
      }
      const provider = await init(cfg());
      expect(processorsOf(provider)).toHaveLength(expectedProcessorCount);
    });

    it('a synchronous config error also rolls back and can be retried', async () => {
      mockLoadConfig.mockImplementationOnce(() => {
        throw new Error('bad config file');
      });
      await expect(init(cfg())).rejects.toThrow('bad config file');
      expect(isTracingStarted()).toBe(false);
      expect(processorsOf(getTracerProvider())).toHaveLength(0);

      const provider = await init(cfg());
      expect(isTracingStarted()).toBe(true);
      expect(processorsOf(provider)).toHaveLength(expectedProcessorCount);
    });

    it('concurrent callers waiting on a failed setup all reject with its error, then a retry succeeds', async () => {
      const pricing = deferred<typeof PRICING_OK>();
      mockLoadPricing.mockReturnValueOnce(pricing.promise);

      const first = init(cfg());
      await flush();
      const second = init(cfg());
      const third = init(cfg());
      await flush();
      const err = new Error('shared failure');
      pricing.reject(err);

      await expect(first).rejects.toBe(err);
      await expect(second).rejects.toBe(err);
      await expect(third).rejects.toBe(err);
      expect(isTracingStarted()).toBe(false);
      expect(processorsOf(getTracerProvider())).toHaveLength(0);
      expect(mockLoadPricing).toHaveBeenCalledTimes(1);

      const provider = await init(cfg());
      expect(processorsOf(provider)).toHaveLength(expectedProcessorCount);
      expect(isTracingStarted()).toBe(true);
    });

    it('keeps processors that others added to the provider during the failed setup', async () => {
      const provider = getTracerProvider();
      const pricing = deferred<typeof PRICING_OK>();
      mockLoadPricing.mockReturnValueOnce(pricing.promise);

      const attempt = init(cfg());
      await flush();
      const foreign: ISpanProcessor = {
        onStart: jest.fn(),
        onEnd: jest.fn(),
        shutdown: jest.fn().mockResolvedValue(undefined),
        forceFlush: jest.fn().mockResolvedValue(undefined),
      } as unknown as ISpanProcessor;
      provider.addSpanProcessor(foreign);

      pricing.reject(new Error('boom'));
      await expect(attempt).rejects.toThrow('boom');
      expect(processorsOf(provider)).toEqual([foreign]);
      expect(foreign.shutdown).not.toHaveBeenCalled();
    });

    it('restores client credentials and resolver that were set before the failed init', async () => {
      setClientConfig('prev-key', 'https://prev.example/v1/traces');
      const prevResolver = new CostResolver({}, 'default', 'prev');
      setResolver(prevResolver);

      // Pricing runs after init() has replaced the credentials.
      mockLoadPricing.mockRejectedValueOnce(new Error('boom'));
      await expect(init(cfg({ apiKey: 'new-key', endpoint: 'https://new.example/v1/traces' }))).rejects.toThrow(
        'boom',
      );

      expect(getClientConfig()).toEqual({ apiKey: 'prev-key', endpoint: 'https://prev.example/v1/traces' });
      expect(getResolver()).toBe(prevResolver);
      clearClientConfig();
    });

    it('a failure with no resolver set before leaves none, and does not create one to save it', async () => {
      restoreResolver(undefined);
      const pricing = deferred<typeof PRICING_OK>();
      mockLoadPricing.mockReturnValueOnce(pricing.promise);

      const attempt = init(cfg());
      await flush();
      // Saving the previous resolver must not build one (that parses the bundled snapshot).
      expect(peekResolver()).toBeUndefined();
      pricing.reject(new Error('boom'));
      await expect(attempt).rejects.toThrow('boom');
      expect(peekResolver()).toBeUndefined();
    });

    it('init() with cost tracking off creates no resolver', async () => {
      restoreResolver(undefined);
      await init(cfg({ enableCostTracking: false }));
      expect(peekResolver()).toBeUndefined();
    });
  });

  describe('stop / re-init lifecycle', () => {
    it('stopTracing() during setup waits for it, then stops cleanly', async () => {
      const exporter = fakeExporter();
      const pricing = deferred<typeof PRICING_OK>();
      mockLoadPricing.mockReturnValueOnce(pricing.promise);

      const starting = init(cfg({ exporter }));
      await flush();
      const stopping = stopTracing();
      await flush();
      // The stop has not torn the half-built provider down.
      expect(exporter.shutdown).not.toHaveBeenCalled();

      pricing.resolve(PRICING_OK);
      const provider = await starting;
      await stopping;

      expect(processorsOf(provider)).toHaveLength(expectedProcessorCount);
      expect(exporter.shutdown).toHaveBeenCalled();
      expect(isTracingStarted()).toBe(false);
      expect(runtimeState().provider).toBeNull();
    });

    it('the SIGTERM/SIGINT hook during setup waits for it, then shuts the whole provider down', async () => {
      const exporter = fakeExporter();
      const pricing = deferred<typeof PRICING_OK>();
      mockLoadPricing.mockReturnValueOnce(pricing.promise);

      const starting = init(cfg({ exporter }));
      await flush();
      const provider = runtimeState().provider!;
      let hookDone = false;
      const hook = signalHook().then(() => {
        hookDone = true;
      });
      await flush();
      expect(hookDone).toBe(false);
      expect(exporter.shutdown).not.toHaveBeenCalled();

      pricing.resolve(PRICING_OK);
      await starting;
      await hook;
      // The batch processor (and its exporter) was added before the shutdown, so it was shut down.
      expect(processorsOf(provider)).toHaveLength(expectedProcessorCount);
      expect(exporter.shutdown).toHaveBeenCalled();
    });

    it('the signal hook during a setup that fails still completes', async () => {
      const pricing = deferred<typeof PRICING_OK>();
      mockLoadPricing.mockReturnValueOnce(pricing.promise);

      const starting = init(cfg());
      await flush();
      const hook = signalHook();
      pricing.reject(new Error('boom'));
      await expect(starting).rejects.toThrow('boom');
      await expect(hook).resolves.toBeUndefined();
    });

    it('stopTracing() during a setup that fails still completes', async () => {
      const pricing = deferred<typeof PRICING_OK>();
      mockLoadPricing.mockReturnValueOnce(pricing.promise);

      const starting = init(cfg());
      await flush();
      const stopping = stopTracing();
      pricing.reject(new Error('boom'));

      await expect(starting).rejects.toThrow('boom');
      await expect(stopping).resolves.toBeUndefined();
      expect(isTracingStarted()).toBe(false);
    });

    it('init() during stopTracing() waits for the stop, then initializes a fresh provider', async () => {
      const oldExporter = fakeExporter();
      const oldProvider = await init(cfg({ exporter: oldExporter }));
      expect(isTracingStarted()).toBe(true);

      const stopping = stopTracing();
      const newExporter = fakeExporter();
      const restarted = init(cfg({ exporter: newExporter }));

      await stopping;
      const newProvider = await restarted;

      expect(oldExporter.shutdown).toHaveBeenCalled();
      expect(newProvider).not.toBe(oldProvider);
      expect(runtimeState().provider).toBe(newProvider);
      expect(isTracingStarted()).toBe(true);
      expect(processorsOf(newProvider)).toHaveLength(expectedProcessorCount);
      expect(newExporter.shutdown).not.toHaveBeenCalled();
    });

    it('init -> stop -> init cycles give a fully configured provider each time', async () => {
      for (let i = 0; i < 3; i++) {
        const provider = await init(cfg());
        expect(isTracingStarted()).toBe(true);
        expect(processorsOf(provider)).toHaveLength(expectedProcessorCount);
        await stopTracing();
        expect(isTracingStarted()).toBe(false);
        expect(runtimeState().provider).toBeNull();
      }
    });

    it('stop while init waits on a stop does not deadlock', async () => {
      const pricing = deferred<typeof PRICING_OK>();
      mockLoadPricing.mockReturnValueOnce(pricing.promise);

      const a = init(cfg());
      await flush();
      const s1 = stopTracing();
      const b = init(cfg());
      await flush();
      pricing.resolve(PRICING_OK);

      const pa = await a;
      await s1;
      const pb = await b;
      expect(pb).not.toBe(pa);
      expect(isTracingStarted()).toBe(true);
      expect(processorsOf(pb)).toHaveLength(expectedProcessorCount);
    }, 10000);
  });
});
