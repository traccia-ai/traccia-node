/**
 * SDK initialization and global tracer management.
 */

import { TracerProvider } from './tracer/provider';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
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
import { loadEnvFile, findAgentConfigPath } from './config/env-config';
import { loadPricingWithSource } from './config/pricing-config';
import {
  updateConfig,
  setSessionId,
  setUserId,
  setTenantId,
  setProjectId,
} from './config/runtime-config';
import { SDKConfig, ISpanExporter, ITracer } from './types';

let globalProvider: TracerProvider | null = null;
let started = false;

/**
 * Get the global tracer provider.
 */
export function getTracerProvider(): TracerProvider {
  if (!globalProvider) {
    globalProvider = new TracerProvider();
  }
  return globalProvider;
}

/**
 * Set the global tracer provider.
 */
export function setTracerProvider(provider: TracerProvider): void {
  globalProvider = provider;
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
export async function init(config: SDKConfig = {}): Promise<TracerProvider> {
  if (started) {
    return getTracerProvider();
  }

  started = true;

  const basicProvider = new BasicTracerProvider();
  trace.setGlobalTracerProvider(basicProvider);

  // Load environment
  if (config.loadEnv !== false) {
    loadEnvFile();
  }

  // Load configuration (files + env vars)
  const loadedConfig = loadConfig();

  // overrides from argument 'config' take precedence
  const apiKey = config.apiKey || loadedConfig.tracing.api_key || '';
  const endpoint = config.endpoint || loadedConfig.tracing.endpoint || DEFAULT_ENDPOINT;
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

  if (config.serviceRole) {
    const providerAny = basicProvider as any;
    if (providerAny.resource && providerAny.resource.attributes) {
      providerAny.resource.attributes['traccia.service_role'] = config.serviceRole;
    }
  }

  // Get or create provider
  const provider = getTracerProvider();

  // Set sampler
  // Set sampler
  const sampler = new Sampler(Math.min(1, Math.max(0, sampleRate)));
  provider.setSampler(sampler);

  // Create exporter
  let exporter: ISpanExporter;

  if (config.exporter) {
    exporter = config.exporter;
  } else if (useOtlp !== false) {
    exporter = new OtlpExporter({
      endpoint,
      apiKey,
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
    const [pricing] = await loadPricingWithSource(pricingTable);
    provider.addSpanProcessor(new CostAnnotatingProcessor(pricing));
  }

  if (config.enableSpanLogging || loadedConfig.logging.enable_span_logging) {
    provider.addSpanProcessor(new LoggingSpanProcessor());
  }

  // Add guardrail detector processor
  const guardrailHeuristics = config.guardrailHeuristics ?? loadedConfig.instrumentation.guardrail_heuristics ?? true;
  provider.addSpanProcessor(new GuardrailDetectorProcessor({ heuristicsEnabled: guardrailHeuristics }));

  // Add governance enrichment processor
  const euRiskTier = config.compliance?.risk_tier as string | undefined;
  provider.addSpanProcessor(new GovernanceEnrichmentProcessor({ euRiskTier }));

  // Add redaction processor if enabled
  const redactPii = config.redactPii ?? loadedConfig.instrumentation.redact_pii ?? false;
  if (redactPii) {
    provider.addSpanProcessor(new RedactionSpanProcessor());
  }

  // Agent enrichment
  provider.addSpanProcessor(
    new AgentEnrichmentProcessor({
      serviceRole: config.serviceRole,
    })
  );

  // Add batch processor with exporter
  const processor = new BatchSpanProcessor({
    exporter,
    maxQueueSize: config.maxQueueSize ?? loadedConfig.rate_limiting.max_queue_size ?? 5000,
    maxExportBatchSize: config.maxExportBatchSize ?? loadedConfig.rate_limiting.max_export_batch_size ?? 512,
    scheduleDelayMs: config.scheduleDelayMs ?? loadedConfig.rate_limiting.schedule_delay_millis ?? 5000,
    sampler,
  });

  provider.addSpanProcessor(processor);
  registerShutdown(provider, processor);

  return provider;
}

/**
 * Stop tracing and shutdown all processors.
 */
export async function stopTracing(): Promise<void> {
  if (!globalProvider) {
    return;
  }

  await globalProvider.shutdown();
  started = false;
  globalProvider = null;
}

/**
 * Register shutdown hooks.
 */
function registerShutdown(provider: TracerProvider, _processor: BatchSpanProcessor): void {
  if (_registeredShutdown) {
    return;
  }

  const shutdown = async (): Promise<void> => {
    try {
      await provider.shutdown();
    } catch {
      // Silently fail
    }
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