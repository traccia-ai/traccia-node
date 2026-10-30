/**
 * Head sampling controls exports (TRC-276).
 *
 * sampleRate used to be stored on the provider but never consulted, and
 * `traceFlags || 1` turned unsampled parents back into sampled ones, so rate 0
 * still exported every span.
 */

import { trace } from '@opentelemetry/api';
import { AlwaysOffSampler, AlwaysOnSampler, BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { getTracer, getTracerProvider, startTracing, stopTracing } from '../auto';
import { loadConfig } from '../config/config';
import { BatchSpanProcessor } from '../processor/batch-processor';
import { LoggingSpanProcessor } from '../processor/logging-processor';
import { Sampler, SwitchableSampler } from '../processor/sampler';
import { TracerProvider } from '../tracer/provider';
import { ISampler, ISpan, ISpanExporter, ISpanProcessor, ITracer } from '../types';

jest.mock('../config/config', () => ({
  loadConfig: jest.fn(),
  findConfigFile: jest.fn().mockReturnValue(undefined),
  ENV_VAR_MAPPING: {},
}));

const CHILDREN_PER_TRACE = 3;
const SPANS_PER_TRACE = 1 + CHILDREN_PER_TRACE * 2; // root + children + one grandchild each

function baseConfig(sampleRate?: number) {
  return {
    tracing: { use_otlp: true, sample_rate: sampleRate },
    exporters: {},
    instrumentation: { enable_patching: false },
    rate_limiting: {},
    logging: {},
    advanced: {},
  };
}

class Collector implements ISpanProcessor {
  spans: ISpan[] = [];
  onEnd(span: ISpan): void {
    this.spans.push(span);
  }
  shutdown(): void {}
  forceFlush(): void {}
}

function collectingExporter(): ISpanExporter & { spans: ISpan[] } {
  const spans: ISpan[] = [];
  return {
    spans,
    export: (batch: ISpan[]) => {
      spans.push(...batch);
      return true;
    },
    shutdown: () => undefined,
  };
}

/** Root -> children -> grandchildren, parented through the active span. */
async function makeTraces(tracer: ITracer, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await tracer.startActiveSpan('root', async () => {
      for (let c = 0; c < CHILDREN_PER_TRACE; c++) {
        await tracer.startActiveSpan('child', async () => {
          await tracer.startActiveSpan('grandchild', () => undefined);
        });
      }
    });
  }
}

/** Spans that an exporter would receive: the batch processor drops traceFlags 0. */
function exported(spans: ISpan[]): ISpan[] {
  return spans.filter((s) => s.context.traceFlags !== 0);
}

function traceIds(spans: ISpan[]): Set<string> {
  return new Set(spans.map((s) => s.context.traceId));
}

function providerWithCollector(sampler?: ISampler): { provider: TracerProvider; collector: Collector } {
  const provider = new TracerProvider();
  const collector = new Collector();
  provider.addSpanProcessor(collector);
  if (sampler) provider.setSampler(sampler);
  return { provider, collector };
}

describe('Sampler', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([-0.01, 1.01, 2])('rejects out-of-range rate %p', (rate) => {
    expect(() => new Sampler(rate)).toThrow();
  });

  it('rate 0 never samples even when Math.random returns 0', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    expect(new Sampler(0).shouldSample().sampled).toBe(false);
  });

  it('rate 1 always samples at the top of the random range', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.9999999999);
    expect(new Sampler(1).shouldSample().sampled).toBe(true);
  });

  it('builds a parent-based trace-ID-ratio OTel sampler', () => {
    const description = new Sampler(0.25).toOtelSampler().toString();
    expect(description).toContain('ParentBased');
    expect(description).toContain('TraceIdRatioBased{0.25}');
  });

  it('switchable sampler forwards to its current delegate', () => {
    const sw = new SwitchableSampler(new AlwaysOffSampler());
    expect(sw.toString()).toBe('AlwaysOffSampler');
    sw.delegate = new AlwaysOnSampler();
    expect(sw.toString()).toBe('AlwaysOnSampler');
  });
});

