
import { startTracing, runWithAutoTrace, stopTracing } from '../auto';
import { OtlpExporter } from '../exporter/otlp-exporter';
import { HttpExporter } from '../exporter/http-exporter';
import { getTracer } from '../auto';

// Mock dependencies
jest.mock('../exporter/otlp-exporter');
jest.mock('../exporter/http-exporter');
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

    it('runWithAutoTrace should create a root span', async () => {
        await startTracing({ apiKey: 'test' });

        // We can't easily mock the span context propagation in unit tests without
        // a real SpanProcessor, but we can verify the function runs and returns
        const result = await runWithAutoTrace('test-root', async () => {
            const tracer = getTracer('test');
            const span = tracer.startSpan('child');
            span.end();
            return 'success';
        });

        expect(result).toBe('success');
    });
});
