/**
 * Context propagation tools.
 */

import { ISpanContext } from '../types';
import { W3CTraceContextPropagator, TextMapPropagator } from './propagators';

const w3cPropagator = new W3CTraceContextPropagator();

export { W3CTraceContextPropagator };
export type { TextMapPropagator };

/**
 * Inject the current trace context into an HTTP headers object.
 *
 * @param context The span context to inject.
 * @param headers The headers object to inject into.
 */
export function injectHttpHeaders(context: ISpanContext, headers: Record<string, string>): void {
  w3cPropagator.inject(context, headers);
}

/**
 * Extract trace context from an HTTP headers object.
 *
 * @param headers The headers object to extract from.
 * @returns The extracted span context or null if not found.
 */
export function extractHttpHeaders(headers: Record<string, string>): ISpanContext | null {
  return w3cPropagator.extract(headers);
}
