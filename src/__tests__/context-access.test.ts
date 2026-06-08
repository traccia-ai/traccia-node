
import { startTracing, stopTracing } from '../auto';
import { observe } from '../instrumentation/decorator';
import { getCurrentSpan } from '../context/context';

describe('Current Span Access', () => {
    beforeAll(async () => {
        // Mock exporter to avoid network delays/errors
        const mockExporter = {
            export: (spans: any) => Promise.resolve(true),
            shutdown: () => Promise.resolve(),
        };
        await startTracing({
            useOtlp: false,
            enableConsoleExporter: false,
            exporter: mockExporter
        });
    });

    afterAll(async () => {
        await stopTracing();
    });

    it('should provide access to the current span within an observed function', async () => {
        let spanIdInFunc: string | undefined;

        const tracedFunc = observe({ name: 'test-span-access' })(async () => {
            const span = getCurrentSpan();
            expect(span).toBeDefined();
            if (span) {
                // Set an attribute to verify we have the right span
                span.setAttribute('test.visited', true);
                spanIdInFunc = span.context.spanId;
            }
            return 'done';
        });

        await tracedFunc();
        expect(spanIdInFunc).toBeDefined();
    });

    it('should provide access to current span in class method', async () => {
        let contextVerified = false;

        class TestService {
            @observe({ name: 'method-span' })
            async doWork() {
                const span = getCurrentSpan();
                if (span) {
                    span.setAttribute('method.visited', true);
                    contextVerified = true;
                }
            }
        }

        const service = new TestService();
        await service.doWork();
        expect(contextVerified).toBe(true);
    });
});
