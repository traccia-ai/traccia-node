import { DropOldestPolicy, DropNewestPolicy } from '../processor/drop-policy';
import { ISpan } from '../types';

describe('DropPolicy', () => {
    describe('DropOldestPolicy', () => {
        it('should add item when queue is not full', () => {
            const policy = new DropOldestPolicy();
            const queue: ISpan[] = [];
            const span1 = { _id: 1 } as unknown as ISpan;
            
            const result = policy.handle(queue, span1, 2);
            
            expect(result).toBe(true);
            expect(queue).toEqual([span1]);
        });

        it('should drop oldest item when queue is full', () => {
            const policy = new DropOldestPolicy();
            const span1 = { _id: 1 } as unknown as ISpan;
            const span2 = { _id: 2 } as unknown as ISpan;
            const span3 = { _id: 3 } as unknown as ISpan;
            const queue: ISpan[] = [span1, span2];
            
            const result = policy.handle(queue, span3, 2);
            
            expect(result).toBe(true);
            expect(queue).toEqual([span2, span3]);
        });

        it('should handle max size 0 gracefully', () => {
            const policy = new DropOldestPolicy();
            const queue: ISpan[] = [];
            const span1 = { _id: 1 } as unknown as ISpan;
            
            const result = policy.handle(queue, span1, 0);
            
            expect(result).toBe(false);
            expect(queue).toEqual([]);
        });
    });

    describe('DropNewestPolicy', () => {
        it('should add item when queue is not full', () => {
            const policy = new DropNewestPolicy();
            const queue: ISpan[] = [];
            const span1 = { _id: 1 } as unknown as ISpan;
            
            const result = policy.handle(queue, span1, 2);
            
            expect(result).toBe(true);
            expect(queue).toEqual([span1]);
        });

        it('should drop incoming item when queue is full', () => {
            const policy = new DropNewestPolicy();
            const span1 = { _id: 1 } as unknown as ISpan;
            const span2 = { _id: 2 } as unknown as ISpan;
            const span3 = { _id: 3 } as unknown as ISpan;
            const queue: ISpan[] = [span1, span2];
            
            const result = policy.handle(queue, span3, 2);
            
            expect(result).toBe(false);
            expect(queue).toEqual([span1, span2]);
        });
    });
});
