/**
 * SDK initialization and global tracer management.
 */

import { TracerProvider } from './tracer/provider';
import { trace } from '@opentelemetry/api';
import { BatchSpanProcessor } from './processor/batch-processor';
import { Sampler } from './processor/sampler';
import { TokenCountingProcessor } from './processor/token-counter';
import { CostAnnotatingProcessor } from './processor/cost-processor';
import { LoggingSpanProcessor } from './processor/logging-processor';
import { GuardrailDetectorProcessor } from './processor/guardrail-detector';
import { GovernanceEnrichmentProcessor } from './processor/governance-enrichment';
import { AgentEnrichmentProcessor } from './processor/agent-enricher';
import { RedactionSpanProcessor } from './redaction/processor';
import { HttpExporter, DEFAULT_ENDPOINT } from './exporter/http-exporter';
import { OtlpExporter } from './exporter/otlp-exporter';
import { ConsoleExporter } from './exporter/console-exporter';
import { FileExporter } from './exporter/file-exporter';
import { loadConfig } from './config/config';
import { setClientConfig, clearClientConfig, getClientConfig } from './config/client-config';
import { loadEnvFile, findAgentConfigPath } from './config/env-config';
import { getActiveSourceRef, loadPricingWithSource } from './config/pricing-config';
import { resolveServiceName } from './config/service-name';
import {
  updateConfig,
  setSessionId,
  setUserId,
  setTenantId,
  setProjectId,
  setAgentId,
  setAgentName,
  setEnv,
  getAgentId,
  getAgentName,
  getEnv as getRuntimeEnv,
} from './config/runtime-config';
import { CostResolver, peekResolver, restoreResolver, setResolver } from './processor/cost-resolver';
import { SDKConfig, ISpanExporter, ISpanProcessor, ITracer } from './types';
import { configureGovernance } from './governance/config';
import { drainOpenCalls, settleOpenCalls, SHUTDOWN_SETTLE_TIMEOUT_MS } from './governance/pep';
import { configurePrompts } from './prompts';
import { patchGemini } from './instrumentation/gemini';
import { patchGroq, patchGroqEsm } from './instrumentation/groq';
import { patchAxios } from './instrumentation/axios';
import { patchOpenAI, patchOpenAIResponses } from './instrumentation/openai';
import { patchAnthropic } from './instrumentation/anthropic';

const RUNTIME_KEY = Symbol.for('traccia.runtime');

export interface TracciaRuntime {
  provider: TracerProvider | null;
  started: boolean;
  taskChildCosts?: import('async_hooks').AsyncLocalStorage<Array<{ cost: number | null }>>;
  costProvider?: TracerProvider | null;
  /** The stopTracing() in progress; calls made meanwhile return it. */
  stopping?: Promise<void>;
  /**
   * The init() in progress. Concurrent init() calls share it, and `started` is set only once it
   * succeeds; a stopTracing() made meanwhile waits for it to settle first.
   */
  initializing?: Promise<TracerProvider>;
  /** Each provider's shutdown, so stopTracing() and the signal hook shut it down once. */
  providerShutdowns?: WeakMap<TracerProvider, Promise<void>>;
}

/** One process shares this object across the CLI bundle and the public SDK. */
export function runtimeState(): TracciaRuntime {
  const host = globalThis as typeof globalThis & { [RUNTIME_KEY]?: TracciaRuntime };
  if (!host[RUNTIME_KEY]) {
    host[RUNTIME_KEY] = { provider: null, started: false };
  }
  return host[RUNTIME_KEY];
}

/** True after a successful init()/startTracing() (OTLP export configured). */
export function isTracingStarted(): boolean {
  return runtimeState().started;
}

/**
 * Get the global tracer provider.
 */
export function getTracerProvider(): TracerProvider {
  const state = runtimeState();
  if (!state.provider) {
    state.provider = new TracerProvider();
  }
  return state.provider;
}

/**
 * Set the global tracer provider.
 */
export function setTracerProvider(provider: TracerProvider): void {
  runtimeState().provider = provider;
}

/**
 * Get a tracer from the global provider.
 */
export function getTracer(name: string, version?: string): ITracer {
  return getTracerProvider().getTracer(name, version);
}

/**
 * Initialize tracing with automatic setup.
 */
function applyGovernanceConfig(config: SDKConfig): void {
  configureGovernance({
    statusCheckEndpoint: config.statusCheckEndpoint,
    postBlockEndpoint: config.postBlockEndpoint,
    statusCacheTtlSeconds: config.statusCacheTtlSeconds,
    policyFailMode: config.policyFailMode,
  });
}

