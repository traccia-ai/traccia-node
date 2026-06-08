/**
 * File exporter for writing spans to a JSONL file.
 */

import * as fs from 'fs';
import { ISpanExporter, ISpan } from '../types';
import { getConfig } from '../config/runtime-config';

export interface FileExporterOptions {
    /** Path to the file where traces will be written (default: "traces.jsonl") */
    filePath?: string;
    /** If true, the file will be cleared on first export (default: false) */
    resetOnStart?: boolean;
}

/**
 * Exporter that writes spans to a JSON file in JSONL format.
 *
 * Each export() call writes one JSON object (containing resource and scopeSpans)
 * per line, following the same format as HttpExporter.
 */
export class FileExporter implements ISpanExporter {
    private filePath: string;
    private resetOnStart: boolean;
    private firstExport: boolean = true;
    private writeLock: Promise<void> = Promise.resolve();

    constructor(options: FileExporterOptions = {}) {
        this.filePath = options.filePath || 'traces.jsonl';
        this.resetOnStart = options.resetOnStart || false;
    }

    /**
     * Export spans to the file in JSONL format.
     */
    async export(spans: ISpan[]): Promise<boolean> {
        if (!spans || spans.length === 0) {
            return true;
        }

        try {
            const payload = this.serialize(spans);
            const jsonStr = JSON.stringify(payload);

            // Ensure sequential writes
            this.writeLock = this.writeLock.then(async () => {
                // Handle reset_on_start: clear file on first export if true
                if (this.resetOnStart && this.firstExport) {
                    await fs.promises.writeFile(this.filePath, jsonStr + '\n', 'utf-8');
                    this.firstExport = false;
                } else {
                    await fs.promises.appendFile(this.filePath, jsonStr + '\n', 'utf-8');
                    if (this.firstExport) {
                        this.firstExport = false;
                    }
                }
            });

            await this.writeLock;
            return true;
        } catch (error) {
            // Silently fail on file write errors to avoid breaking the application
            // eslint-disable-next-line no-console
            console.error('[FileExporter] Failed to write spans:', error);
            return false;
        }
    }

    /**
     * Shutdown the exporter. No cleanup needed for file-based exporter.
     */
    async shutdown(): Promise<void> {
        // Wait for any pending writes to complete
        await this.writeLock;
    }

    /**
     * Serialize spans to the same format as HttpExporter.
     */
    private serialize(spans: ISpan[]): Record<string, unknown> {
        const config = getConfig();
        const truncLimit = config.attrTruncationLimit;

        const truncateStr = (s: string): string => {
            if (!truncLimit || truncLimit <= 0) return s;
            if (s.length <= truncLimit) return s;
            return s.slice(0, Math.max(0, truncLimit - 1)) + '…';
        };

        const sanitize = (value: unknown, depth: number = 0): unknown => {
            if (value === null || value === undefined) return value;
            if (typeof value === 'boolean' || typeof value === 'number') return value;
            if (typeof value === 'string') return truncateStr(value);
            if (depth >= 6) return truncateStr(String(value));

            if (Array.isArray(value)) {
                return value.slice(0, 100).map((v) => sanitize(v, depth + 1));
            }

            if (typeof value === 'object') {
                const out: Record<string, unknown> = {};
                for (const [k, v] of Object.entries(value)) {
                    out[truncateStr(String(k))] = sanitize(v, depth + 1);
                }
                return out;
            }

            return truncateStr(String(value));
        };

        const statusCode = (status: number): number => {
            // OTLP-style: 0=UNSET, 1=OK, 2=ERROR
            if (status === 1) return 1; // OK
            if (status === 2) return 2; // ERROR
            return 0; // UNSET
        };

        const toEvent = (ev: { name?: string; attributes?: Record<string, unknown>; timestampNs?: number }) => ({
            name: ev.name,
            attributes: sanitize(ev.attributes || {}),
            timestamp_ns: ev.timestampNs,
        });

        // Build resource attributes
        const resourceAttrs: Record<string, unknown> = {};

        if (config.sessionId) {
            resourceAttrs['session.id'] = config.sessionId;
        }
        if (config.userId) {
            resourceAttrs['user.id'] = config.userId;
        }
        if (config.tenantId) {
            resourceAttrs['tenant.id'] = config.tenantId;
        }
        if (config.projectId) {
            resourceAttrs['project.id'] = config.projectId;
        }
        if (config.debug) {
            resourceAttrs['trace.debug'] = true;
        }

        return {
            resource: { attributes: sanitize(resourceAttrs) },
            scopeSpans: [
                {
                    scope: { name: 'traccia-sdk', version: '0.1.0' },
                    spans: spans.map((span) => ({
                        traceId: span.context?.traceId,
                        spanId: span.context?.spanId,
                        parentSpanId: span.parentSpanId,
                        name: span.name,
                        startTimeUnixNano: span.startTimeNs,
                        endTimeUnixNano: span.endTimeNs,
                        attributes: sanitize(span.attributes || {}),
                        events: (span.events || []).map(toEvent),
                        status: {
                            code: statusCode(span.status || 0),
                            message: span.statusDescription || '',
                        },
                    })),
                },
            ],
        };
    }
}
