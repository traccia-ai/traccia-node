import { RateLimiter, RateLimitingSpanProcessor } from '../processor/rate-limiter';
import { ISpan, ISpanProcessor } from '../types';

describe('RateLimiter', () => {
    let mockSpan: ISpan;

    beforeEach(() => {
        mockSpan = {
            name: 'test-span'
        } as unknown as ISpan;
        jest.useFakeTimers();
        jest.spyOn(global, 'setTimeout');
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'info').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    it('should always allow spans when disabled', async () => {
        const limiter = new RateLimiter({});
        const stats1 = limiter.getStats();
        expect(stats1.enabled).toBe(false);

        const allowed1 = await limiter.acquire(mockSpan);
        expect(allowed1).toBe(true);

        const stats2 = limiter.getStats();
        expect(stats2.totalSpans).toBe(0);
        expect(stats2.droppedSpans).toBe(0);
    });

    it('should allow spans up to max tokens', async () => {
        const limiter = new RateLimiter({ maxSpansPerSecond: 2 });
        
        // Should acquire 2 tokens immediately
        expect(await limiter.acquire(mockSpan)).toBe(true);
        expect(await limiter.acquire(mockSpan)).toBe(true);

        // Third span should block, then drop
        const acquirePromise = limiter.acquire(mockSpan);
        
        // Fast-forward past maxBlockMs (100ms default)
        jest.advanceTimersByTime(150);
        
        expect(await acquirePromise).toBe(false);

        const stats = limiter.getStats();
        expect(stats.totalSpans).toBe(3);
        expect(stats.droppedSpans).toBe(1);
    });

    it('should block and wait for tokens', async () => {
        const limiter = new RateLimiter({ maxSpansPerSecond: 10, maxBlockMs: 200 }); // 1 token every 100ms
        
        // Consume all initial tokens (10)
        for (let i = 0; i < 10; i++) {
            await limiter.acquire(mockSpan);
        }

        // 11th span should wait for a token
        const acquirePromise = limiter.acquire(mockSpan);

        // Advance 1ms at a time, just like the while loop in limiter.acquire
        for (let i = 0; i < 100; i++) {
            jest.advanceTimersByTime(1);
            await Promise.resolve(); // let microtasks run
        }

        expect(await acquirePromise).toBe(true);

        const stats = limiter.getStats();
        expect(stats.totalSpans).toBe(11);
        expect(stats.droppedSpans).toBe(0);
        expect(stats.blockedSpans).toBe(1);
    });

    it('should reset stats', async () => {
        const limiter = new RateLimiter({ maxSpansPerSecond: 1 });
        await limiter.acquire(mockSpan);
        
        limiter.resetStats();
        const stats = limiter.getStats();
        expect(stats.totalSpans).toBe(0);
    });
});

describe('RateLimitingSpanProcessor', () => {
    let mockNextProcessor: ISpanProcessor;
    let mockSpan: ISpan;

    beforeEach(() => {
        mockNextProcessor = {
            onStart: jest.fn(),
            onEnd: jest.fn(),
            shutdown: jest.fn(),
            forceFlush: jest.fn()
        };

        mockSpan = {
            name: 'test-span'
        } as unknown as ISpan;

        jest.useFakeTimers();
        jest.spyOn(console, 'info').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    it('should call nextProcessor.onStart', () => {
        const processor = new RateLimitingSpanProcessor({ nextProcessor: mockNextProcessor });
        processor.onStart(mockSpan);
        expect(mockNextProcessor.onStart).toHaveBeenCalledWith(mockSpan);
    });

    it('should call nextProcessor.onStart even if nextProcessor is undefined', () => {
        const processor = new RateLimitingSpanProcessor();
        expect(() => processor.onStart(mockSpan)).not.toThrow();
    });

    it('should pass to next processor if rate limit allowed', async () => {
        const processor = new RateLimitingSpanProcessor({ nextProcessor: mockNextProcessor, maxSpansPerSecond: 1 });
        
        await processor.onEnd(mockSpan);
        expect(mockNextProcessor.onEnd).toHaveBeenCalledWith(mockSpan);
    });

    it('should drop span if rate limit exceeded', async () => {
        const processor = new RateLimitingSpanProcessor({ nextProcessor: mockNextProcessor, maxSpansPerSecond: 1, maxBlockMs: 0 });
        
        await processor.onEnd(mockSpan); // First allowed
        await processor.onEnd(mockSpan); // Second dropped
        
        expect(mockNextProcessor.onEnd).toHaveBeenCalledTimes(1);
    });

    it('should shutdown nextProcessor and log stats', async () => {
        const processor = new RateLimitingSpanProcessor({ nextProcessor: mockNextProcessor, maxSpansPerSecond: 1, maxBlockMs: 0 });
        
        await processor.onEnd(mockSpan); // allowed
        await processor.onEnd(mockSpan); // dropped

        await processor.shutdown();
        
        expect(console.info).toHaveBeenCalledWith(expect.stringContaining('spans dropped'));
        expect(mockNextProcessor.shutdown).toHaveBeenCalled();
    });

    it('should call nextProcessor.forceFlush', async () => {
        const processor = new RateLimitingSpanProcessor({ nextProcessor: mockNextProcessor });
        
        await processor.forceFlush(1000);
        expect(mockNextProcessor.forceFlush).toHaveBeenCalledWith(1000);
    });

    it('should return stats', () => {
        const processor = new RateLimitingSpanProcessor({ maxSpansPerSecond: 5 });
        const stats = processor.getStats();
        expect(stats.enabled).toBe(true);
        expect(stats.maxSpansPerSecond).toBe(5);
    });

    it('handles undefined nextProcessor gracefully on end, shutdown, forceFlush', async () => {
        const processor = new RateLimitingSpanProcessor();
        await expect(processor.onEnd(mockSpan)).resolves.not.toThrow();
        await expect(processor.shutdown()).resolves.not.toThrow();
        await expect(processor.forceFlush()).resolves.not.toThrow();
    });
});
