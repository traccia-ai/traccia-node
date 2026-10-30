/**
 * Span implementation wrapping OpenTelemetry.
 */

import { Span as OTelSpan, SpanStatusCode } from '@opentelemetry/api';
import { ISpan, SpanStatus, SpanEvent, ISpanContext } from '../types';
import type { TracerProvider } from './provider';
import { forgetTrace } from '../governance/evidence';

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
   *
   * Events are buffered and flushed to OTel in end(), after enrichment
   * processors (e.g. redaction) have had a chance to rewrite them.
   */
  addEvent(name: string, attributes?: Record<string, unknown>): void {
    if (this.ended) return;
    this.events.push({
      name,
      timestamp: Math.floor((performance.timeOrigin + performance.now()) * 1_000_000),
      attributes: attributes ? { ...attributes } : {},
    });
  }

  /**
   * Record an exception on the span (buffered like addEvent).
   */
  recordException(error: Error, attributes?: Record<string, unknown>): void {
    if (this.ended) return;
    this.status = SpanStatus.ERROR;
    this.statusDescription = error?.message;
    this.addEvent('exception', {
      'exception.type': error?.name,
      'exception.message': error?.message,
      'exception.stacktrace': error?.stack,
      ...attributes,
    });
  }

  /**
   * End the span.
   *
   * Enrichment processors run before the span is marked ended so they can still
   * call setAttribute (Python parity). Export processors in the same list see
   * the enriched attributes. After this returns, the span is immutable.
   */
  end(): void {
    if (this.ended) return;
    this.endTimeNs = Math.floor((performance.timeOrigin + performance.now()) * 1_000_000);

    if (this.provider) {
      this.provider.notifySpanEnd(this);
    }

    this.ended = true;
    this.flushToOtel();
    this.otelSpan.end();

    // The run is over once its local root span ends; drop its policy evidence.
    if (!this.parentSpanId) {
      forgetTrace(this.context?.traceId);
    }
  }

  private flushToOtel(): void {
    for (const event of this.events) {
      const attrs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(event.attributes ?? {})) {
        if (v !== undefined && v !== null) attrs[k] = v;
      }
      // SpanEvent.timestamp is epoch ns; OTel accepts [seconds, nanos]
      const ns = event.timestamp;
      const time: [number, number] = [Math.floor(ns / 1e9), Math.floor(ns % 1e9)];
      this.otelSpan.addEvent(event.name, attrs as any, time);
    }
    if (this.status === SpanStatus.ERROR) {
      this.otelSpan.setStatus({ code: SpanStatusCode.ERROR, message: this.statusDescription });
    }
  }

  /**
   * Check if the span is still recording.
   */
  isRecording(): boolean {
    // Return true if not ended to support testing without a global OTel provider
    return !this.ended;
  }
}
