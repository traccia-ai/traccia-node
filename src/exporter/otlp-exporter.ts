import { ReadableSpan, TimedEvent } from '@opentelemetry/sdk-trace-base';
import type { Resource as ResourceType } from '@opentelemetry/resources';
const { resourceFromAttributes } = require('@opentelemetry/resources');
const OTLPModule = require('@opentelemetry/exporter-trace-otlp-proto');
const OTLPTraceExporter = OTLPModule.OTLPTraceExporter || OTLPModule.default?.OTLPTraceExporter || OTLPModule.default;

// Inline types to bypass build issue with @opentelemetry/api
enum SpanStatusCode {
    UNSET = 0,
    OK = 1,
    ERROR = 2,
}
enum SpanKind {
    INTERNAL = 0,
    SERVER = 1,
    CLIENT = 2,
    PRODUCER = 3,
    CONSUMER = 4,
}
// Unused types commented out to avoid linter warnings
// type Link = any;
// type TraceFlags = number;
// interface SpanContext { ... } 

import { InstrumentationScope } from '@opentelemetry/core';
import { ISpan, ISpanExporter, SpanStatus } from '../types';
import { resolveServiceName } from '../config/service-name';

// Hardcoded version to avoid JSON import issues
import { version as tracciaVersion } from "../../package.json";
//const tracciaVersion = '0.0.16';

type HrTime = [number, number];

export interface OtlpExporterOptions {
    endpoint?: string;
    apiKey?: string;
    timeout?: number;
    headers?: Record<string, string>;
    /** OTLP resource service.name (defaults to TRACCIA_SERVICE_NAME / OTEL_SERVICE_NAME env) */
    serviceName?: string;
    /** Additional OTLP resource attributes (tenant.id, agent.id, etc.) */
    resourceAttributes?: Record<string, unknown>;
}

export class OtlpExporter implements ISpanExporter {
    private exporter: any; // OTLPTraceExporter
    private resource: ResourceType;
    private instrumentationScope: InstrumentationScope;

    constructor(options: OtlpExporterOptions = {}) {
        const headers = { ...(options.headers || {}) };
        if (options.apiKey) {
            headers['Authorization'] = `Bearer ${options.apiKey}`;
        }

        this.exporter = new OTLPTraceExporter({
            url: options.endpoint,
            headers: headers,
            timeoutMillis: options.timeout, // defaults to 10s in OTel
        });

        this.resource = resourceFromAttributes({
            ...(options.resourceAttributes || {}),
            'service.name':
                options.serviceName ||
                (options.resourceAttributes?.['service.name'] as string | undefined) ||
                resolveServiceName(),
            'telemetry.sdk.name': 'traccia-ts',
            'telemetry.sdk.language': 'nodejs',
            'telemetry.sdk.version': tracciaVersion,
        });

        this.instrumentationScope = {
            name: 'traccia-ts',
            version: tracciaVersion,
        };
    }

    async export(spans: ISpan[]): Promise<boolean> {
        if (spans.length === 0) {
            return true;
        }

        const readableSpans: ReadableSpan[] = spans.map((span) => this.toReadableSpan(span));

        return new Promise((resolve) => {
            this.exporter.export(readableSpans, (result) => {
                resolve(result.code === 0); // ExportResultCode.SUCCESS = 0
            });
        });
    }

    async shutdown(): Promise<void> {
        await this.exporter.shutdown();
    }

    private toReadableSpan(span: ISpan): ReadableSpan {
        const startTime: HrTime = this.nsToHrTime(span.startTimeNs);
        const endTime: HrTime = span.endTimeNs ? this.nsToHrTime(span.endTimeNs) : startTime;
        const duration: HrTime = span.endTimeNs
            ? this.nsToHrTime(span.endTimeNs - span.startTimeNs)
            : [0, 0];

        // Map status
        let status: { code: SpanStatusCode; message?: string };
        switch (span.status) {
            case SpanStatus.OK:
                status = { code: SpanStatusCode.OK };
                break;
            case SpanStatus.ERROR:
                status = {
                    code: SpanStatusCode.ERROR,
                    message: span.statusDescription
                };
                break;
            default:
                status = { code: SpanStatusCode.UNSET };
        }

        // Map events
        const events: TimedEvent[] = span.events.map(e => ({
            name: e.name,
            time: this.nsToHrTime(e.timestamp), // e.timestamp is number (ns)
            attributes: e.attributes as any,
        }));

        const parentSpanContext = span.parentSpanId
            ? {
                traceId: span.context.traceId,
                spanId: span.parentSpanId,
                traceFlags: span.context.traceFlags ?? 1,
            }
            : undefined;

        return {
            name: span.name,
            kind: SpanKind.INTERNAL, // Traccia doesn't support SpanKind yet, default to INTERNAL
            spanContext: () => ({
                traceId: span.context.traceId,
                spanId: span.context.spanId,
                traceFlags: span.context.traceFlags,
                isRemote: false, // assuming local
            }),
            parentSpanId: span.parentSpanId,
            parentSpanContext,
            startTime,
            endTime,
            status,
            attributes: span.attributes as any,
            links: [], // Traccia doesn't support links yet
            events,
            duration,
            ended: true, // we assume only ended spans are exported
            resource: this.resource,
            instrumentationLibrary: this.instrumentationScope, // Backwards compatibility for some versions
            // @ts-ignore
            instrumentationScope: this.instrumentationScope,
            droppedAttributesCount: 0,
            droppedEventsCount: 0,
            droppedLinksCount: 0,
        } as unknown as ReadableSpan; // Force cast to avoid minor version mismatch issues
    }

    private nsToHrTime(ns: number): HrTime {
        const seconds = Math.floor(ns / 1e9);
        const nanos = Math.floor(ns % 1e9);
        return [seconds, nanos];
    }
}
