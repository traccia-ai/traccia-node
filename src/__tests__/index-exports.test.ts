import * as processorIndex from '../processor/index';
import * as metricsIndex from '../metrics/index';
import * as redactionIndex from '../redaction/index';
import * as tracerIndex from '../tracer/index';
import * as integrationsIndex from '../integrations/index';
import * as instrumentationIndex from '../instrumentation/index';
import * as mainIndex from '../index';

describe('Index Exports', () => {
    it('should export all expected members in processor/index.ts', () => {
        expect(Object.keys(processorIndex).length).toBeGreaterThan(0);
        for (const key of Object.keys(processorIndex)) {
            expect((processorIndex as any)[key]).toBeDefined();
        }
    });

    it('should export all expected members in metrics/index.ts', () => {
        expect(Object.keys(metricsIndex).length).toBeGreaterThan(0);
        for (const key of Object.keys(metricsIndex)) {
            expect((metricsIndex as any)[key]).toBeDefined();
        }
    });

    it('should export all expected members in redaction/index.ts', () => {
        expect(Object.keys(redactionIndex).length).toBeGreaterThan(0);
        for (const key of Object.keys(redactionIndex)) {
            expect((redactionIndex as any)[key]).toBeDefined();
        }
    });

    it('should export all expected members in tracer/index.ts', () => {
        expect(Object.keys(tracerIndex).length).toBeGreaterThan(0);
        for (const key of Object.keys(tracerIndex)) {
            expect((tracerIndex as any)[key]).toBeDefined();
        }
    });

    it('should export all expected members in integrations/index.ts', () => {
        expect(Object.keys(integrationsIndex).length).toBeGreaterThan(0);
        for (const key of Object.keys(integrationsIndex)) {
            expect((integrationsIndex as any)[key]).toBeDefined();
        }
    });

    it('should export all expected members in instrumentation/index.ts', () => {
        expect(Object.keys(instrumentationIndex).length).toBeGreaterThan(0);
        for (const key of Object.keys(instrumentationIndex)) {
            expect((instrumentationIndex as any)[key]).toBeDefined();
        }
    });

    it('should export all expected members in main index.ts', () => {
        expect(Object.keys(mainIndex).length).toBeGreaterThan(0);
        for (const key of Object.keys(mainIndex)) {
            expect((mainIndex as any)[key]).toBeDefined();
        }
    });
});
