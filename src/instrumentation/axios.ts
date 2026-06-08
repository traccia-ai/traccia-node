/**
 * Axios HTTP client instrumentation.
 *
 * Patches Axios to automatically create spans for HTTP requests.
 */

import { getTracer } from '../auto';
import { SpanStatus, ISpan } from '../types';

let _patched = false;

/**
 * Patch Axios for HTTP request tracing.
 *
 * @returns true if patched successfully, false otherwise
 */
export function patchAxios(): boolean {
    if (_patched) {
        return true;
    }

    try {
        // Dynamic import to avoid hard dependency
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        const axios = require('axios');
        if (!axios) {
            return false;
        }

        const axiosInstance = axios.default || axios;

        // Add request interceptor
        axiosInstance.interceptors.request.use(
            (config: Record<string, unknown>) => {
                // Store start time on config
                config._tracciaStartTime = Date.now();
                return config;
            },
            (error: Error) => Promise.reject(error)
        );

        // Add response interceptor
        axiosInstance.interceptors.response.use(
            (response: Record<string, unknown>) => {
                const config = response.config as Record<string, unknown>;
                const tracer = getTracer('axios');

                const method = String(config.method || 'GET').toUpperCase();
                const url = config.url as string | undefined;
                const status = (response as Record<string, unknown>).status as number | undefined;

                tracer.startActiveSpan(`http.${method}`, (span: ISpan) => {
                    span.setAttribute('span.type', 'TOOL');
                    span.setAttribute('http.method', method);

                    if (url) {
                        span.setAttribute('http.url', url);
                        try {
                            // Use globalThis.URL for cross-platform compatibility
                            const parsed = new (globalThis.URL || URL)(url, config.baseURL as string | undefined);
                            span.setAttribute('http.host', parsed.host);
                            span.setAttribute('http.path', parsed.pathname);
                        } catch {
                            // URL parsing failed, skip
                        }
                    }

                    if (status !== undefined) {
                        span.setAttribute('http.status_code', status);
                    }

                    // Calculate duration if start time was captured
                    const startTime = config._tracciaStartTime as number | undefined;
                    if (startTime) {
                        span.setAttribute('http.duration_ms', Date.now() - startTime);
                    }

                    span.end();
                });

                return response;
            },
            (error: Error & { config?: Record<string, unknown>; response?: Record<string, unknown> }) => {
                const config = error.config || {};
                const tracer = getTracer('axios');

                const method = String(config.method || 'GET').toUpperCase();
                const url = config.url as string | undefined;
                const status = error.response
                    ? ((error.response as Record<string, unknown>).status as number | undefined)
                    : undefined;

                tracer.startActiveSpan(`http.${method}`, (span: ISpan) => {
                    span.setAttribute('span.type', 'TOOL');
                    span.setAttribute('http.method', method);

                    if (url) {
                        span.setAttribute('http.url', url);
                    }

                    if (status !== undefined) {
                        span.setAttribute('http.status_code', status);
                    }

                    span.recordException(error);
                    span.status = SpanStatus.ERROR;
                    span.statusDescription = error.message;

                    span.end();
                });

                return Promise.reject(error);
            }
        );

        _patched = true;
        return true;
    } catch {
        return false;
    }
}

/**
 * Create a traced Axios instance.
 *
 * This creates a new Axios instance with request/response interceptors
 * for automatic tracing.
 */
export function createTracedAxios(): unknown {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        const axios = require('axios');
        const instance = axios.create();

        // Add request interceptor
        instance.interceptors.request.use(
            (config: Record<string, unknown>) => {
                config._tracciaStartTime = Date.now();
                return config;
            },
            (error: Error) => Promise.reject(error)
        );

        // Add response interceptor
        instance.interceptors.response.use(
            (response: Record<string, unknown>) => {
                recordAxiosSpan(response);
                return response;
            },
            (error: Error & { config?: Record<string, unknown>; response?: Record<string, unknown> }) => {
                recordAxiosErrorSpan(error);
                return Promise.reject(error);
            }
        );

        return instance;
    } catch {
        return null;
    }
}

/**
 * Record a span for a successful Axios response.
 */
function recordAxiosSpan(response: Record<string, unknown>): void {
    const config = response.config as Record<string, unknown>;
    const tracer = getTracer('axios');

    const method = String(config.method || 'GET').toUpperCase();
    const url = config.url as string | undefined;
    const status = response.status as number | undefined;

    tracer.startActiveSpan(`http.${method}`, (span: ISpan) => {
        span.setAttribute('span.type', 'TOOL');
        span.setAttribute('http.method', method);

        if (url) {
            span.setAttribute('http.url', url);
        }
        if (status !== undefined) {
            span.setAttribute('http.status_code', status);
        }

        const startTime = config._tracciaStartTime as number | undefined;
        if (startTime) {
            span.setAttribute('http.duration_ms', Date.now() - startTime);
        }

        span.end();
    });
}

/**
 * Record a span for an Axios error.
 */
function recordAxiosErrorSpan(
    error: Error & { config?: Record<string, unknown>; response?: Record<string, unknown> }
): void {
    const config = error.config || {};
    const tracer = getTracer('axios');

    const method = String(config.method || 'GET').toUpperCase();
    const url = config.url as string | undefined;
    const status = error.response
        ? ((error.response as Record<string, unknown>).status as number | undefined)
        : undefined;

    tracer.startActiveSpan(`http.${method}`, (span: ISpan) => {
        span.setAttribute('span.type', 'TOOL');
        span.setAttribute('http.method', method);

        if (url) {
            span.setAttribute('http.url', url);
        }
        if (status !== undefined) {
            span.setAttribute('http.status_code', status);
        }

        span.recordException(error);
        span.status = SpanStatus.ERROR;
        span.statusDescription = error.message;

        span.end();
    });
}