/**
 * Initialize tracing.
 *
 * Lifecycle (TRC-297):
 * - Concurrent calls share one setup and resolve to the same, fully configured provider. If that
 *   setup fails, every caller waiting on it rejects with its error.
 * - `started` becomes true only after setup succeeds. A failed setup removes the processors it
 *   added and restores the sampler, client credentials and cost resolver, so a later init()
 *   runs setup again from the start.
 * - A call made while stopTracing() is in progress waits for the stop, then initializes afresh.
 *   stopTracing() called during setup waits for the setup to settle, then stops.
 * - Once started, init() keeps tracing as it is and applies only this call's governance config.
 */
export async function init(config: SDKConfig = {}): Promise<TracerProvider> {
  const state = runtimeState();
  // A stop in progress finishes first; this call then sees its result (started false).
  while (state.stopping !== undefined) {
    await state.stopping.catch(() => undefined);
  }

  if (state.initializing !== undefined) {
    const provider = await state.initializing;
    applyGovernanceConfig(config);
    return provider;
  }

  if (state.started) {
    // Tracing stays as it is, but policy checks start afresh (TRC-342): no
    // remembered fail mode, and this call's policyFailMode applies.
    applyGovernanceConfig(config);
    return getTracerProvider();
  }

  // Set synchronously after the checks above, so a call made while setup awaits shares it.
  const initializing: Promise<TracerProvider> = setUp(config)
    .then((provider) => {
      state.started = true;
      return provider;
    })
    .finally(() => {
      if (state.initializing === initializing) {
        state.initializing = undefined;
      }
    });
  state.initializing = initializing;
  return initializing;
}

/**
 * Configure the global provider for init(). On failure, undo what it changed on the provider and
 * in shared state, then rethrow.
 */
async function setUp(config: SDKConfig): Promise<TracerProvider> {
  // Get or create provider. Its own OTel provider creates Traccia spans and
  // carries the sampler; registering it globally is best effort, since OTel
  // keeps the first global provider for the life of the process.
  const provider = getTracerProvider();
  const previousSampler = provider.getSampler();
  const previousClientConfig = getClientConfig();
  // Peek, not getResolver(): that would parse the bundled pricing snapshot just to save it.
  const previousResolver = peekResolver();
  const added: ISpanProcessor[] = [];
  const addProcessor = (processor: ISpanProcessor): void => {
    provider.addSpanProcessor(processor);
    added.push(processor);
  };

  try {
    return await configureProvider(provider, config, addProcessor);
  } catch (error) {
    // Only this attempt's processors: others (evaluate()'s cost processor) may have been added
    // to the provider meanwhile.
    for (const processor of added) {
      provider.removeSpanProcessor(processor);
    }
    await Promise.all(
      added.map((processor) => Promise.resolve().then(() => processor.shutdown()).catch(() => undefined)),
    );
    provider.setSampler(previousSampler);
    if (previousClientConfig) {
      setClientConfig(previousClientConfig.apiKey, previousClientConfig.endpoint);
    } else {
      clearClientConfig();
    }
    restoreResolver(previousResolver);
    throw error;
  }
}

