/**
 * Native fetch instrumentation.
 *
 * Patches globalThis.fetch to automatically create spans for HTTP requests.
 */

import { getTracer } from '../auto';
import { SpanStatus, ISpan } from '../types';

let _patched = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _originalFetch: any;

// Local type definitions to avoid DOM dependency
type FetchInput = string | { url: string; method?: string } | { toString(): string };
type FetchInit = { method?: string;[key: string]: unknown };
type FetchResponse = {
    status: number;
    statusText: string;
};

/**
 * Patch native fetch for HTTP request tracing.
 *
 * @returns true if patched successfully, false otherwise
 */
export function patchFetch(): boolean {
    if (_patched) {
        return true;
    }

    // Check if fetch exists
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    if (typeof (globalThis as any).fetch !== 'function') {
        return false;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    _originalFetch = (globalThis as any).fetch;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (globalThis as any).fetch = async function tracedFetch(
        input: FetchInput,
        init?: FetchInit
    ): Promise<FetchResponse> {
        const tracer = getTracer('fetch');
        const startTime = Date.now();

        // Extract URL and method
        let url: string;
        let method: string;

        if (typeof input === 'string') {
            url = input;
            method = init?.method || 'GET';
        } else if (typeof input === 'object' && 'url' in input) {
            url = input.url;
            method = input.method || init?.method || 'GET';
        } else {
            url = String(input);
            method = init?.method || 'GET';
        }

        method = method.toUpperCase();

        return tracer.startActiveSpan(`http.${method}`, async (span: ISpan) => {
            span.setAttribute('span.type', 'TOOL');
            span.setAttribute('http.method', method);
            span.setAttribute('http.url', url);

            // Try to parse URL for additional attributes
            try {
                const urlObj = new (globalThis.URL || URL)(url);
                span.setAttribute('http.host', urlObj.host);
                span.setAttribute('http.path', urlObj.pathname);
            } catch {
                // URL parsing failed, skip
            }

            try {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-call
                const response = await _originalFetch(input, init) as FetchResponse;

                span.setAttribute('http.status_code', response.status);
                span.setAttribute('http.duration_ms', Date.now() - startTime);

                // Mark as error if status >= 400
                if (response.status >= 400) {
                    span.status = SpanStatus.ERROR;
                    span.statusDescription = `HTTP ${response.status} ${response.statusText}`;
                }

                return response;
            } catch (error) {
                if (error instanceof Error) {
                    span.recordException(error);
                    span.status = SpanStatus.ERROR;
                    span.statusDescription = error.message;
                }

                span.setAttribute('http.duration_ms', Date.now() - startTime);
                throw error;
            } finally {
                span.end();
            }
        });
    };

    _patched = true;
    return true;
}

/**
 * Unpatch fetch and restore the original function.
 */
export function unpatchFetch(): void {
    if (_originalFetch) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
        (globalThis as any).fetch = _originalFetch;
        _originalFetch = undefined;
        _patched = false;
    }
}

/**
 * Create a traced fetch function.
 *
 * This returns a wrapped fetch function that automatically creates spans.
 * Useful if you don't want to patch the global fetch.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createTracedFetch(): (input: FetchInput, init?: FetchInit) => Promise<any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const originalFetch = (globalThis as any).fetch;

    return async function tracedFetch(
        input: FetchInput,
        init?: FetchInit
    ): Promise<FetchResponse> {
        const tracer = getTracer('fetch');
        const startTime = Date.now();

        // Extract URL and method
        let url: string;
        let method: string;

        if (typeof input === 'string') {
            url = input;
            method = init?.method || 'GET';
        } else if (typeof input === 'object' && 'url' in input) {
            url = input.url;
            method = input.method || init?.method || 'GET';
        } else {
            url = String(input);
            method = init?.method || 'GET';
        }

        method = method.toUpperCase();

        return tracer.startActiveSpan(`http.${method}`, async (span: ISpan) => {
            span.setAttribute('span.type', 'TOOL');
            span.setAttribute('http.method', method);
            span.setAttribute('http.url', url);

            try {
                const urlObj = new (globalThis.URL || URL)(url);
                span.setAttribute('http.host', urlObj.host);
                span.setAttribute('http.path', urlObj.pathname);
            } catch {
                // URL parsing failed, skip
            }

            try {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-call
                const response = await originalFetch(input, init) as FetchResponse;

                span.setAttribute('http.status_code', response.status);
                span.setAttribute('http.duration_ms', Date.now() - startTime);

                if (response.status >= 400) {
                    span.status = SpanStatus.ERROR;
                    span.statusDescription = `HTTP ${response.status} ${response.statusText}`;
                }

                return response;
            } catch (error) {
                if (error instanceof Error) {
                    span.recordException(error);
                    span.status = SpanStatus.ERROR;
                    span.statusDescription = error.message;
                }

                span.setAttribute('http.duration_ms', Date.now() - startTime);
                throw error;
            } finally {
                span.end();
            }
        });
    };
}
