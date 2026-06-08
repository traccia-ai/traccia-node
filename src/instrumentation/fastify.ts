/**
 * Fastify plugin for HTTP request tracing.
 *
 * Provides a Fastify plugin to automatically create spans for routes.
 */

import { getTracer } from '../auto';
import { SpanStatus, ISpan } from '../types';

/**
 * Fastify-compatible request object.
 */
interface FastifyRequest {
    method: string;
    url: string;
    routerPath?: string;
    headers?: Record<string, string | string[] | undefined>;
    params?: Record<string, unknown>;
    query?: Record<string, unknown>;
    ip?: string;
}

/**
 * Fastify-compatible reply object.
 */
interface FastifyReply {
    statusCode?: number;
}

/**
 * Fastify-compatible instance.
 */
interface FastifyInstance {
    addHook(
        hookName: 'onRequest',
        handler: (
            request: FastifyRequest & { _tracciaSpan?: ISpan; _tracciaStartTime?: number },
            reply: FastifyReply,
            done: (error?: Error) => void
        ) => void
    ): void;
    addHook(
        hookName: 'onResponse',
        handler: (
            request: FastifyRequest & { _tracciaSpan?: ISpan; _tracciaStartTime?: number },
            reply: FastifyReply,
            done: (error?: Error) => void
        ) => void
    ): void;
    addHook(
        hookName: 'onError',
        handler: (
            request: FastifyRequest & { _tracciaSpan?: ISpan; _tracciaStartTime?: number },
            reply: FastifyReply,
            error: Error,
            done: (error?: Error) => void
        ) => void
    ): void;
}

/**
 * Plugin options.
 */
export interface FastifyTracingOptions {
    /** Skip tracing for certain paths */
    ignorePaths?: (string | RegExp)[];
    /** Include request headers in span attributes */
    includeHeaders?: boolean;
    /** Include query parameters in span attributes */
    includeQuery?: boolean;
    /** Custom span name function */
    spanName?: (req: FastifyRequest) => string;
}

/**
 * Check if a path should be ignored.
 */
function shouldIgnore(path: string, ignorePaths?: (string | RegExp)[]): boolean {
    if (!ignorePaths || ignorePaths.length === 0) {
        return false;
    }

    for (const pattern of ignorePaths) {
        if (typeof pattern === 'string') {
            if (path === pattern || path.startsWith(pattern)) {
                return true;
            }
        } else if (pattern instanceof RegExp) {
            if (pattern.test(path)) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Create Fastify tracing plugin.
 *
 * @example
 * ```typescript
 * import fastify from 'fastify';
 * import { fastifyPlugin } from '@traccia/sdk';
 *
 * const app = fastify();
 * app.register(fastifyPlugin());
 * ```
 */
export function fastifyPlugin(options: FastifyTracingOptions = {}) {
    const { ignorePaths, includeHeaders, includeQuery, spanName } = options;

    return function tracciaPlugin(
        fastify: FastifyInstance,
        _opts: unknown,
        done: (error?: Error) => void
    ): void {
        // Hook: onRequest - create span
        fastify.addHook('onRequest', (request, _reply, hookDone) => {
            const path = request.url.split('?')[0];

            // Check if path should be ignored
            if (shouldIgnore(path, ignorePaths)) {
                return hookDone();
            }

            const tracer = getTracer('fastify');
            const startTime = Date.now();

            // Determine span name
            const name =
                spanName?.(request) ||
                `${request.method} ${request.routerPath || path}`;

            const span = tracer.startSpan(name);

            // Set basic attributes
            span.setAttribute('span.type', 'TOOL');
            span.setAttribute('http.method', request.method);
            span.setAttribute('http.url', request.url);
            span.setAttribute('http.path', path);

            if (request.routerPath) {
                span.setAttribute('http.route', request.routerPath);
            }

            if (request.ip) {
                span.setAttribute('http.client_ip', request.ip);
            }

            // Include headers if requested
            if (includeHeaders && request.headers) {
                for (const [key, value] of Object.entries(request.headers)) {
                    if (typeof value === 'string') {
                        span.setAttribute(`http.request.header.${key.toLowerCase()}`, value);
                    }
                }
            }

            // Include query params if requested
            if (includeQuery && request.query) {
                span.setAttribute('http.query', JSON.stringify(request.query).slice(0, 500));
            }

            // Include route params
            if (request.params && Object.keys(request.params).length > 0) {
                span.setAttribute('http.params', JSON.stringify(request.params));
            }

            // Store span on request
            (request as FastifyRequest & { _tracciaSpan?: ISpan; _tracciaStartTime?: number })._tracciaSpan = span;
            (request as FastifyRequest & { _tracciaStartTime?: number })._tracciaStartTime = startTime;

            hookDone();
        });

        // Hook: onResponse - end span
        fastify.addHook('onResponse', (request, reply, hookDone) => {
            const span = (request as FastifyRequest & { _tracciaSpan?: ISpan })._tracciaSpan;
            const startTime = (request as FastifyRequest & { _tracciaStartTime?: number })._tracciaStartTime;

            if (span) {
                span.setAttribute('http.status_code', reply.statusCode || 0);

                if (startTime) {
                    span.setAttribute('http.duration_ms', Date.now() - startTime);
                }

                if ((reply.statusCode || 0) >= 400) {
                    span.status = SpanStatus.ERROR;
                    span.statusDescription = `HTTP ${reply.statusCode}`;
                }

                span.end();
            }

            hookDone();
        });

        // Hook: onError - record exception
        fastify.addHook('onError', (request, _reply, error, hookDone) => {
            const span = (request as FastifyRequest & { _tracciaSpan?: ISpan })._tracciaSpan;

            if (span) {
                span.recordException(error);
                span.status = SpanStatus.ERROR;
                span.statusDescription = error.message;
            }

            hookDone();
        });

        done();
    };
}

/**
 * Async version of Fastify plugin.
 */
export async function fastifyPluginAsync(
    fastify: FastifyInstance,
    options: FastifyTracingOptions = {}
): Promise<void> {
    const plugin = fastifyPlugin(options);

    return new Promise((resolve, reject) => {
        plugin(fastify, options, (error?: Error) => {
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
}
