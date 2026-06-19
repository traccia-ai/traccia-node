
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
});
