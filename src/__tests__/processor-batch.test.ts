import { BatchSpanProcessor, DropPolicy } from '../processor/batch-processor';
import { ISpan, ISpanExporter } from '../types';

describe('BatchSpanProcessor', () => {
    let mockExporter: jest.Mocked<ISpanExporter>;
    let mockSpan: ISpan;

    beforeEach(() => {
        mockExporter = {
            export: jest.fn().mockResolvedValue(undefined),
            shutdown: jest.fn().mockResolvedValue(undefined)
        };

        mockSpan = {
            context: { traceFlags: 1 }
        } as unknown as ISpan;
        
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('should enqueue and export spans', async () => {
        const processor = new BatchSpanProcessor({
            exporter: mockExporter,
            maxExportBatchSize: 2,
            scheduleDelayMs: 1000
        });

        processor.onEnd(mockSpan);
        processor.onEnd(mockSpan);
        processor.onEnd(mockSpan); // 3 spans

        jest.advanceTimersByTime(1000);
        
        // Wait for async flush to complete
        await Promise.resolve();
        await Promise.resolve();

        // Should have exported 2 spans (max batch size)
        expect(mockExporter.export).toHaveBeenCalledTimes(1);
        expect(mockExporter.export).toHaveBeenCalledWith([mockSpan, mockSpan]);
        
        // Cleanup
        await processor.shutdown();
    });

    it('should drop oldest spans on overflow', () => {
        const processor = new BatchSpanProcessor({
            maxQueueSize: 2,
            dropPolicy: DropPolicy.DROP_OLDEST
        });

        const span1 = { _id: 1, context: { traceFlags: 1 } } as any;
        const span2 = { _id: 2, context: { traceFlags: 1 } } as any;
        const span3 = { _id: 3, context: { traceFlags: 1 } } as any;

        processor.onEnd(span1);
        processor.onEnd(span2);
        processor.onEnd(span3); // Overflow, drops span1

        // Access private queue for testing
        const queue = (processor as any).queue;
        expect(queue).toEqual([span2, span3]);
        
        processor.shutdown();
    });

    it('should drop newest spans on overflow', () => {
        const processor = new BatchSpanProcessor({
            maxQueueSize: 2,
            dropPolicy: DropPolicy.DROP_NEWEST
        });

        const span1 = { _id: 1, context: { traceFlags: 1 } } as any;
        const span2 = { _id: 2, context: { traceFlags: 1 } } as any;
        const span3 = { _id: 3, context: { traceFlags: 1 } } as any;

        processor.onEnd(span1);
        processor.onEnd(span2);
        processor.onEnd(span3); // Overflow, drops span3

        // Access private queue for testing
        const queue = (processor as any).queue;
        expect(queue).toEqual([span1, span2]);
        
        processor.shutdown();
    });

    it('should skip un-sampled spans if sampler is present', () => {
        const mockSampler = { shouldSample: () => ({ sampled: true }) } as any;
        const processor = new BatchSpanProcessor({ sampler: mockSampler });

        const unsampledSpan = { context: { traceFlags: 0 } } as any;
        processor.onEnd(unsampledSpan);

        const queue = (processor as any).queue;
        expect(queue.length).toBe(0);
        
        processor.shutdown();
    });

    it('should flush and shutdown cleanly', async () => {
        const processor = new BatchSpanProcessor({ exporter: mockExporter });
        
        processor.onEnd(mockSpan);
        await processor.shutdown();
        
        // Once shutdown is called, forceFlush flushes the remaining span
        expect(mockExporter.export).toHaveBeenCalledWith([mockSpan]);
        expect(mockExporter.shutdown).toHaveBeenCalled();
        
        // Cannot add spans after shutdown
        const span2 = { _id: 2, context: { traceFlags: 1 } } as any;
        processor.onEnd(span2);
        
        const queue = (processor as any).queue;
        expect(queue.length).toBe(0); // Should be empty
    });

    it('should gracefully handle export errors', async () => {
        mockExporter.export.mockRejectedValue(new Error('Export failed'));
        const processor = new BatchSpanProcessor({ exporter: mockExporter });

        processor.onEnd(mockSpan);
        
        await expect(processor.forceFlush()).resolves.toBeUndefined();
        
        await processor.shutdown();
    });

    it('does not export if exporter is not set', async () => {
        const processor = new BatchSpanProcessor();
        processor.onEnd(mockSpan);
        await processor.forceFlush();
        // Just succeeds silently
        await processor.shutdown();
    });

    it('drains every queued span even when a real (slow) export is in flight', async () => {
        // Regression test: with maxExportBatchSize 1 and a slow exporter,
        // forceFlush/shutdown must not bail out early just because an
        // export is currently in progress - it must wait for it and keep
        // draining until the queue is truly empty.
        jest.useRealTimers();

        let resolveFirstExport: () => void = () => {};
        const firstExportGate = new Promise<void>((resolve) => {
            resolveFirstExport = resolve;
        });

        const exportedBatches: ISpan[][] = [];
        let callCount = 0;
        const slowExporter: jest.Mocked<ISpanExporter> = {
            export: jest.fn(async (spans: ISpan[]) => {
                callCount += 1;
                if (callCount === 1) {
                    // Hold the first export open until we've enqueued the rest.
                    await firstExportGate;
                }
                exportedBatches.push(spans);
                return true;
            }),
            shutdown: jest.fn().mockResolvedValue(undefined),
        };

        const processor = new BatchSpanProcessor({
            exporter: slowExporter,
            maxExportBatchSize: 1,
            scheduleDelayMs: 20,
        });

        const spans = Array.from({ length: 7 }, (_, i) => ({
            _id: i,
            context: { traceFlags: 1 },
        })) as unknown as ISpan[];

        // First span triggers the background timer's export (kept open by the gate).
        processor.onEnd(spans[0]);
        await new Promise((r) => setTimeout(r, 40));

        // Remaining spans queue up while the first export is still in flight.
        for (let i = 1; i < spans.length; i++) {
            processor.onEnd(spans[i]);
        }

        // Let the first export finish, then force a full flush.
        resolveFirstExport();
        await processor.forceFlush(2000);
        await processor.shutdown();

        const allExported = exportedBatches.flat();
        expect(allExported).toHaveLength(7);
        expect(allExported.map((s: any) => s._id).sort((a, b) => a - b)).toEqual([
            0, 1, 2, 3, 4, 5, 6,
        ]);

        jest.useFakeTimers();
    });

    it('shutdown() alone (no prior explicit forceFlush) drains spans queued during an in-flight export', async () => {
        // Regression test for the exact bug described in the fix: shutdown()
        // used to clear the background timer *before* its final forceFlush(),
        // stranding anything still queued. Here shutdown() is the only call
        // made - it must both wait for the in-flight export and drain what
        // queued up behind it.
        jest.useRealTimers();

        let resolveFirstExport: () => void = () => {};
        const firstExportGate = new Promise<void>((resolve) => {
            resolveFirstExport = resolve;
        });

        const exportedBatches: ISpan[][] = [];
        let callCount = 0;
        const slowExporter: jest.Mocked<ISpanExporter> = {
            export: jest.fn(async (spans: ISpan[]) => {
                callCount += 1;
                if (callCount === 1) {
                    await firstExportGate;
                }
                exportedBatches.push(spans);
                return true;
            }),
            shutdown: jest.fn().mockResolvedValue(undefined),
        };

        const processor = new BatchSpanProcessor({
            exporter: slowExporter,
            maxExportBatchSize: 1,
            scheduleDelayMs: 20,
        });

        const spans = Array.from({ length: 4 }, (_, i) => ({
            _id: i,
            context: { traceFlags: 1 },
        })) as unknown as ISpan[];

        processor.onEnd(spans[0]);
        await new Promise((r) => setTimeout(r, 40)); // background timer grabs span 0, blocks on the gate

        for (let i = 1; i < spans.length; i++) {
            processor.onEnd(spans[i]);
        }

        resolveFirstExport();
        const shutdownPromise = processor.shutdown();
        await shutdownPromise;

        const allExported = exportedBatches.flat();
        expect(allExported).toHaveLength(4);
        expect(allExported.map((s: any) => s._id).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
        expect((processor as any).timer).toBeUndefined();

        jest.useFakeTimers();
    });

    it('serializes overlapping exports so exporter.export is never called concurrently', async () => {
        jest.useRealTimers();

        let concurrent = 0;
        let maxConcurrent = 0;
        const trackingExporter: jest.Mocked<ISpanExporter> = {
            export: jest.fn(async (spans: ISpan[]) => {
                concurrent += 1;
                maxConcurrent = Math.max(maxConcurrent, concurrent);
                await new Promise((r) => setTimeout(r, 10));
                concurrent -= 1;
                return true;
            }),
            shutdown: jest.fn().mockResolvedValue(undefined),
        };

        const processor = new BatchSpanProcessor({
            exporter: trackingExporter,
            maxExportBatchSize: 1,
            scheduleDelayMs: 5000,
        });

        const spans = Array.from({ length: 5 }, (_, i) => ({
            _id: i,
            context: { traceFlags: 1 },
        })) as unknown as ISpan[];
        spans.forEach((s) => processor.onEnd(s));

        // forceFlush drains one batch at a time; nothing here should ever
        // let two export() calls run at the same time.
        await processor.forceFlush(2000);
        await processor.shutdown();

        expect(trackingExporter.export).toHaveBeenCalledTimes(5);
        expect(maxConcurrent).toBe(1);

        jest.useFakeTimers();
    });

    it('forceFlush(timeout) stops draining once the deadline passes, leaving spans queued', async () => {
        jest.useRealTimers();

        const slowExporter: jest.Mocked<ISpanExporter> = {
            export: jest.fn(async (spans: ISpan[]) => {
                await new Promise((r) => setTimeout(r, 50));
                return true;
            }),
            shutdown: jest.fn().mockResolvedValue(undefined),
        };

        const processor = new BatchSpanProcessor({
            exporter: slowExporter,
            maxExportBatchSize: 1,
            scheduleDelayMs: 5000,
        });

        const spans = Array.from({ length: 5 }, (_, i) => ({
            _id: i,
            context: { traceFlags: 1 },
        })) as unknown as ISpan[];
        spans.forEach((s) => processor.onEnd(s));

        // Each export takes ~50ms; a 70ms deadline should allow roughly one
        // batch through before flushOnce's own deadline check bails.
        await processor.forceFlush(70);

        const queue = (processor as any).queue;
        expect(queue.length).toBeGreaterThan(0);
        expect(slowExporter.export.mock.calls.length).toBeLessThan(5);

        await processor.shutdown();
        jest.useFakeTimers();
    });

    it('forceFlush(timeout) exports nothing when the deadline has already passed', async () => {
        jest.useRealTimers();

        const processor = new BatchSpanProcessor({
            exporter: mockExporter,
            maxExportBatchSize: 1,
            scheduleDelayMs: 5000,
        });

        processor.onEnd(mockSpan);

        // A negative timeout produces a deadline already in the past, so the
        // very first flushOnce() call must bail before exporting anything.
        await processor.forceFlush(-1);

        expect(mockExporter.export).not.toHaveBeenCalled();
        const queue = (processor as any).queue;
        expect(queue.length).toBe(1);

        await processor.shutdown();
        jest.useFakeTimers();
    });
});
