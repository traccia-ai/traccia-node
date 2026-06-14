/**
 * Span implementation wrapping OpenTelemetry.
 */

import { Span as OTelSpan, SpanStatusCode } from '@opentelemetry/api';
import { ISpan, SpanStatus, SpanEvent, ISpanContext } from '../types';
import type { TracerProvider } from './provider';

/**
 * Span implementation representing a unit of work.
 */
export class Span implements ISpan {
  public attributes: Record<string, unknown> = {};
  public events: SpanEvent[] = [];
  public status: SpanStatus = SpanStatus.UNSET;
  public statusDescription?: string;
  public startTimeNs: number;
  public endTimeNs?: number;
  public name: string;
  public parentSpanId?: string;

  private otelSpan: OTelSpan;
  private provider: TracerProvider;
  private ended = false;

  constructor(name: string, otelSpan: OTelSpan, provider?: TracerProvider, parentSpanId?: string, attributes?: Record<string, unknown>) {
    this.name = name;
    this.otelSpan = otelSpan;
    this.provider = provider as TracerProvider;
    this.parentSpanId = parentSpanId;
    this.attributes = attributes ? { ...attributes } : {};
    this.startTimeNs = Math.floor((performance.timeOrigin + performance.now()) * 1_000_000);
  }

  get context(): ISpanContext {
    const ctx = this.otelSpan.spanContext();
    return {
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      traceFlags: ctx.traceFlags,
      traceState: ctx.traceState?.serialize()
    };
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
    if (this.ended) return;
    this.attributes[key] = value;
    this.otelSpan.setAttribute(key, value as any);
  }

  /**
   * Add an event to the span.
   */
  addEvent(name: string, attributes?: Record<string, unknown>): void {
    if (this.ended) return;
    this.events.push({
      name,
      timestamp: Math.floor((performance.timeOrigin + performance.now()) * 1_000_000),
      attributes: attributes ? { ...attributes } : {},
    });
    this.otelSpan.addEvent(name, attributes as any);
  }

  /**
   * Record an exception on the span.
   */
  recordException(error: Error, attributes?: Record<string, unknown>): void {
    if (this.ended) return;
    this.status = SpanStatus.ERROR;
    this.statusDescription = error.message;
    this.otelSpan.setStatus({
      code: SpanStatusCode.ERROR,
      message: error.message
    });
    this.otelSpan.recordException(error);
  }

  /**
   * End the span.
   */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.endTimeNs = Math.floor((performance.timeOrigin + performance.now()) * 1_000_000);
    
    // Notify provider of span end
    if (this.provider) {
      this.provider.notifySpanEnd(this);
    }
    
    this.otelSpan.end();
  }

  /**
   * Check if the span is still recording.
   */
  isRecording(): boolean {
    // Return true if not ended to support testing without a global OTel provider
    return !this.ended;
  }
}
