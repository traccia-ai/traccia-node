/**
 * Span implementation with lifecycle management.
 */

import { ISpan, ITracer, SpanStatus, SpanEvent, ISpanContext } from '../types';
import { SpanContext } from './span-context';
import { getConfig } from '../config/runtime-config';
import type { TracerProvider } from './provider';

/**
 * Span implementation representing a unit of work.
 */
export class Span implements ISpan {
  public context: ISpanContext;
  public name: string;
  public parentSpanId?: string;
  public attributes: Record<string, unknown>;
  public events: SpanEvent[] = [];
  public status: SpanStatus = SpanStatus.UNSET;
  public statusDescription?: string;
  public startTimeNs: number;
  public endTimeNs?: number;

  private ended = false;
  private provider: TracerProvider;

  constructor(
    name: string,
    _tracer: ITracer,
    context: ISpanContext,
    parentSpanId?: string,
    attributes?: Record<string, unknown>,
    provider?: TracerProvider
  ) {
    this.name = name;
    this.context = context;
    this.parentSpanId = parentSpanId;
    this.attributes = attributes ? { ...attributes } : {};
    this.startTimeNs = performance.now() * 1_000_000;
    this.provider = provider!;

    // Apply runtime metadata to tracestate
    this.enrichTraceState();
  }

  /**
   * Get the duration in nanoseconds.
   */
  get durationNs(): number | undefined {
    if (this.endTimeNs === undefined) {
      return undefined;
    }
    return this.endTimeNs - this.startTimeNs;
  }

  /**
   * Set an attribute on the span.
   */
  setAttribute(key: string, value: unknown): void {
    if (this.ended) {
      return;
    }
    this.attributes[key] = value;
  }

  /**
   * Add an event to the span.
   */
  addEvent(name: string, attributes?: Record<string, unknown>): void {
    if (this.ended) {
      return;
    }
    this.events.push({
      name,
      timestamp: performance.now() * 1_000_000,
      attributes: attributes ? { ...attributes } : {},
    });
  }

  /**
   * Record an exception on the span.
   */
  recordException(error: Error, attributes?: Record<string, unknown>): void {
    if (this.ended) {
      return;
    }
    this.status = SpanStatus.ERROR;
    this.statusDescription = error.message;
    this.addEvent('exception', {
      ...attributes,
      'exception.type': error.name,
      'exception.message': error.message,
      'exception.stacktrace': error.stack,
    });
  }

  /**
   * End the span.
   */
  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.endTimeNs = performance.now() * 1_000_000;
    
    // Notify provider of span end
    if (this.provider) {
      this.provider.notifySpanEnd(this);
    }
  }

  /**
   * Check if the span is still recording.
   */
  isRecording(): boolean {
    return !this.ended;
  }

  /**
   * Enrich the trace state with runtime metadata.
   */
  private enrichTraceState(): void {
    try {
      const config = getConfig();
      let traceState = this.context.traceState || '';

      const metadata: Record<string, string> = {};
      if (config.tenantId) {
        metadata['tenant'] = config.tenantId;
      }
      if (config.projectId) {
        metadata['project'] = config.projectId;
      }
      if (config.debug) {
        metadata['dbg'] = '1';
      }

      if (Object.keys(metadata).length > 0) {
        const pairs = Object.entries(metadata).map(([k, v]) => `${k}=${v}`);
        traceState = pairs.join(',');

        this.context = new SpanContext(
          this.context.traceId,
          this.context.spanId,
          this.context.traceFlags,
          traceState
        );
      }
    } catch {
      // Silently fail on trace state enrichment
    }
  }
}
