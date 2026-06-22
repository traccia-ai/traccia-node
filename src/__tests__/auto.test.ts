import { startTracing, runWithAutoTrace, stopTracing, initSDK, getTracer } from '../auto';
import { OtlpExporter } from '../exporter/otlp-exporter';
import { HttpExporter } from '../exporter/http-exporter';
import { ConsoleExporter } from '../exporter/console-exporter';
import { FileExporter } from '../exporter/file-exporter';
import { ISpanExporter } from '../types';

// Mock dependencies
jest.mock('../exporter/otlp-exporter');
jest.mock('../exporter/http-exporter');
jest.mock('../exporter/console-exporter', () => {
    return {
        ConsoleExporter: jest.fn().mockImplementation(() => {
            return {
                export: jest.fn().mockResolvedValue(true),
                shutdown: jest.fn().mockResolvedValue(undefined)
            };
        })
    };
});
jest.mock('../exporter/file-exporter');

jest.mock('../config/config', () => ({
    loadConfig: jest.fn().mockReturnValue({
        tracing: { use_otlp: true },
        exporters: { enable_console: false },
        instrumentation: {},
        rate_limiting: {},
        logging: {},
        advanced: {},
    }),
    ENV_VAR_MAPPING: {},
}));

describe('Auto Instrumentation', () => {
    beforeEach(async () => {
        await stopTracing();
        jest.clearAllMocks();
    });

    it('should use OtlpExporter by default', async () => {
        await startTracing({ apiKey: 'test' });
        expect(OtlpExporter).toHaveBeenCalled();
        expect(HttpExporter).not.toHaveBeenCalled();
    });

    it('should use HttpExporter when useOtlp is false', async () => {
        await startTracing({ apiKey: 'test', useOtlp: false });
        expect(OtlpExporter).not.toHaveBeenCalled();
        expect(HttpExporter).toHaveBeenCalled();
    });

    it('should use custom exporter if provided', async () => {
        const customExporter: ISpanExporter = {
            export: jest.fn().mockResolvedValue(true),
            shutdown: jest.fn().mockResolvedValue(undefined)
        };
        await startTracing({ exporter: customExporter });
        expect(OtlpExporter).not.toHaveBeenCalled();
        expect(HttpExporter).not.toHaveBeenCalled();
    });

    it('should initialize ConsoleExporter if requested', async () => {
        await startTracing({ enableConsoleExporter: true });
        expect(ConsoleExporter).toHaveBeenCalled();
    });

    it('should initialize FileExporter if requested', async () => {
        await startTracing({ enableFileExporter: true });
        expect(FileExporter).toHaveBeenCalled();
    });

    it('initSDK alias works', async () => {
        const provider = await startTracing();
        expect(initSDK()).toBe(provider);
    });

    it('CompositeExporter delegates shutdown', async () => {
        await startTracing({ enableConsoleExporter: true });
        // The mock was instantiated
        const MockConsoleExporter = require('../exporter/console-exporter').ConsoleExporter;
        const mockInstance = MockConsoleExporter.mock.results[0].value;
        
        await stopTracing();
        expect(mockInstance.shutdown).toHaveBeenCalled();
    });

    it('runWithAutoTrace should create a root span', async () => {
        await startTracing({ apiKey: 'test' });

        const result = await runWithAutoTrace('test-root', async () => {
            const tracer = getTracer('test');
            const span = tracer.startSpan('child');
            span.end();
            return 'success';
        });

        expect(result).toBe('success');
    });

    it('does not re-initialize on second startTracing', async () => {
        const p1 = await startTracing();
        const p2 = await startTracing();
        expect(p1).toBe(p2);
    });

    it('can be safely stopped without initialization', async () => {
        await stopTracing(); // Should not throw
    });
});
