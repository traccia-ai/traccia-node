
import { OtlpExporter } from '../exporter/otlp-exporter';
import { ISpan, SpanStatus } from '../types';
// import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';

// Mock OTel exporter
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
        expect(exportedSpans[0].status.code).toBe(1); // OK
    });

    it('should handle empty spans', async () => {
        const result = await exporter.export([]);
        expect(result).toBe(true);
        expect(mockExport).not.toHaveBeenCalled();
    });
});