describe('TracerProvider sampling', () => {
  it('rate 0 marks every span unsampled, so nothing is exported', async () => {
    const { provider, collector } = providerWithCollector(new Sampler(0));
    await makeTraces(provider.getTracer('t'), 50);
    expect(collector.spans).toHaveLength(50 * SPANS_PER_TRACE);
    expect(exported(collector.spans)).toHaveLength(0);
  });

  it('unsampled children stay in the root trace', async () => {
    const { provider, collector } = providerWithCollector(new Sampler(0));
    await makeTraces(provider.getTracer('t'), 1);
    expect(traceIds(collector.spans).size).toBe(1);
  });

  it('rate 1 exports every span', async () => {
    const { provider, collector } = providerWithCollector(new Sampler(1));
    await makeTraces(provider.getTracer('t'), 50);
    expect(exported(collector.spans)).toHaveLength(50 * SPANS_PER_TRACE);
  });

  it('rate 0.5 keeps about half the traces, each one whole', async () => {
    const { provider, collector } = providerWithCollector(new Sampler(0.5));
    const traces = 2000;
    await makeTraces(provider.getTracer('t'), traces);

    const kept = exported(collector.spans);
    const perTrace = new Map<string, number>();
    for (const s of kept) perTrace.set(s.context.traceId, (perTrace.get(s.context.traceId) ?? 0) + 1);
    // No partial traces: a kept trace has every span, a dropped one has none.
    expect(new Set(perTrace.values())).toEqual(new Set([SPANS_PER_TRACE]));
    for (const s of collector.spans) {
      expect(s.context.traceFlags === 0).toBe(!perTrace.has(s.context.traceId));
    }
    // Binomial(2000, 0.5) has sd ~22; 0.42..0.58 is a ~7 sd window.
    const ratio = perTrace.size / traces;
    expect(ratio).toBeGreaterThan(0.42);
    expect(ratio).toBeLessThan(0.58);
  });

  it.each([0.1, 0.9])('rate %p is respected', async (rate) => {
    const { provider, collector } = providerWithCollector(new Sampler(rate));
    const traces = 2000;
    await makeTraces(provider.getTracer('t'), traces);
    const ratio = traceIds(exported(collector.spans)).size / traces;
    expect(Math.abs(ratio - rate)).toBeLessThan(0.06);
  });

  it('explicit parent option inherits the unsampled decision', () => {
    const { provider, collector } = providerWithCollector(new Sampler(0));
    const tracer = provider.getTracer('t');
    const root = tracer.startSpan('root');
    const child = tracer.startSpan('child', { parent: root });
    child.end();
    root.end();
    expect(child.context.traceId).toBe(root.context.traceId);
    expect(exported(collector.spans)).toHaveLength(0);
  });

  it('children follow their parent when the sampler changes mid-trace', async () => {
    const { provider, collector } = providerWithCollector(new Sampler(1));
    const tracer = provider.getTracer('t');
    await tracer.startActiveSpan('root', async () => {
      provider.setSampler(new Sampler(0));
      await tracer.startActiveSpan('child', () => undefined);
    });
    expect(exported(collector.spans).map((s) => s.name).sort()).toEqual(['child', 'root']);
  });

  it.each([
    [1, 0, 0],
    [0, 1, 1],
  ])('remote parent decides (rate %p, parent flags %p -> %p exported)', (rate, flags, expected) => {
    const { provider, collector } = providerWithCollector(new Sampler(rate));
    const span = provider.getTracer('t').startSpan('server', {
      parentContext: { traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331', traceFlags: flags },
    });
    span.end();
    expect(span.context.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(exported(collector.spans)).toHaveLength(expected);
  });

  it('tracer created before setSampler uses the new sampler', async () => {
    const { provider, collector } = providerWithCollector();
    const tracer = provider.getTracer('early');
    await makeTraces(tracer, 1);
    expect(exported(collector.spans)).toHaveLength(SPANS_PER_TRACE);

    collector.spans = [];
    provider.setSampler(new Sampler(0));
    await makeTraces(tracer, 10);
    expect(exported(collector.spans)).toHaveLength(0);
  });

  it('setSampler(undefined) restores always-on', async () => {
    const { provider, collector } = providerWithCollector(new Sampler(0));
    provider.setSampler(undefined);
    expect(provider.getSampler()).toBeUndefined();
    await makeTraces(provider.getTracer('t'), 5);
    expect(exported(collector.spans)).toHaveLength(5 * SPANS_PER_TRACE);
  });

  it('honours a custom ISampler without toOtelSampler for roots', async () => {
    let calls = 0;
    const alternate: ISampler = { shouldSample: () => ({ sampled: calls++ % 2 === 0 }) };
    const { provider, collector } = providerWithCollector(alternate);
    await makeTraces(provider.getTracer('t'), 10);
    // Consulted once per root only; children follow the root.
    expect(calls).toBe(10);
    expect(traceIds(exported(collector.spans)).size).toBe(5);
    expect(exported(collector.spans)).toHaveLength(5 * SPANS_PER_TRACE);
  });

  it('applies even when a foreign global OTel provider is registered', async () => {
    trace.disable();
    trace.setGlobalTracerProvider(new BasicTracerProvider({ sampler: new AlwaysOnSampler() }));
    try {
      const { provider, collector } = providerWithCollector(new Sampler(0));
      await makeTraces(provider.getTracer('t'), 10);
      expect(exported(collector.spans)).toHaveLength(0);
    } finally {
      trace.disable();
    }
  });
});

describe('processors on unsampled spans', () => {
  it('BatchSpanProcessor exports nothing at rate 0', async () => {
    const provider = new TracerProvider();
    const exporter = collectingExporter();
    const batch = new BatchSpanProcessor({ exporter, sampler: new Sampler(0), scheduleDelayMs: 60_000 });
    provider.addSpanProcessor(batch);
    provider.setSampler(new Sampler(0));
    await makeTraces(provider.getTracer('t'), 20);
    await batch.forceFlush();
    await batch.shutdown();
    expect(exporter.spans).toHaveLength(0);
  });

  it('BatchSpanProcessor without its own sampler still drops spans the provider did not sample', async () => {
    const provider = new TracerProvider();
    const exporter = collectingExporter();
    const batch = new BatchSpanProcessor({ exporter, scheduleDelayMs: 60_000 });
    provider.addSpanProcessor(batch);
    provider.setSampler(new Sampler(0));
    await makeTraces(provider.getTracer('t'), 20);
    await batch.forceFlush();
    expect(exporter.spans).toHaveLength(0);

    provider.setSampler(new Sampler(1));
    await makeTraces(provider.getTracer('t'), 2);
    await batch.forceFlush();
    await batch.shutdown();
    expect(exporter.spans).toHaveLength(2 * SPANS_PER_TRACE);
  });

  it('BatchSpanProcessor drops traceFlags 0 and keeps spans with flags 1 or unset', () => {
    const exporter = collectingExporter();
    const batch = new BatchSpanProcessor({ exporter, scheduleDelayMs: 60_000 });
    const queued = () => (batch as unknown as { queue: ISpan[] }).queue.length;
    batch.onEnd({ context: { traceFlags: 0 } } as unknown as ISpan);
    expect(queued()).toBe(0);
    batch.onEnd({ context: { traceFlags: 1 } } as unknown as ISpan);
    batch.onEnd({ context: {} } as unknown as ISpan);
    expect(queued()).toBe(2);
    void batch.shutdown();
  });

  it('LoggingSpanProcessor skips unsampled spans and logs sampled ones', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const provider = new TracerProvider();
      provider.addSpanProcessor(new LoggingSpanProcessor());
      provider.setSampler(new Sampler(0));
      provider.getTracer('t').startSpan('dropped').end();
      expect(log).not.toHaveBeenCalled();

      provider.setSampler(new Sampler(1));
      provider.getTracer('t').startSpan('kept').end();
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0][0])).toContain('kept');
    } finally {
      log.mockRestore();
    }
  });

  it('enrichment processors still see unsampled spans', () => {
    const { provider, collector } = providerWithCollector(new Sampler(0));
    provider.getTracer('t').startSpan('unsampled').end();
    expect(collector.spans.map((s) => s.name)).toEqual(['unsampled']);
  });
});

