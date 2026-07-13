/**
 * Main SDK entry point.
 */

export {
  getTracer,
  getTracerProvider,
  setTracerProvider,
  init,
  startTracing,
  stopTracing,
  runWithAutoTrace,
} from './auto';

export { observe, ObserveOptions } from './instrumentation/decorator';
export { govern, GovernOptions } from './governance/govern';
export { AgentBlockedError, checkAgentStatus } from './governance/policy';
export { disclosure, enrichGovernanceAttributes } from './governance/disclosure';
export type { DisclosureOptions, EnrichGovernanceAttributesOptions } from './governance/disclosure';
export { governanceHooks, GovernanceManager } from './governance/hooks';
export type { GovernanceHook } from './governance/hooks';
export { runIdentity } from './config/runtime-config';
export { getCurrentSpan, runWithSpan, runWithSpanAsync } from './context/context';
export { spanScope } from './context/span-scope';
export type { SpanScope, SpanScopeOptions } from './context/span-scope';
export {
  W3CTraceContextPropagator,
  injectHttpHeaders,
  extractHttpHeaders,
} from './context';
export type { TextMapPropagator } from './context';

export {
  TracerProvider,
  Tracer,
  Span,
} from './tracer';

export {
  HttpExporter,
  ConsoleExporter,
  FileExporter,
} from './exporter';
export type { FileExporterOptions } from './exporter';

export {
  Sampler,
  BatchSpanProcessor,
  TokenCountingProcessor,
  CostAnnotatingProcessor,
  LoggingSpanProcessor,
  RateLimitingSpanProcessor,
  RateLimiter,
  AgentEnrichmentProcessor,
  computeCost,
  DropOldestPolicy,
  DropNewestPolicy,
} from './processor';
export type {
  RateLimiterOptions,
  RateLimiterStats,
  RateLimitingProcessorOptions,
  AgentEnrichmentOptions,
  IDropPolicy,
} from './processor';

export type {
  ISpan,
  ITracer,
  ITracerProvider,
  ISpanContext,
  ISpanProcessor,
  ISpanExporter,
  ISampler,
  SDKConfig,
  Resource,
  SpanEvent,
  SamplingResult,
} from './types';

export { SpanStatus } from './types';

export {
  GuardrailDetectorProcessor,
  GovernanceEnrichmentProcessor,
} from './processor';
export type { GuardrailDetectorOptions, GovernanceEnrichmentOptions } from './processor';

export {
  GuardrailCategory,
  SourceType,
  Confidence,
  EnforcementMode,
  FindingStatus,
  EvidenceRef,
  GuardrailFinding,
  MissingGuardrail,
  GuardrailSummary,
  GuardrailFindingWithMeta,
  dedupeFindings,
} from './guardrails';
export {
  ATTR_GUARDRAIL_CATEGORY,
  ATTR_GUARDRAIL_NAME,
  ATTR_GUARDRAIL_TRIGGERED,
  ATTR_GUARDRAIL_ENFORCEMENT_MODE,
  ATTR_GUARDRAIL_POLICY_ID,
  ATTR_GUARDRAIL_SOURCE_SDK,
  ATTR_GUARDRAIL_EVIDENCE_TYPE,
  ATTR_GUARDRAIL_SUPPRESS_MISSING,
} from './guardrails';

export {
  validateGuardrailAttributes,
  guardrailSpan,
  GuardrailSpanOptions,
} from './guardrails';

// Governance
export {
  EVENT_TYPE,
  SESSION_ID,
  MODEL_ID,
  MODEL_VERSION,
  INPUT_HASH,
  OUTPUT_HASH,
  TIMESTAMP_SOURCE,
  REDACTION_APPLIED,
  INTEGRITY_HASH,
  RISK_TIER,
  ANNEX_III_CATEGORY,
  HIPAA_FRAMEWORK_ENABLED,
  HIPAA_PHI_REDACTION_APPLIED,
  HIPAA_PREFIX,
  TRANSPARENCY_DISCLOSED,
  CONTENT_SYNTHETIC,
  GOVERNANCE_PREFIX,
  EU_AI_ACT_PREFIX,
} from './governance/schema';
export {
  RedactionSpanProcessor,
} from './redaction/processor';
export type { RedactionSpanProcessorOptions } from './redaction/processor';
export {
  redactString,
  redactValue,
  redactAttributes,
  applyRedactionToSpan,
  DEFAULT_SENSITIVE_KEY_FRAGMENTS,
} from './redaction';

// Metrics
export {
  StandardMetrics,
  MetricsRecorder,
  setGlobalRecorder,
  getMetricsRecorder,
  recordCounter,
  recordHistogram,
} from './metrics';

// Instrumentation
export {
  patchOpenAI,
  wrapOpenAICreate,
  patchOpenAIResponses,
  wrapOpenAIResponsesCreate,
  patchAnthropic,
  wrapAnthropicCreate,
  patchAxios,
  createTracedAxios,
  patchFetch,
  unpatchFetch,
  createTracedFetch,
  expressMiddleware,
  expressErrorMiddleware,
  fastifyPlugin,
  fastifyPluginAsync,
} from './instrumentation';
export type { TracingMiddlewareOptions, FastifyTracingOptions } from './instrumentation';

// Integrations
export { installOpenAIAgents, installCrewai } from './integrations';

// Unified Namespace for convenience (matches Python SDK)
import { init } from './auto';
import { getTracer } from './auto';
import { observe } from './instrumentation/decorator';
import { govern } from './governance/govern';
import { setSessionId, setUserId, setTenantId, setProjectId } from './config/runtime-config';
import { getCurrentSpan } from './context/context';
import { injectHttpHeaders, extractHttpHeaders } from './context';

export const Traccia = {
  init,
  getTracer,
  observe,
  govern,
  setSessionId,
  setUserId,
  setTenantId,
  setProjectId,
  getCurrentSpan,
  injectHttpHeaders,
  extractHttpHeaders,
};

