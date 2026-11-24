/**
 * init() option precedence (TRC-296).
 *
 * Every option resolves as: explicit init() argument > environment variable >
 * traccia.toml > default, with an explicit `false` or `0` kept as given.
 * Aliases are normalised once (the canonical TRACCIA_* name wins over the
 * legacy AGENT_DASHBOARD_* one), unsupported options are rejected, and the
 * rate limiter options actually install a rate limiter.
 *
 * These go through the real loadConfig() (temp cwd + HOME, so no repo or user
 * traccia.toml leaks in) and inspect what init() wired onto the provider.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { init, stopTracing } from '../auto';
import { getConfig, updateConfig } from '../config/runtime-config';
import { getClientConfig } from '../config/client-config';
import { configurePrompts } from '../prompts';
import { ConsoleExporter } from '../exporter/console-exporter';
import { FileExporter } from '../exporter/file-exporter';
import { OtlpExporter } from '../exporter/otlp-exporter';
import { HttpExporter } from '../exporter/http-exporter';
import { BatchSpanProcessor } from '../processor/batch-processor';
import { TokenCountingProcessor } from '../processor/token-counter';
import { CostAnnotatingProcessor } from '../processor/cost-processor';
import { LoggingSpanProcessor } from '../processor/logging-processor';
import { GuardrailDetectorProcessor } from '../processor/guardrail-detector';
import { RedactionSpanProcessor } from '../redaction/processor';
import { RateLimitingSpanProcessor } from '../processor/rate-limiter';
import { TracerProvider } from '../tracer/provider';
import { ISpanExporter, ISpanProcessor, SDKConfig } from '../types';

const mockExporter = () => ({
  export: jest.fn().mockResolvedValue(true),
  shutdown: jest.fn().mockResolvedValue(undefined),
});

jest.mock('../exporter/otlp-exporter', () => ({ OtlpExporter: jest.fn().mockImplementation(() => mockExporter()) }));
jest.mock('../exporter/http-exporter', () => ({
  HttpExporter: jest.fn().mockImplementation(() => mockExporter()),
  DEFAULT_ENDPOINT: 'http://127.0.0.1:9/v1/traces',
}));
jest.mock('../exporter/console-exporter', () => ({ ConsoleExporter: jest.fn().mockImplementation(() => mockExporter()) }));
jest.mock('../exporter/file-exporter', () => ({ FileExporter: jest.fn().mockImplementation(() => mockExporter()) }));

// Keep provider SDKs unpatched: these tests only look at configuration.
jest.mock('../instrumentation/gemini', () => ({ patchGemini: jest.fn() }));
jest.mock('../instrumentation/groq', () => ({ patchGroq: jest.fn(), patchGroqEsm: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../instrumentation/axios', () => ({ patchAxios: jest.fn() }));
jest.mock('../instrumentation/openai', () => ({ patchOpenAI: jest.fn(), patchOpenAIResponses: jest.fn() }));
jest.mock('../instrumentation/anthropic', () => ({ patchAnthropic: jest.fn() }));

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'traccia-config-precedence-'));
const TOML_PATH = path.join(TEST_DIR, 'traccia.toml');
const ENV_PREFIXES = ['TRACCIA_', 'AGENT_DASHBOARD_', 'OTEL_'];

type Extra = Record<string, unknown>;

/** Base options for every test: no .env loading, and no network exporter unless a test wants one. */
async function initWith(config: SDKConfig & Extra = {}, opts: { realExporter?: boolean } = {}): Promise<TracerProvider> {
  const exporter: ISpanExporter = mockExporter();
  return init({
    loadEnv: false,
    ...(opts.realExporter ? {} : { exporter }),
    ...config,
  } as SDKConfig);
}

function writeToml(content: string): void {
  fs.writeFileSync(TOML_PATH, content);
}

function processors(provider: TracerProvider): ISpanProcessor[] {
  return (provider as unknown as { spanProcessors: ISpanProcessor[] }).spanProcessors;
}

function find<T>(provider: TracerProvider, cls: new (...args: never[]) => T): T | undefined {
  return processors(provider).find((p) => p instanceof cls) as T | undefined;
}

function sampleRate(provider: TracerProvider): number {
  return (provider.getSampler() as unknown as { sampleRate: number }).sampleRate;
}