describe('startTracing end to end', () => {
  const mockedLoadConfig = loadConfig as jest.Mock;

  beforeEach(async () => {
    await stopTracing();
    mockedLoadConfig.mockReturnValue(baseConfig());
  });

  afterAll(async () => {
    await stopTracing();
  });

  async function run(config: Parameters<typeof startTracing>[0], traces: number) {
    const exporter = collectingExporter();
    await startTracing({
      exporter,
      loadEnv: false,
      enableCostTracking: false,
      enableTokenCounting: false,
      ...config,
    });
    await makeTraces(getTracer('e2e'), traces);
    await getTracerProvider().forceFlush();
    return exporter.spans;
  }

  it('sampleRate 0 exports nothing', async () => {
    expect(await run({ sampleRate: 0 }, 100)).toHaveLength(0);
  });

  it('sampleRate 1 exports every span', async () => {
    expect(await run({ sampleRate: 1 }, 100)).toHaveLength(100 * SPANS_PER_TRACE);
  });

  it('sampleRate 0.5 exports about half the traces, each whole', async () => {
    const spans = await run({ sampleRate: 0.5 }, 1000);
    const ids = traceIds(spans);
    expect(spans).toHaveLength(ids.size * SPANS_PER_TRACE);
    expect(ids.size / 1000).toBeGreaterThan(0.4);
    expect(ids.size / 1000).toBeLessThan(0.6);
  });

  it('sample_rate from config applies when sampleRate is not passed', async () => {
    mockedLoadConfig.mockReturnValue(baseConfig(0));
    expect(await run({}, 20)).toHaveLength(0);
  });

  it('a non-numeric config sample_rate falls back to 1 instead of dropping everything', async () => {
    mockedLoadConfig.mockReturnValue(baseConfig(NaN));
    expect(await run({}, 10)).toHaveLength(10 * SPANS_PER_TRACE);
  });

  it('out-of-range sampleRate is clamped', async () => {
    expect(await run({ sampleRate: -3 }, 10)).toHaveLength(0);
    await stopTracing();
    expect(await run({ sampleRate: 7 }, 10)).toHaveLength(10 * SPANS_PER_TRACE);
  });

  it('re-initialising after stopTracing applies the new rate', async () => {
    expect(await run({ sampleRate: 1 }, 5)).toHaveLength(5 * SPANS_PER_TRACE);
    await stopTracing();
    expect(await run({ sampleRate: 0 }, 20)).toHaveLength(0);
  });

  it('a tracer fetched before startTracing uses the configured rate', async () => {
    const early = getTracer('module-level');
    const exporter = collectingExporter();
    await startTracing({ exporter, sampleRate: 0, loadEnv: false, enableCostTracking: false });
    await makeTraces(early, 20);
    await getTracerProvider().forceFlush();
    expect(exporter.spans).toHaveLength(0);
  });
});
