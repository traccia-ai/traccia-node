/**
 * Axios HTTP client instrumentation.
 *
 * Patches Axios to automatically create spans for HTTP requests.
 */

import { getTracer } from '../auto';
import { SpanStatus, ISpan } from '../types';

let _patched = false;

function shouldSkipHttp(url: string): boolean {
    return [
        '/v1/traces',
        '/v2/traces',
        '/api/v1/traces',
        '/api/v2/traces',
        '/v1/metrics',
        '/v2/metrics',
        '/api/v1/metrics',
        '/api/v2/metrics',
        '/api/v1/eval-runtime/',
        '/api/v1/prompt-runtime/',
    ].some((path) => url.includes(path));
}

function joinUrl(base: string, path: string): string {
    if (!base) return path;
    if (!path) return base;
    try {
        return new (globalThis.URL || URL)(path, base).toString();
    } catch {
        return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
    }
}

/**
 * Patch Axios for HTTP request tracing.
 *
 * Wraps Axios.prototype.request so axios.create() (used by loadPrompt) is
 * traced as http.client. Falls back to default-instance interceptors.
 */
export function patchAxios(): boolean {
    if (_patched) {
        return true;
    }

    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        const axiosMod = require('axios');
        const axiosLib = axiosMod?.default || axiosMod;
        const AxiosClass = axiosLib?.Axios || axiosMod?.Axios;
        const proto = AxiosClass?.prototype;

        if (proto && typeof proto.request === 'function') {
            const originalRequest = proto.request as (...args: unknown[]) => Promise<unknown>;
            proto.request = function tracedAxiosRequest(
                this: { defaults?: { baseURL?: string } },
                configOrUrl?: Record<string, unknown> | string,
                maybeConfig?: Record<string, unknown>
            ): Promise<unknown> {
                const cfg = ((typeof configOrUrl === 'string' ? maybeConfig : configOrUrl) || {}) as {
                    method?: string;
                    url?: string;
                    baseURL?: string;
                };
                const path = typeof configOrUrl === 'string' ? configOrUrl : (cfg.url || '');
                const url = joinUrl(cfg.baseURL || this?.defaults?.baseURL || '', path);
                if (shouldSkipHttp(url)) {
                    return maybeConfig !== undefined
                        ? originalRequest.call(this, configOrUrl, maybeConfig)
                        : originalRequest.call(this, configOrUrl);
                }
                const method = String(cfg.method || (typeof configOrUrl === 'string' ? 'GET' : 'GET')).toUpperCase();
                const tracer = getTracer('axios');
                return Promise.resolve(
                    tracer.startActiveSpan('http.client', async (span: ISpan) => {
                        span.setAttribute('http.method', method);
                        span.setAttribute('http.url', url);
                        try {
                            const parsed = new (globalThis.URL || URL)(url);
                            span.setAttribute('http.host', parsed.host);
                            span.setAttribute('http.path', parsed.pathname);
                        } catch {
                            /* relative url */
                        }
                        try {
                            const response = (await (maybeConfig !== undefined
                                ? originalRequest.call(this, configOrUrl, maybeConfig)
                                : originalRequest.call(this, configOrUrl))) as { status?: number };
                            if (response?.status !== undefined) {
                                span.setAttribute('http.status_code', response.status);
                            }
                            return response;
                        } catch (error) {
                            const err = error as { response?: { status?: number }; message?: string };
                            if (err?.response?.status !== undefined) {
                                span.setAttribute('http.status_code', err.response.status);
                            }
                            if (error instanceof Error) {
                                span.recordException(error);
                                span.status = SpanStatus.ERROR;
                                span.statusDescription = error.message;
                            }
                            throw error;
                        }
                    })
                );
            };
            _patched = true;
            return true;
        }

        if (!axiosLib?.interceptors?.request || !axiosLib?.interceptors?.response) {
            return false;
        }

        const axiosInstance = axiosLib;

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

                // Skip Traccia platform bookkeeping / OTLP (same policy as Python requests patch)
                const urlStr = String(url || '');
                if (
                    urlStr.includes('/api/v1/eval-runtime/') ||
                    urlStr.includes('/v2/traces') ||
                    urlStr.includes('/v1/traces') ||
                    urlStr.includes('/v2/metrics') ||
                    urlStr.includes('/v1/metrics')
                ) {
                    return response;
                }

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
        const axiosInstance = axios.default || axios;
        const instance = axiosInstance.create();

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
    } catch (err) {
        console.error("Axios patch error", err);
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