function batch(provider: TracerProvider): Extra {
  return find(provider, BatchSpanProcessor) as unknown as Extra;
}

describe('init() option precedence (TRC-296)', () => {
  let cwdSpy: jest.SpyInstance;
  let savedEnv: NodeJS.ProcessEnv;
  let savedRuntime: ReturnType<typeof getConfig>;

  beforeAll(async () => {
    await stopTracing();
  });

  beforeEach(() => {
    savedEnv = { ...process.env };
    savedRuntime = { ...getConfig() };
    for (const key of Object.keys(process.env)) {
      if (ENV_PREFIXES.some((p) => key.startsWith(p))) delete process.env[key];
    }
    // findConfigFile() looks in cwd and ~/.traccia; point both at an empty temp dir.
    process.env.HOME = TEST_DIR;
    process.env.USERPROFILE = TEST_DIR;
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(TEST_DIR);
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await stopTracing();
    if (fs.existsSync(TOML_PATH)) fs.unlinkSync(TOML_PATH);
    cwdSpy.mockRestore();
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    updateConfig(savedRuntime);
    configurePrompts({ cacheTtlS: 60 });
  });

  afterAll(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Gaps on current main: these fail until the fix lands.
  // ---------------------------------------------------------------------------

  describe('explicit false beats environment and file (booleans merged with || / &&)', () => {
    it('enableConsoleExporter: false wins over TRACCIA_ENABLE_CONSOLE=true', async () => {
      process.env.TRACCIA_ENABLE_CONSOLE = 'true';
      await initWith({ enableConsoleExporter: false });
      expect(ConsoleExporter).not.toHaveBeenCalled();
    });

    it('enableConsoleExporter: false wins over traccia.toml enable_console = true', async () => {
      writeToml('[exporters]\nenable_console = true\n');
      await initWith({ enableConsoleExporter: false });
      expect(ConsoleExporter).not.toHaveBeenCalled();
    });

    it('enableFileExporter: false wins over TRACCIA_ENABLE_FILE=true', async () => {
      process.env.TRACCIA_ENABLE_FILE = 'true';
      await initWith({ enableFileExporter: false });
      expect(FileExporter).not.toHaveBeenCalled();
    });

    it('resetTraceFile: false wins over traccia.toml reset_trace_file = true', async () => {
      writeToml('[exporters]\nenable_file = true\nreset_trace_file = true\n');
      await initWith({ resetTraceFile: false });
      expect(FileExporter).toHaveBeenCalledTimes(1);
      expect((FileExporter as unknown as jest.Mock).mock.calls[0][0]).toMatchObject({ resetOnStart: false });
    });

    it('enableSpanLogging: false wins over TRACCIA_ENABLE_SPAN_LOGGING=true', async () => {
      process.env.TRACCIA_ENABLE_SPAN_LOGGING = 'true';
      const provider = await initWith({ enableSpanLogging: false });
      expect(find(provider, LoggingSpanProcessor)).toBeUndefined();
    });
  });

  describe('explicit true beats environment and file', () => {
    it('enableTokenCounting: true wins over TRACCIA_ENABLE_TOKEN_COUNTING=false', async () => {
      process.env.TRACCIA_ENABLE_TOKEN_COUNTING = 'false';
      const provider = await initWith({ enableTokenCounting: true });
      expect(find(provider, TokenCountingProcessor)).toBeDefined();
    });

    it('enableCostTracking: true wins over TRACCIA_ENABLE_COSTS=false', async () => {
      process.env.TRACCIA_ENABLE_COSTS = 'false';
      const provider = await initWith({ enableCostTracking: true });
      expect(find(provider, CostAnnotatingProcessor)).toBeDefined();
    });

    it('enableTokenCounting: true wins over traccia.toml enable_token_counting = false', async () => {
      writeToml('[instrumentation]\nenable_token_counting = false\n');
      const provider = await initWith({ enableTokenCounting: true });
      expect(find(provider, TokenCountingProcessor)).toBeDefined();
    });
  });

  describe('environment values are parsed by option type, not by whether a default exists', () => {
    it('TRACCIA_REDACT_PII=false does not turn redaction on', async () => {
      process.env.TRACCIA_REDACT_PII = 'false';
      const provider = await initWith();
      expect(find(provider, RedactionSpanProcessor)).toBeUndefined();
    });

    it('TRACCIA_GUARDRAIL_HEURISTICS=false turns guardrail heuristics off', async () => {
      process.env.TRACCIA_GUARDRAIL_HEURISTICS = 'false';
      const provider = await initWith();
      const detector = find(provider, GuardrailDetectorProcessor) as unknown as Extra;
      expect(detector.heuristicsEnabled).toBe(false);
    });

    it('TRACCIA_SAMPLE_RATE applies when traccia.toml has a [tracing] section without sample_rate', async () => {
      writeToml('[tracing]\nservice_name = "from-file"\n');
      process.env.TRACCIA_SAMPLE_RATE = '0.25';
      const provider = await initWith();
      expect(sampleRate(provider)).toBe(0.25);
    });

    it('TRACCIA_ENABLE_CONSOLE=false keeps console off when traccia.toml has an [exporters] section without it', async () => {
      writeToml('[exporters]\nfile_exporter_path = "x.jsonl"\n');
      process.env.TRACCIA_ENABLE_CONSOLE = 'false';
      await initWith();
      expect(ConsoleExporter).not.toHaveBeenCalled();
    });

    it('a partial traccia.toml section keeps the defaults of the keys it omits', async () => {
      writeToml('[tracing]\nservice_name = "from-file"\n');
      process.env.TRACCIA_USE_OTLP = 'false';
      await initWith({}, { realExporter: true });
      expect(HttpExporter).toHaveBeenCalled();
      expect(OtlpExporter).not.toHaveBeenCalled();
    });
  });

  describe('aliases are normalised once: canonical TRACCIA_* wins over legacy AGENT_DASHBOARD_*', () => {
    it('TRACCIA_API_KEY wins over AGENT_DASHBOARD_API_KEY', async () => {
      process.env.TRACCIA_API_KEY = 'tr_canonical';
      process.env.AGENT_DASHBOARD_API_KEY = 'tr_legacy';
      await initWith();
      expect(getClientConfig()?.apiKey).toBe('tr_canonical');
    });

    it('TRACCIA_SAMPLE_RATE wins over AGENT_DASHBOARD_SAMPLE_RATE', async () => {
      process.env.TRACCIA_SAMPLE_RATE = '0.2';
      process.env.AGENT_DASHBOARD_SAMPLE_RATE = '0.9';
      const provider = await initWith();
      expect(sampleRate(provider)).toBe(0.2);
    });

    it('the legacy alias still applies when the canonical name is unset', async () => {
      process.env.AGENT_DASHBOARD_API_KEY = 'tr_legacy';
      await initWith();
      expect(getClientConfig()?.apiKey).toBe('tr_legacy');
    });
  });

  describe('rate limiter is wired by init()', () => {
    it('maxSpansPerSecond passed to init() installs a rate limiter', async () => {
      const provider = await initWith({ maxSpansPerSecond: 10 });
      const limiter = find(provider, RateLimitingSpanProcessor);
      expect(limiter).toBeDefined();
      expect(limiter!.getStats().maxSpansPerSecond).toBe(10);
    });

    it('traccia.toml rate_limiting.max_spans_per_second installs a rate limiter', async () => {
      writeToml('[rate_limiting]\nmax_spans_per_second = 50\n');
      const provider = await initWith();
      const limiter = find(provider, RateLimitingSpanProcessor);
      expect(limiter).toBeDefined();
      expect(limiter!.getStats().maxSpansPerSecond).toBe(50);
    });

    it('explicit maxSpansPerSecond wins over traccia.toml', async () => {
      writeToml('[rate_limiting]\nmax_spans_per_second = 50\n');
      const provider = await initWith({ maxSpansPerSecond: 5 });
      expect(find(provider, RateLimitingSpanProcessor)?.getStats().maxSpansPerSecond).toBe(5);
    });
  });

  describe('unsupported options are rejected', () => {
    it('an unknown option name rejects instead of being ignored', async () => {
      await expect(initWith({ notARealOption: true })).rejects.toThrow();
    });

    it('a snake_case spelling of a real option rejects instead of being ignored', async () => {
      await expect(initWith({ sample_rate: 0.1 })).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Precedence that already works: pinned so the fix cannot regress it.
  // ---------------------------------------------------------------------------

  describe('already correct (pinned)', () => {
    it('defaults apply with no argument, env or file', async () => {
      const provider = await initWith();
      expect(sampleRate(provider)).toBe(1);
      expect(find(provider, TokenCountingProcessor)).toBeDefined();
      expect(find(provider, CostAnnotatingProcessor)).toBeDefined();
      expect(find(provider, RedactionSpanProcessor)).toBeUndefined();
      expect(find(provider, LoggingSpanProcessor)).toBeUndefined();
      expect(find(provider, RateLimitingSpanProcessor)).toBeUndefined();
      expect(ConsoleExporter).not.toHaveBeenCalled();
      expect(FileExporter).not.toHaveBeenCalled();
      expect(batch(provider).maxQueueSize).toBe(5000);
    });

    it('explicit sampleRate: 0 wins over TRACCIA_SAMPLE_RATE', async () => {
      process.env.TRACCIA_SAMPLE_RATE = '0.5';
      const provider = await initWith({ sampleRate: 0 });
      expect(sampleRate(provider)).toBe(0);
    });

    it('TRACCIA_SAMPLE_RATE wins over traccia.toml sample_rate', async () => {
      writeToml('[tracing]\nsample_rate = 0.3\n');
      process.env.TRACCIA_SAMPLE_RATE = '0.6';
      const provider = await initWith();
      expect(sampleRate(provider)).toBe(0.6);
    });

    it('traccia.toml sample_rate wins over the default', async () => {
      writeToml('[tracing]\nsample_rate = 0.3\n');
      const provider = await initWith();
      expect(sampleRate(provider)).toBe(0.3);
    });

    it('explicit useOtlp: false wins over TRACCIA_USE_OTLP=true', async () => {
      process.env.TRACCIA_USE_OTLP = 'true';
      await initWith({ useOtlp: false }, { realExporter: true });
      expect(HttpExporter).toHaveBeenCalled();
      expect(OtlpExporter).not.toHaveBeenCalled();
    });

    it('explicit redactPii: false wins over TRACCIA_REDACT_PII=true', async () => {
      process.env.TRACCIA_REDACT_PII = 'true';
      const provider = await initWith({ redactPii: false });
      expect(find(provider, RedactionSpanProcessor)).toBeUndefined();
    });

    it('explicit guardrailHeuristics: false wins over traccia.toml guardrail_heuristics = true', async () => {
      writeToml('[instrumentation]\nguardrail_heuristics = true\n');
      const provider = await initWith({ guardrailHeuristics: false });
      const detector = find(provider, GuardrailDetectorProcessor) as unknown as Extra;
      expect(detector.heuristicsEnabled).toBe(false);
    });

    it('explicit debug: false wins over TRACCIA_DEBUG=true', async () => {
      process.env.TRACCIA_DEBUG = 'true';
      await initWith({ debug: false });
      expect(getConfig().debug).toBe(false);
    });

    it('explicit maxQueueSize wins over traccia.toml max_queue_size', async () => {
      writeToml('[rate_limiting]\nmax_queue_size = 100\n');
      const provider = await initWith({ maxQueueSize: 42 });
      expect(batch(provider).maxQueueSize).toBe(42);
    });

    it('explicit maxToolSpans: 0 is kept', async () => {
      await initWith({ maxToolSpans: 0 });
      expect(getConfig().maxToolSpans).toBe(0);
    });

    it('explicit apiKey wins over TRACCIA_API_KEY', async () => {
      process.env.TRACCIA_API_KEY = 'tr_env';
      await initWith({ apiKey: 'tr_arg' });
      expect(getClientConfig()?.apiKey).toBe('tr_arg');
    });

    it('TRACCIA_API_KEY wins over traccia.toml api_key', async () => {
      writeToml('[tracing]\napi_key = "tr_file"\nsample_rate = 1.0\nuse_otlp = true\n');
      process.env.TRACCIA_API_KEY = 'tr_env';
      await initWith();
      expect(getClientConfig()?.apiKey).toBe('tr_env');
    });

    it('explicit enableConsoleExporter: true wins over TRACCIA_ENABLE_CONSOLE=false', async () => {
      process.env.TRACCIA_ENABLE_CONSOLE = 'false';
      await initWith({ enableConsoleExporter: true });
      expect(ConsoleExporter).toHaveBeenCalledTimes(1);
    });
  });
});