async function configureProvider(
  provider: TracerProvider,
  config: SDKConfig,
  addProcessor: (processor: ISpanProcessor) => void,
): Promise<TracerProvider> {
  const basicProvider = provider.getOtelTracerProvider();
  trace.setGlobalTracerProvider(basicProvider);

  // Load environment
  if (config.loadEnv !== false) {
    loadEnvFile();
  }

  // Load configuration (files + env vars)
  const loadedConfig = loadConfig();

  applyGovernanceConfig(config);

  {
    const envTtl = process.env.TRACCIA_PROMPT_CACHE_TTL_S;
    const ttl =
      config.promptCacheTtlS ??
      (envTtl != null && envTtl !== '' ? Number(envTtl) : undefined);
    configurePrompts({
      cacheTtlS: ttl != null && !Number.isNaN(ttl) ? ttl : 60,
      promptApiBase:
        config.promptApiBase ?? process.env.TRACCIA_PROMPT_API_BASE ?? undefined,
    });
  }

  // overrides from argument 'config' take precedence
  const apiKey = config.apiKey || loadedConfig.tracing.api_key || '';
  const endpoint = config.endpoint || loadedConfig.tracing.endpoint || DEFAULT_ENDPOINT;
  // Policy, prompts and evals use this key/endpoint pair when it has a key.
  setClientConfig(apiKey, endpoint);
  const sampleRate = config.sampleRate ?? loadedConfig.tracing.sample_rate ?? 1.0;
  const useOtlp = config.useOtlp ?? loadedConfig.tracing.use_otlp ?? true;

  // Find agent config
  const agentConfigPath = findAgentConfigPath();
  if (agentConfigPath) {
    process.env.AGENT_DASHBOARD_AGENT_CONFIG = agentConfigPath;
  }

  // Set up runtime config
  updateConfig({
    autoInstrumentTools: config.autoInstrument ?? loadedConfig.instrumentation.auto_instrument_tools ?? false,
    toolInclude: config.toolInclude || [],
    maxToolSpans: config.maxToolSpans ?? loadedConfig.instrumentation.max_tool_spans ?? 100,
    maxSpanDepth: config.maxSpanDepth ?? loadedConfig.instrumentation.max_span_depth ?? 10,
    debug: config.debug ?? loadedConfig.logging.debug ?? false,
    attrTruncationLimit: config.attrTruncationLimit ?? loadedConfig.advanced.attr_truncation_limit,
  });

  setSessionId(config.sessionId);
  setUserId(config.userId);
  setTenantId(config.tenantId);
  setProjectId(config.projectId);
  setAgentId(config.agentId || process.env.TRACCIA_AGENT_ID || process.env.AGENT_DASHBOARD_AGENT_ID);
  setAgentName(config.agentName || process.env.TRACCIA_AGENT_NAME || process.env.AGENT_DASHBOARD_AGENT_NAME);
  setEnv(config.env || process.env.TRACCIA_ENV || process.env.AGENT_DASHBOARD_ENV);

  const resolvedServiceName = resolveServiceName(
    (config.resource?.['service.name'] as string | undefined) ||
      loadedConfig.tracing.service_name,
  );

  const resourceAttributes: Record<string, unknown> = {
    'service.name': resolvedServiceName,
    ...(config.resource || {}),
  };

  if (config.tenantId || process.env.TRACCIA_TENANT_ID) {
    resourceAttributes['tenant.id'] = config.tenantId || process.env.TRACCIA_TENANT_ID;
  }
  if (config.projectId || process.env.TRACCIA_PROJECT_ID) {
    resourceAttributes['project.id'] = config.projectId || process.env.TRACCIA_PROJECT_ID;
  }
  if (config.sessionId || process.env.TRACCIA_SESSION_ID) {
    resourceAttributes['session.id'] = config.sessionId || process.env.TRACCIA_SESSION_ID;
  }
  if (config.userId || process.env.TRACCIA_USER_ID) {
    resourceAttributes['user.id'] = config.userId || process.env.TRACCIA_USER_ID;
  }
  if (getAgentId()) {
    resourceAttributes['agent.id'] = getAgentId();
  }
  if (getAgentName()) {
    resourceAttributes['agent.name'] = getAgentName();
  }
  if (getRuntimeEnv()) {
    resourceAttributes['environment'] = getRuntimeEnv();
    resourceAttributes['env'] = getRuntimeEnv();
  }
  if (config.serviceRole) {
    resourceAttributes['traccia.service_role'] = config.serviceRole;
  }
  if (config.debug ?? loadedConfig.logging.debug) {
    resourceAttributes['trace.debug'] = true;
  }

  if (config.serviceRole) {
    const providerAny = basicProvider as unknown as {
      resource?: { attributes?: Record<string, unknown> };
    };
    if (providerAny.resource && providerAny.resource.attributes) {
      providerAny.resource.attributes['traccia.service_role'] = config.serviceRole;
    }
  }

  // Parent-based head sampling at span creation: unsampled traces get
  // traceFlags 0 and every export processor drops them.
  // A non-numeric env value parses to NaN, which OTel treats as 0 (drop
  // everything); fall back to the default instead, like the Python SDK.
  const safeSampleRate = Number.isFinite(sampleRate) ? sampleRate : 1.0;
  const sampler = new Sampler(Math.min(1, Math.max(0, safeSampleRate)));
  provider.setSampler(sampler);

  // Create exporter
  let exporter: ISpanExporter;

  if (config.exporter) {
    exporter = config.exporter;
  } else if (useOtlp !== false) {
    exporter = new OtlpExporter({
      endpoint,
      apiKey,
      serviceName: resolvedServiceName,
      resourceAttributes,
    });
  } else {
    exporter = new HttpExporter({
      endpoint,
      apiKey,
    });
  }

  if (config.enableConsoleExporter || loadedConfig.exporters.enable_console) {
    const consoleExporter = new ConsoleExporter();
    exporter = new CompositeExporter([exporter, consoleExporter]);
  }

  if (config.enableFileExporter || loadedConfig.exporters.enable_file) {
    const filePath = config.fileExporterPath || loadedConfig.exporters.file_exporter_path || 'traces.jsonl';
    const resetOnStart = config.resetTraceFile || loadedConfig.exporters.reset_trace_file || false;
    const fileExporter = new FileExporter({ filePath, resetOnStart });
    exporter = new CompositeExporter([exporter, fileExporter]);
  }

  // Add processors
  if (config.enableTokenCounting !== false && loadedConfig.instrumentation.enable_token_counting !== false) {
    addProcessor(new TokenCountingProcessor());
  }

  if (config.enableCostTracking !== false && loadedConfig.instrumentation.enable_costs !== false) {
    const pricingTable = config.pricingOverride
      ? (config.pricingOverride as Record<string, { inputCost: number; outputCost: number }>)
      : undefined;
    const [pricing, pricingSource, pricingGeneratedAt] = await loadPricingWithSource(pricingTable);
    const costProcessor = new CostAnnotatingProcessor({
      pricingTable: pricing,
      pricingSource,
      pricingGeneratedAt,
      pricingSourceRef: getActiveSourceRef(),
    });
    addProcessor(costProcessor);
    setResolver(new CostResolver(pricing, pricingSource, pricingGeneratedAt));
  }

  addProcessor(
    new AgentEnrichmentProcessor({
      agentConfigPath: agentConfigPath,
      defaultAgentId: getAgentId(),
      defaultAgentName: getAgentName(),
      defaultEnv: getRuntimeEnv(),
      serviceRole: config.serviceRole,
    }),
  );

  const guardrailHeuristics = config.guardrailHeuristics ?? loadedConfig.instrumentation.guardrail_heuristics ?? true;
  addProcessor(new GuardrailDetectorProcessor({ heuristicsEnabled: guardrailHeuristics }));

  const frameworks = config.compliance?.frameworks || [];
  const euRiskTier =
    frameworks.includes("eu_ai_act") || config.compliance?.risk_tier
      ? (config.compliance?.risk_tier)
      : undefined;
  const hipaaEnabled = frameworks.includes("hipaa");
  addProcessor(new GovernanceEnrichmentProcessor({ euRiskTier, hipaaEnabled }));

  let redactPii = config.redactPii ?? loadedConfig.instrumentation.redact_pii ?? false;
  if (hipaaEnabled && config.redactPii === undefined && loadedConfig.instrumentation.redact_pii === undefined) {
    redactPii = true;
  }
  if (redactPii) {
    addProcessor(new RedactionSpanProcessor());
  }

  // Log after enrichment and redaction so span logs never contain unredacted values.
  if (config.enableSpanLogging || loadedConfig.logging.enable_span_logging) {
    addProcessor(new LoggingSpanProcessor());
  }

  // Add batch processor with exporter
  const processor = new BatchSpanProcessor({
    exporter,
    maxQueueSize: config.maxQueueSize ?? loadedConfig.rate_limiting.max_queue_size ?? 5000,
    maxExportBatchSize: config.maxExportBatchSize ?? loadedConfig.rate_limiting.max_export_batch_size ?? 512,
    scheduleDelayMs: config.scheduleDelayMs ?? loadedConfig.rate_limiting.schedule_delay_millis ?? 5000,
    sampler,
  });

  addProcessor(processor);
  registerShutdown(provider, processor);

  if (loadedConfig.instrumentation.enable_patching !== false) {
    try {
      patchGemini();
    } catch {
      /* optional peer */
    }
    try {
      patchGroq();
      // An app that imports groq-sdk as an ES module uses a separate build, which loads
      // asynchronously. Wait for it so calls made after init() are traced.
      await patchGroqEsm();
    } catch {
      /* optional peer */
    }
    try {
      patchAxios();
    } catch {
      /* optional peer */
    }
    for (const patch of [patchOpenAI, patchOpenAIResponses, patchAnthropic]) {
      try {
        patch();
      } catch {
        /* optional peer */
      }
    }
  }

  return provider;
}

