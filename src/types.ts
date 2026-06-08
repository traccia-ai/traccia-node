/**
 * Core types and interfaces for the tracing SDK.
 */

/**
 * Span status enumeration.
 */
export enum SpanStatus {
  UNSET = 0,
  OK = 1,
  ERROR = 2,
}

/**
 * Span context carries trace and span identification across process boundaries.
 */
export interface ISpanContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
  traceState?: string;
}

/**
 * Span event for capturing events during span execution.
 */
export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes?: Record<string, unknown>;
}

/**
 * Span interface for creating and ending spans.
 */
export interface ISpan {
  context: ISpanContext;
  name: string;
  parentSpanId?: string;
  attributes: Record<string, unknown>;
  events: SpanEvent[];
  status: SpanStatus;
  statusDescription?: string;
  startTimeNs: number;
  endTimeNs?: number;
  durationNs: number | undefined;

  setAttribute(key: string, value: unknown): void;
  addEvent(name: string, attributes?: Record<string, unknown>): void;
  end(): void;
  recordException(error: Error, attributes?: Record<string, unknown>): void;
  isRecording(): boolean;
}

/**
 * Tracer for creating and managing spans.
 */
export interface ITracer {
  startSpan(
    name: string,
    options?: {
      attributes?: Record<string, unknown>;
      parent?: ISpan | null;
      parentContext?: ISpanContext | null;
    }
  ): ISpan;

  startActiveSpan<T = unknown>(
    name: string,
    fn: (span: ISpan) => Promise<T> | T,
    options?: {
      attributes?: Record<string, unknown>;
      parent?: ISpan | null;
    }
  ): Promise<T> | T;
}

/**
 * Span processor for handling spans at various lifecycle points.
 */
export interface ISpanProcessor {
  onStart?(span: ISpan): void;
  onEnd(span: ISpan): void;
  shutdown(): Promise<void> | void;
  forceFlush(timeout?: number): Promise<void> | void;
}

/**
 * Span exporter for sending spans to a backend.
 */
export interface ISpanExporter {
  export(spans: ISpan[]): Promise<boolean> | boolean;
  shutdown(): Promise<void> | void;
}

/**
 * Resource attributes describing the service.
 */
export interface Resource {
  [key: string]: string | number | boolean;
}

/**
 * Tracer provider for managing tracers and processors.
 */
export interface ITracerProvider {
  getTracer(name: string, version?: string): ITracer;
  addSpanProcessor(processor: ISpanProcessor): void;
  removeSpanProcessor(processor: ISpanProcessor): void;
  forceFlush(timeout?: number): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Configuration for the SDK initialization.
 */
export interface SDKConfig {
  apiKey?: string;
  endpoint?: string;
  sampleRate?: number;
  maxQueueSize?: number;
  maxExportBatchSize?: number;
  scheduleDelayMs?: number;
  enableConsoleExporter?: boolean;
  useOtlp?: boolean;
  enableTokenCounting?: boolean;
  enableCostTracking?: boolean;
  enableSpanLogging?: boolean;
  guardrailHeuristics?: boolean;
  redactPii?: boolean;
  pricingOverride?: Record<string, Record<string, number>>;
  sessionId?: string;
  userId?: string;
  tenantId?: string;
  projectId?: string;
  debug?: boolean;
  attrTruncationLimit?: number;
  loadEnv?: boolean;
  autoInstrument?: boolean;
  toolInclude?: string[];
  maxToolSpans?: number;
  maxSpanDepth?: number;
  resource?: Resource;
  exporter?: ISpanExporter;
  compliance?: { frameworks?: string[]; risk_tier?: string };
  enableMetrics?: boolean;
  metricsEndpoint?: string;
  metricsSampleRate?: number;
}

/**
 * Sampling result for span sampling decisions.
 */
export interface SamplingResult {
  sampled: boolean;
}

/**
 * Sampler interface for making sampling decisions.
 */
export interface ISampler {
  shouldSample(): SamplingResult;
}
