
import { OtlpExporter } from '../exporter/otlp-exporter';
import { ISpan, SpanStatus } from '../types';

jest.mock('@opentelemetry/exporter-trace-otlp-proto', () => {
    return {
        OTLPTraceExporter: jest.fn().mockImplementation(() => ({
            export: jest.fn((spans, callback) => callback({ code: 0 })),
            shutdown: jest.fn().mockResolvedValue(undefined),
        })),
    };
});

describe('OtlpExporter', () => {
    let exporter: OtlpExporter;
    let mockExport: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        exporter = new OtlpExporter({
            endpoint: 'http://localhost:4318/v1/traces',
            apiKey: 'test-key',
            serviceName: 'my-agent',
            resourceAttributes: {
                'agent.id': 'agent-1',
                'tenant.id': 'tenant-1',
            },
        });
        // @ts-ignore
        mockExport = (exporter as any).exporter.export;
    });

    it('should export spans correctly', async () => {
        const mockSpan: ISpan = {
            name: 'test-span',
            context: {
                traceId: 'trace-id',
                spanId: 'span-id',
                traceFlags: 1,
            },
            parentSpanId: 'parent-span-id',
            attributes: {
                'test.attr': 'value',
            },
            events: [],
            status: SpanStatus.OK,
            startTimeNs: 1000,
            endTimeNs: 2000,
            durationNs: 1000,
            isRecording: () => false,
            setAttribute: jest.fn(),
            addEvent: jest.fn(),
            end: jest.fn(),
            recordException: jest.fn(),
        };

        const result = await exporter.export([mockSpan]);

        expect(result).toBe(true);
        expect(mockExport).toHaveBeenCalledTimes(1);

        const exportedSpans = mockExport.mock.calls[0][0];
        expect(exportedSpans.length).toBe(1);
        expect(exportedSpans[0].name).toBe('test-span');
        expect(exportedSpans[0].status.code).toBe(1);
        expect(exportedSpans[0].parentSpanId).toBe('parent-span-id');
        expect(exportedSpans[0].parentSpanContext).toEqual({
            traceId: 'trace-id',
            spanId: 'parent-span-id',
            traceFlags: 1,
        });
    });

    it('includes service.name and resource attrs on exported spans', async () => {
        const mockSpan: ISpan = {
            name: 'child-span',
            context: {
                traceId: 'trace-id',
                spanId: 'child-id',
                traceFlags: 1,
            },
            attributes: {},
            events: [],
            status: SpanStatus.OK,
            startTimeNs: 1000,
            endTimeNs: 2000,
            durationNs: 1000,
            isRecording: () => false,
            setAttribute: jest.fn(),
            addEvent: jest.fn(),
            end: jest.fn(),
            recordException: jest.fn(),
        };

        await exporter.export([mockSpan]);
        const exported = mockExport.mock.calls[0][0][0];
        const resourceAttrs = exported.resource.attributes;
        expect(resourceAttrs['service.name']).toBe('my-agent');
        expect(resourceAttrs['agent.id']).toBe('agent-1');
        expect(resourceAttrs['tenant.id']).toBe('tenant-1');
        expect(resourceAttrs['telemetry.sdk.name']).toBe('traccia-ts');
    });

    it('should handle empty spans', async () => {
        const result = await exporter.export([]);
        expect(result).toBe(true);
        expect(mockExport).not.toHaveBeenCalled();
    });

    it('shuts down the underlying OTLP exporter', async () => {
        await expect(exporter.shutdown()).resolves.toBeUndefined();
    });

    it('resolves false when the underlying export reports a non-success code', async () => {
        (exporter as any).exporter.export = jest.fn((spans: unknown, callback: (r: { code: number }) => void) =>
            callback({ code: 1 }),
        );
        const mockSpan: ISpan = {
            name: 'failing-span',
            context: { traceId: 't', spanId: 's', traceFlags: 1 },
            attributes: {},
            events: [],
            status: SpanStatus.OK,
            startTimeNs: 1000,
            endTimeNs: 2000,
            durationNs: 1000,
            isRecording: () => false,
            setAttribute: jest.fn(),
            addEvent: jest.fn(),
            end: jest.fn(),
            recordException: jest.fn(),
        };

        const result = await exporter.export([mockSpan]);
        expect(result).toBe(false);
    });

    it('works with no constructor options at all', () => {
        expect(() => new OtlpExporter()).not.toThrow();
    });

    it('falls back to resourceAttributes["service.name"] when serviceName option is omitted', () => {
        const fresh = new OtlpExporter({ resourceAttributes: { 'service.name': 'from-resource-attrs' } });
        // @ts-ignore
        const attrs = (fresh as any).resource.attributes;
        expect(attrs['service.name']).toBe('from-resource-attrs');
    });

    it('falls back to resolveServiceName() when neither serviceName nor resourceAttributes["service.name"] is set', () => {
        const fresh = new OtlpExporter({});
        // @ts-ignore
        const attrs = (fresh as any).resource.attributes;
        expect(typeof attrs['service.name']).toBe('string');
        expect(attrs['service.name']).not.toBe('');
    });

    it('defaults parentSpanContext.traceFlags to 1 when context.traceFlags is omitted', async () => {
        const mockSpan: any = {
            name: 'no-trace-flags',
            context: { traceId: 'trace-id', spanId: 'span-id' },
            parentSpanId: 'parent-id',
            attributes: {},
            events: [],
            status: SpanStatus.OK,
            startTimeNs: 1000,
            endTimeNs: 2000,
            durationNs: 1000,
            isRecording: () => false,
            setAttribute: jest.fn(),
            addEvent: jest.fn(),
            end: jest.fn(),
            recordException: jest.fn(),
        };

        await exporter.export([mockSpan]);

        const exported = mockExport.mock.calls[0][0][0];
        expect(exported.parentSpanContext.traceFlags).toBe(1);
    });

    it('maps span status ERROR and UNSET (default) correctly', async () => {
        const errorSpan: ISpan = {
            name: 'error-span',
            context: { traceId: 't', spanId: 's', traceFlags: 1 },
            attributes: {},
            events: [],
            status: SpanStatus.ERROR,
            statusDescription: 'boom',
            startTimeNs: 1000,
            endTimeNs: 2000,
            durationNs: 1000,
            isRecording: () => false,
            setAttribute: jest.fn(),
            addEvent: jest.fn(),
            end: jest.fn(),
            recordException: jest.fn(),
        };
        const unsetSpan: ISpan = {
            ...errorSpan,
            name: 'unset-span',
            status: SpanStatus.UNSET,
            statusDescription: undefined,
        };

        await exporter.export([errorSpan, unsetSpan]);

        const [exportedError, exportedUnset] = mockExport.mock.calls[0][0];
        expect(exportedError.status).toEqual({ code: 2, message: 'boom' });
        expect(exportedUnset.status).toEqual({ code: 0 });
    });

    it('sets endTime/duration to the start time and [0,0] when the span has not ended', async () => {
        const openSpan: any = {
            name: 'open-span',
            context: { traceId: 't', spanId: 's', traceFlags: 1 },
            attributes: {},
            events: [],
            status: SpanStatus.OK,
            startTimeNs: 5_000_000_000,
            endTimeNs: undefined,
            durationNs: 0,
            isRecording: () => true,
            setAttribute: jest.fn(),
            addEvent: jest.fn(),
            end: jest.fn(),
            recordException: jest.fn(),
        };

        await exporter.export([openSpan]);

        const exported = mockExport.mock.calls[0][0][0];
        expect(exported.endTime).toEqual(exported.startTime);
        expect(exported.duration).toEqual([0, 0]);
    });
});