/**
 * Stop tracing and shutdown all processors.
 *
 * LLM calls still in flight (an open Groq stream, a request not yet returned) are settled
 * first, and stopped when they have a governance reservation; background governance settles
 * are awaited, all within `timeoutMs`. A call made while a stop is in progress returns that
 * stop's promise (and its time limit).
 */
export function stopTracing(timeoutMs: number = SHUTDOWN_SETTLE_TIMEOUT_MS): Promise<void> {
  const state = runtimeState();
  if (state.stopping === undefined) {
    const stopping: Promise<void> = stop(state, timeoutMs).finally(() => {
      if (state.stopping === stopping) {
        state.stopping = undefined;
      }
    });
    state.stopping = stopping;
  }
  return state.stopping;
}

async function stop(state: TracciaRuntime, timeoutMs: number): Promise<void> {
  // An init() in progress finishes (or rolls back) first, so the stop below sees a whole
  // provider and its started flag, never a half-configured one. init() calls made while this
  // stop runs wait for it, so this cannot wait on an init() that started after it.
  if (state.initializing !== undefined) {
    await state.initializing.catch(() => undefined);
  }
  // Read once: state can change while the settles below wait.
  const provider = state.provider;
  try {
    if (!provider) {
      return;
    }

    // Settle calls still open, so their spans end before the flush below, and let background
    // governance settles reach the server first.
    await settleOpenCalls(timeoutMs).catch(() => undefined);
    await shutdownProvider(provider);
    if (state.provider === provider) {
      state.started = false;
      state.provider = null;
      state.costProvider = null;
    }
  } finally {
    // Only now: the settles above read the init() credentials. (A settle that starts later,
    // after a policy check that outlived the time limit, uses the credentials of its check.)
    clearClientConfig();
  }
}

