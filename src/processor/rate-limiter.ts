/**
 * Rate limiting processor for span export.
 */

import { ISpanProcessor, ISpan } from '../types';

export interface RateLimiterOptions {
    /** Maximum spans per second (undefined = unlimited) */
    maxSpansPerSecond?: number;
    /** Maximum milliseconds to block before dropping */
    maxBlockMs?: number;
}

export interface RateLimiterStats {
    enabled: boolean;
    maxSpansPerSecond?: number;
    totalSpans: number;
    droppedSpans: number;
    blockedSpans: number;
    dropRatePercent: number;
    currentTokens: number;
}

/**
 * Token bucket rate limiter with hybrid blocking/dropping behavior.
 *
 * Features:
 * - Token bucket algorithm for smooth rate limiting
 * - Short blocking period before dropping spans
 * - Detailed logging of dropped spans
 */
export class RateLimiter {
    private maxSpansPerSecond?: number;
    private maxBlockMs: number;
    private enabled: boolean;

    // Token bucket state
    private tokens: number;
    private maxTokens: number;
    private lastRefillTime: number;

    // Stats
    private totalSpans: number = 0;
    private droppedSpans: number = 0;
    private blockedSpans: number = 0;

    constructor(options: RateLimiterOptions = {}) {
        this.maxSpansPerSecond = options.maxSpansPerSecond;
        this.maxBlockMs = options.maxBlockMs ?? 100;
        this.enabled = this.maxSpansPerSecond !== undefined && this.maxSpansPerSecond > 0;

        this.tokens = this.maxSpansPerSecond || 0;
        this.maxTokens = this.maxSpansPerSecond || 0;
        this.lastRefillTime = Date.now();
    }

    /**
     * Sleep for a given number of milliseconds.
     */
    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => {
            globalThis.setTimeout(resolve, ms);
        });
    }

    /**
     * Try to acquire permission to process a span.
     *
     * Returns true if span should be processed, false if it should be dropped.
     *
     * Behavior:
     * 1. If unlimited (disabled), always return true
     * 2. Try to acquire a token immediately
     * 3. If no token, block for up to maxBlockMs
     * 4. If still no token after blocking, drop and return false
     */
    async acquire(span?: ISpan): Promise<boolean> {
        if (!this.enabled) {
            return true;
        }

        this.totalSpans++;
        this.refillTokens();

        // Try to acquire immediately
        if (this.tokens >= 1.0) {
            this.tokens -= 1.0;
            return true;
        }

        // No tokens available, try blocking
        if (this.maxBlockMs > 0) {
            const blockStart = Date.now();
            let blockedMs = 0;

            while (blockedMs < this.maxBlockMs) {
                // Sleep 1ms
                await this.sleep(1);

                // Refill and try again
                this.refillTokens();
                if (this.tokens >= 1.0) {
                    this.tokens -= 1.0;
                    this.blockedSpans++;
                    return true;
                }

                blockedMs = Date.now() - blockStart;
            }
        }

        // Still no tokens after blocking - drop the span
        this.droppedSpans++;

        const spanName = span?.name || 'unknown';
        const dropPercent = ((this.droppedSpans / this.totalSpans) * 100).toFixed(1);
        // eslint-disable-next-line no-console
        console.warn(
            `[RateLimiter] Rate limit exceeded - dropping span '${spanName}'. ` +
            `Total dropped: ${this.droppedSpans}/${this.totalSpans} (${dropPercent}%)`
        );

        return false;
    }

    /**
     * Refill tokens based on elapsed time (token bucket algorithm).
     */
    private refillTokens(): void {
        const now = Date.now();
        const elapsedMs = now - this.lastRefillTime;

        if (elapsedMs > 0 && this.maxSpansPerSecond) {
            // Add tokens based on rate and elapsed time
            const newTokens = (elapsedMs / 1000) * this.maxSpansPerSecond;
            this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
            this.lastRefillTime = now;
        }
    }

    /**
     * Get rate limiting statistics.
     */
    getStats(): RateLimiterStats {
        const dropRate = this.totalSpans > 0 ? (this.droppedSpans / this.totalSpans) * 100 : 0;

        return {
            enabled: this.enabled,
            maxSpansPerSecond: this.maxSpansPerSecond,
            totalSpans: this.totalSpans,
            droppedSpans: this.droppedSpans,
            blockedSpans: this.blockedSpans,
            dropRatePercent: Math.round(dropRate * 100) / 100,
            currentTokens: Math.round(this.tokens * 100) / 100,
        };
    }

    /**
     * Reset statistics counters.
     */
    resetStats(): void {
        this.totalSpans = 0;
        this.droppedSpans = 0;
        this.blockedSpans = 0;
    }
}

export interface RateLimitingProcessorOptions extends RateLimiterOptions {
    /** Next processor in the chain */
    nextProcessor?: ISpanProcessor;
}

/**
 * Span processor that enforces rate limiting before passing to next processor.
 *
 * This should be added early in the processor chain to drop spans before
 * they consume resources in downstream processors.
 */
export class RateLimitingSpanProcessor implements ISpanProcessor {
    private nextProcessor?: ISpanProcessor;
    private rateLimiter: RateLimiter;

    constructor(options: RateLimitingProcessorOptions = {}) {
        this.nextProcessor = options.nextProcessor;
        this.rateLimiter = new RateLimiter({
            maxSpansPerSecond: options.maxSpansPerSecond,
            maxBlockMs: options.maxBlockMs,
        });
    }

    /**
     * Called when span starts - pass through to next processor.
     */
    onStart(span: ISpan): void {
        if (this.nextProcessor?.onStart) {
            this.nextProcessor.onStart(span);
        }
    }

    /**
     * Called when span ends - check rate limit before passing to next processor.
     *
     * If rate limit is exceeded, span is dropped and not passed to next processor.
     */
    async onEnd(span: ISpan): Promise<void> {
        // Check rate limit
        const allowed = await this.rateLimiter.acquire(span);
        if (!allowed) {
            // Span dropped - don't pass to next processor
            return;
        }

        // Pass to next processor
        if (this.nextProcessor?.onEnd) {
            await this.nextProcessor.onEnd(span);
        }
    }

    /**
     * Shutdown processor and log final stats.
     */
    async shutdown(): Promise<void> {
        const stats = this.rateLimiter.getStats();
        if (stats.enabled && stats.droppedSpans > 0) {
            // eslint-disable-next-line no-console
            console.info(
                `[RateLimiter] Shutdown. Final stats: ` +
                `${stats.droppedSpans}/${stats.totalSpans} spans dropped (${stats.dropRatePercent}%)`
            );
        }

        if (this.nextProcessor?.shutdown) {
            await this.nextProcessor.shutdown();
        }
    }

    /**
     * Force flush - pass through to next processor.
     */
    async forceFlush(timeoutMs: number = 30000): Promise<void> {
        if (this.nextProcessor?.forceFlush) {
            await this.nextProcessor.forceFlush(timeoutMs);
        }
    }

    /**
     * Get rate limiter statistics.
     */
    getStats(): RateLimiterStats {
        return this.rateLimiter.getStats();
    }
}
