/**
 * Queue overflow handling strategies for span buffering.
 */

import { ISpan } from '../types';

/**
 * Base interface for drop policies deciding how to handle span queue overflow.
 */
export interface DropPolicy {
    /**
     * Apply the drop policy.
     *
     * @param queue The current span queue
     * @param item The span to add
     * @param maxSize Maximum queue size
     * @returns True if the span was enqueued, false if it was dropped
     */
    handle(queue: ISpan[], item: ISpan, maxSize: number): boolean;
}

/**
 * Drop the oldest span to make room for a new one.
 */
export class DropOldestPolicy implements DropPolicy {
    handle(queue: ISpan[], item: ISpan, maxSize: number): boolean {
        if (queue.length >= maxSize && queue.length > 0) {
            queue.shift(); // Remove oldest (first element)
        }
        if (queue.length < maxSize) {
            queue.push(item);
            return true;
        }
        return false;
    }
}

/**
 * Drop the incoming span if the queue is full.
 */
export class DropNewestPolicy implements DropPolicy {
    handle(queue: ISpan[], item: ISpan, maxSize: number): boolean {
        if (queue.length < maxSize) {
            queue.push(item);
            return true;
        }
        return false;
    }
}

/**
 * Default drop policy - drops oldest spans when queue is full.
 */
export const DEFAULT_DROP_POLICY: DropPolicy = new DropOldestPolicy();
