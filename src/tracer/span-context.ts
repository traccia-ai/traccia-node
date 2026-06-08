/**
 * Span context implementation.
 */

import { ISpanContext } from '../types';

/**
 * Implementation of span context carrying trace and span identification.
 */
export class SpanContext implements ISpanContext {
  public readonly traceId: string;
  public readonly spanId: string;
  public readonly traceFlags: number;
  public readonly traceState?: string;

  constructor(
    traceId: string,
    spanId: string,
    traceFlags: number = 1,
    traceState?: string
  ) {
    this.traceId = traceId;
    this.spanId = spanId;
    this.traceFlags = traceFlags;
    this.traceState = traceState;
  }

  /**
   * Check if this span context is valid.
   */
  isValid(): boolean {
    return (
      this.traceId.length > 0 &&
      this.spanId.length > 0 &&
      this.traceId !== '0'.repeat(32) &&
      this.spanId !== '0'.repeat(16)
    );
  }

  /**
   * Check if this context is sampled.
   */
  isSampled(): boolean {
    return this.traceFlags === 1;
  }
}
