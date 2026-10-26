/**
 * Context propagation tools.
 */

import { ISpanContext } from '../types';
import { W3CTraceContextPropagator, TextMapPropagator, HeaderCarrier } from './propagators';

const w3cPropagator = new W3CTraceContextPropagator();

export { W3CTraceContextPropagator };
export type { TextMapPropagator, HeaderCarrier };
export {
  getCurrentSpan,
  setCurrentSpan,
  runWithSpan,
  runWithSpanAsync,
  getContext,
  getOtelContextForSpan,
  AsyncLocalStorageContextManager,
} from './context';
export { spanScope } from './span-scope';
export type { SpanScope, SpanScopeOptions } from './span-scope';

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
export function extractHttpHeaders(headers: HeaderCarrier): ISpanContext | null {
  return w3cPropagator.extract(headers);
}