/** Shut `provider` down once, however many shutdowns ask; a failed one can be retried. */
function shutdownProvider(provider: TracerProvider): Promise<void> {
  const state = runtimeState();
  if (!state.providerShutdowns) {
    state.providerShutdowns = new WeakMap();
  }
  const shutdowns = state.providerShutdowns;
  let done = shutdowns.get(provider);
  if (done === undefined) {
    done = provider.shutdown();
    shutdowns.set(provider, done);
    done.catch(() => shutdowns.delete(provider));
  }
  return done;
}

/**
 * Register shutdown hooks.
 */
function registerShutdown(provider: TracerProvider, _processor: BatchSpanProcessor): void {
  if (_registeredShutdown) {
    return;
  }

  let signalled: Promise<void> | undefined;
  const drainAndShutdown = async (): Promise<void> => {
    const state = runtimeState();
    try {
      if (state.stopping !== undefined) {
        // A stopTracing() in progress settles the calls and shuts the provider down.
        await state.stopping;
        return;
      }
      // An init() setting up again after a stopTracing(): let it finish (or roll back) first, as
      // stopTracing() does, so its processors are not added to a provider already shut down.
      if (state.initializing !== undefined) {
        await state.initializing.catch(() => undefined);
      }
      // The provider in use now (stopTracing() and a later init() replace the first one), read
      // before the wait below.
      const current = state.provider ?? provider;
      // This listener replaces Node's default exit, so the app keeps running (often draining
      // its own work): let calls in flight finish rather than stop them, within the time limit.
      await drainOpenCalls();
      await shutdownProvider(current);
    } catch {
      // Silently fail
    }
  };
  // SIGTERM then SIGINT (or a repeated signal) share one shutdown.
  const shutdown = (): Promise<void> => {
    if (signalled === undefined) {
      signalled = drainAndShutdown().finally(() => {
        signalled = undefined;
      });
    }
    return signalled;
  };

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  process.on('SIGTERM', shutdown);
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  process.on('SIGINT', shutdown);
  _registeredShutdown = true;
}

/**
 * Alias for backwards compatibility.
 */
export const startTracing = init;

let _registeredShutdown = false;

/**
 * Composite exporter combining multiple exporters.
 */
class CompositeExporter implements ISpanExporter {
  private exporters: ISpanExporter[];

  public constructor(exporters: ISpanExporter[]) {
    this.exporters = exporters;
  }

  public async export(spans: any[]): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call,@typescript-eslint/no-unsafe-member-access,@typescript-eslint/no-unsafe-argument
    const results = await Promise.all(this.exporters.map((e) => e.export(spans)));
    return results.every((r) => r);
  }

  public async shutdown(): Promise<void> {
    await Promise.all(this.exporters.map((e) => e.shutdown()));
  }
}
export { getTracerProvider as initSDK };
export { runWithAutoTrace } from './auto-trace-helper';