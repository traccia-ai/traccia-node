/**
 * Express middleware for HTTP request tracing.
 *
 * Provides middleware to automatically create spans for Express routes.
 */

import { getTracer } from '../auto';
import { SpanStatus, ISpan } from '../types';

/**
 * Express-compatible request object.
 */
interface ExpressRequest {
    method: string;
    url: string;
    path?: string;
    originalUrl?: string;
    route?: { path?: string };
    headers?: Record<string, string | string[] | undefined>;
    params?: Record<string, string>;
    query?: Record<string, unknown>;
    ip?: string;
    _tracciaSpan?: ISpan;
    _tracciaStartTime?: number;
}

/**
 * Express-compatible response object.
 */
interface ExpressResponse {
    statusCode?: number;
    on(event: string, callback: () => void): void;
}

/**
 * Express-compatible next function.
 */
type ExpressNext = (error?: unknown) => void;

/**
 * Middleware options.
 */
export interface TracingMiddlewareOptions {
    /** Skip tracing for certain paths (glob patterns or regex) */
    ignorePaths?: (string | RegExp)[];
    /** Include request headers in span attributes */
    includeHeaders?: boolean;
    /** Include query parameters in span attributes */
    includeQuery?: boolean;
    /** Custom span name function */
    spanName?: (req: ExpressRequest) => string;
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
 * Create Express tracing middleware.
 *
 * @example
 * ```typescript
 * import express from 'express';
 * import { expressMiddleware } from '@traccia/sdk';
 *
 * const app = express();
 * app.use(expressMiddleware());
 * ```
 */
export function expressMiddleware(
    options: TracingMiddlewareOptions = {}
): (req: ExpressRequest, res: ExpressResponse, next: ExpressNext) => void {
    const { ignorePaths, includeHeaders, includeQuery, spanName } = options;

    return function tracciaMiddleware(
        req: ExpressRequest,
        res: ExpressResponse,
        next: ExpressNext
    ): void {
        const path = req.path || req.url || '/';

        // Check if path should be ignored
        if (shouldIgnore(path, ignorePaths)) {
            return next();
        }

        const tracer = getTracer('express');
        const startTime = Date.now();

        // Determine span name
        const name =
            spanName?.(req) ||
            `${req.method} ${req.route?.path || path}`;

        const span = tracer.startSpan(name);

        // Set basic attributes
        span.setAttribute('span.type', 'TOOL');
        span.setAttribute('http.method', req.method);
        span.setAttribute('http.url', req.originalUrl || req.url);
        span.setAttribute('http.path', path);

        if (req.route?.path) {
            span.setAttribute('http.route', req.route.path);
        }

        if (req.ip) {
            span.setAttribute('http.client_ip', req.ip);
        }

        // Include headers if requested
        if (includeHeaders && req.headers) {
            const headerAttrs: Record<string, string> = {};
            for (const [key, value] of Object.entries(req.headers)) {
                if (typeof value === 'string') {
                    headerAttrs[`http.request.header.${key.toLowerCase()}`] = value;
                }
            }
            for (const [key, value] of Object.entries(headerAttrs)) {
                span.setAttribute(key, value);
            }
        }

        // Include query params if requested
        if (includeQuery && req.query) {
            span.setAttribute('http.query', JSON.stringify(req.query).slice(0, 500));
        }

        // Include route params
        if (req.params && Object.keys(req.params).length > 0) {
            span.setAttribute('http.params', JSON.stringify(req.params));
        }

        // Store span on request for access in handlers
        req._tracciaSpan = span;
        req._tracciaStartTime = startTime;

        // Handle response finish
        res.on('finish', () => {
            span.setAttribute('http.status_code', res.statusCode || 0);
            span.setAttribute('http.duration_ms', Date.now() - startTime);

            if ((res.statusCode || 0) >= 400) {
                span.status = SpanStatus.ERROR;
                span.statusDescription = `HTTP ${res.statusCode}`;
            }

            span.end();
        });

        // Handle response close (client disconnected)
        res.on('close', () => {
            if (!span.endTimeNs) {
                span.setAttribute('http.status_code', res.statusCode || 0);
                span.setAttribute('http.duration_ms', Date.now() - startTime);
                span.setAttribute('http.client_closed', true);
                span.end();
            }
        });

        next();
    };
}

/**
 * Error handling middleware for Express.
 *
 * Should be added after other middleware to catch errors.
 */
export function expressErrorMiddleware(): (
    error: Error,
    req: ExpressRequest,
    res: ExpressResponse,
    next: ExpressNext
) => void {
    return function tracciaErrorMiddleware(
        error: Error,
        req: ExpressRequest,
        _res: ExpressResponse,
        next: ExpressNext
    ): void {
        const span = req._tracciaSpan;

        if (span) {
            span.recordException(error);
            span.status = SpanStatus.ERROR;
            span.statusDescription = error.message;
        }

        next(error);
    };
}
