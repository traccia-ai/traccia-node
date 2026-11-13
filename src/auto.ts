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
import { setClientConfig, clearClientConfig } from './config/client-config';
import { loadEnvFile, findAgentConfigPath } from './config/env-config';
import { loadPricingWithSource } from './config/pricing-config';
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
import { CostResolver, setResolver } from './processor/cost-resolver';
import { SDKConfig, ISpanExporter, ITracer } from './types';
import { configureGovernance } from './governance/config';
import { configurePrompts } from './prompts';
import { patchGemini } from './instrumentation/gemini';
import { patchAxios } from './instrumentation/axios';
import { patchOpenAI, patchOpenAIResponses } from './instrumentation/openai';
import { patchAnthropic } from './instrumentation/anthropic';

const RUNTIME_KEY = Symbol.for('traccia.runtime');

export interface TracciaRuntime {
  provider: TracerProvider | null;
  started: boolean;
  taskChildCosts?: import('async_hooks').AsyncLocalStorage<Array<{ cost: number | null }>>;
  costProvider?: TracerProvider | null;
  /** The teardown stopTracing() is running, shared by concurrent callers. */
  stopping?: Promise<void> | null;
  /** Exit and signal hooks are installed (once per process, across bundles). */
  exitHooksInstalled?: boolean;
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

export async function init(config: SDKConfig = {}): Promise<TracerProvider> {
  // A stopTracing() still running would otherwise leave started=true and hand back the
  // provider it is shutting down.
  const stopping = runtimeState().stopping;
  if (stopping != null) {
    await stopping.catch(() => undefined);
  }
  if (runtimeState().started) {
    // Tracing stays as it is, but policy checks start afresh (TRC-342): no
    // remembered fail mode, and this call's policyFailMode applies.
    applyGovernanceConfig(config);
    return getTracerProvider();
  }

  runtimeState().started = true;

  // Get or create provider. Its own OTel provider creates Traccia spans and
  // carries the sampler; registering it globally is best effort, since OTel
  // keeps the first global provider for the life of the process.
  const provider = getTracerProvider();
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
    const providerAny = basicProvider as any;
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
    provider.addSpanProcessor(new TokenCountingProcessor());
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
    });
    provider.addSpanProcessor(costProcessor);
    setResolver(new CostResolver(pricing, pricingSource, pricingGeneratedAt));
  }

  provider.addSpanProcessor(
    new AgentEnrichmentProcessor({
      agentConfigPath: agentConfigPath,
      defaultAgentId: getAgentId(),
      defaultAgentName: getAgentName(),
      defaultEnv: getRuntimeEnv(),
      serviceRole: config.serviceRole,
    }),
  );

  const guardrailHeuristics = config.guardrailHeuristics ?? loadedConfig.instrumentation.guardrail_heuristics ?? true;
  provider.addSpanProcessor(new GuardrailDetectorProcessor({ heuristicsEnabled: guardrailHeuristics }));

  const frameworks = config.compliance?.frameworks || [];
  const euRiskTier =
    frameworks.includes("eu_ai_act") || config.compliance?.risk_tier
      ? (config.compliance?.risk_tier as string | undefined)
      : undefined;
  const hipaaEnabled = frameworks.includes("hipaa");
  provider.addSpanProcessor(new GovernanceEnrichmentProcessor({ euRiskTier, hipaaEnabled }));

  let redactPii = config.redactPii ?? loadedConfig.instrumentation.redact_pii ?? false;
  if (hipaaEnabled && config.redactPii === undefined && loadedConfig.instrumentation.redact_pii === undefined) {
    redactPii = true;
  }
  if (redactPii) {
    provider.addSpanProcessor(new RedactionSpanProcessor());
  }

  // Log after enrichment and redaction so span logs never contain unredacted values.
  if (config.enableSpanLogging || loadedConfig.logging.enable_span_logging) {
    provider.addSpanProcessor(new LoggingSpanProcessor());
  }

  // Add batch processor with exporter
  const processor = new BatchSpanProcessor({
    exporter,
    maxQueueSize: config.maxQueueSize ?? loadedConfig.rate_limiting.max_queue_size ?? 5000,
    maxExportBatchSize: config.maxExportBatchSize ?? loadedConfig.rate_limiting.max_export_batch_size ?? 512,
    scheduleDelayMs: config.scheduleDelayMs ?? loadedConfig.rate_limiting.schedule_delay_millis ?? 5000,
    sampler,
  });

  provider.addSpanProcessor(processor);
  installExitHooks();

  if (loadedConfig.instrumentation.enable_patching !== false) {
    try {
      patchGemini();
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
 * Stop tracing and shutdown all processors. Concurrent calls (an explicit call racing the exit
 * or signal hook) share one teardown, so spans are exported and the exporter shut down once.
 */
export async function stopTracing(): Promise<void> {
  const state = runtimeState();
  if (state.stopping != null) {
    return state.stopping;
  }
  clearClientConfig();
  const provider = state.provider;
  if (!provider) {
    return;
  }

  state.stopping = (async (): Promise<void> => {
    try {
      await provider.shutdown();
    } finally {
      // Clear even if shutdown failed, so the exit hook cannot retry it in a loop. Tracing is
      // stopped either way; a provider set with setTracerProvider() meanwhile stays in place.
      state.started = false;
      if (state.provider === provider) {
        state.provider = null;
        state.costProvider = null;
      }
      state.stopping = null;
    }
  })();
  return state.stopping;
}

/**
 * Install the process hooks that flush spans when the app did not call stopTracing():
 * - beforeExit: the event loop ran out of work (a script or job finishing normally). The batch
 *   timer is unref'ed, so without this the queued spans are dropped. beforeExit fires again
 *   once the export's I/O finishes; by then the provider is gone, so the hook does nothing.
 *   An export that cannot finish (an unreachable endpoint being retried) keeps the process
 *   alive, so after EXIT_FLUSH_TIMEOUT_MS the process exits with the app's process.exitCode.
 * - SIGINT/SIGTERM: flush (up to the same deadline), then terminate (see terminateAfterSignal).
 * Each hook acts on the provider current at that moment, not the one from the first init().
 * Not covered: process.exit() and frozen serverless runtimes, which skip beforeExit; those
 * apps must await stopTracing() themselves.
 */
function installExitHooks(): void {
  const state = runtimeState();
  if (state.exitHooksInstalled) {
    return;
  }
  state.exitHooksInstalled = true;

  let exitTimer: NodeJS.Timeout | undefined;
  process.on('beforeExit', () => {
    if (!runtimeState().provider) {
      return;
    }
    const stopped = stopTracing().catch(() => undefined);
    if (exitTimer !== undefined) {
      return;
    }
    // Unreferenced: it never keeps the process alive by itself, but still fires while a stuck
    // export does. process.exit() with no code exits with process.exitCode, as a natural exit would.
    exitTimer = setTimeout(() => process.exit(), EXIT_FLUSH_TIMEOUT_MS);
    exitTimer.unref();
    stopped
      .then(() => {
        clearTimeout(exitTimer);
        exitTimer = undefined;
      })
      .catch(() => undefined);
  });

  let flushing = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (flushing) {
      // A second Ctrl+C while the flush is still running (a slow or hung exporter): stop waiting.
      terminateAfterSignal(signal, onSignal);
      return;
    }
    flushing = true;
    // shutdown() drains without a deadline, so bound it here: a hung export must not keep a
    // signalled process alive. The timer stays referenced so it fires even with no other work.
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, EXIT_FLUSH_TIMEOUT_MS);
    });
    Promise.race([stopTracing().catch(() => undefined), deadline])
      .then(() => {
        clearTimeout(timer);
        flushing = false;
        terminateAfterSignal(signal, onSignal);
      })
      .catch(() => undefined);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

/**
 * How long an exiting process (natural exit or SIGINT/SIGTERM) waits for spans to export
 * before it ends anyway. A reachable collector takes well under a second; an unreachable one
 * would otherwise hold the process for the exporter's full retry schedule (10-17 s).
 */
const EXIT_FLUSH_TIMEOUT_MS = 5000;

/**
 * Called once a SIGINT/SIGTERM-triggered flush has finished. `listener` is the SDK's own
 * handler for that signal. Registering any listener replaces Node's default action for a
 * signal (terminate), so unless something restores it the process keeps running.
 *
 * If the app has its own handler for the signal (a server draining connections, the CLI's eval
 * interrupt), it owns termination and the SDK leaves it alone. Otherwise the SDK removes its
 * listener and re-raises the signal, so Node's default applies and the process dies *by the
 * signal* (what shells, systemd and Kubernetes expect), not with an invented exit code.
 */
function terminateAfterSignal(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): void {
  const others = process.listeners(signal).filter((l) => l !== listener);
  if (others.length > 0) {
    return;
  }
  process.removeListener(signal, listener);
  process.kill(process.pid, signal);
}

/**
 * Alias for backwards compatibility.
 */
export const startTracing = init;

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