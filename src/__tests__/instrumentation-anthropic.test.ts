import { wrapAnthropicCreate } from '../instrumentation/anthropic';
import { getTracer } from '../auto';
import { SpanStatus, ISpan } from '../types';

jest.mock('../auto', () => ({
    getTracer: jest.fn()
}));

describe('Anthropic Instrumentation', () => {
    let mockSpan: ISpan;
    let mockTracer: any;

    beforeEach(() => {
        mockSpan = {
            setAttribute: jest.fn(),
            end: jest.fn(),
            recordException: jest.fn(),
        } as unknown as ISpan;

        mockTracer = {
            startActiveSpan: jest.fn((name, fn) => fn(mockSpan))
        };

        (getTracer as jest.Mock).mockReturnValue(mockTracer);
        jest.clearAllMocks();
    });

    describe('patchAnthropic', () => {
        // `_patched` is module-level state inside anthropic.ts that persists once
        // set to true, so a shared import would let an earlier successful patch
        // mask a later test's require() failure (patchAnthropic short-circuits
        // before ever touching @anthropic-ai/sdk). jest.isolateModules gives each
        // test a fresh module instance (fresh `_patched = false`) so every branch
        // is actually exercised. See src/instrumentation/gemini.ts's equivalent
        // fix for the same underlying bug.
        it('should patch when anthropic is available', () => {
            jest.isolateModules(() => {
                jest.doMock('@anthropic-ai/sdk', () => ({}), { virtual: true });

                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const fresh = require('../instrumentation/anthropic');
                expect(fresh.patchAnthropic()).toBe(true);

                jest.dontMock('@anthropic-ai/sdk');
            });
        });

        it('should return false when @anthropic-ai/sdk is not installed', () => {
            jest.isolateModules(() => {
                jest.doMock('@anthropic-ai/sdk', () => {
                    throw new Error('Cannot find module \'@anthropic-ai/sdk\'');
                }, { virtual: true });

                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const fresh = require('../instrumentation/anthropic');
                expect(() => fresh.patchAnthropic()).not.toThrow();
                expect(fresh.patchAnthropic()).toBe(false);

                jest.dontMock('@anthropic-ai/sdk');
            });
        });

        it('should return false when @anthropic-ai/sdk resolves to a falsy module', () => {
            jest.isolateModules(() => {
                jest.doMock('@anthropic-ai/sdk', () => null, { virtual: true });

                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const fresh = require('../instrumentation/anthropic');
                expect(fresh.patchAnthropic()).toBe(false);

                jest.dontMock('@anthropic-ai/sdk');
            });
        });

        it('should return true on subsequent calls without re-checking the module', () => {
            jest.isolateModules(() => {
                jest.doMock('@anthropic-ai/sdk', () => ({}), { virtual: true });

                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const fresh = require('../instrumentation/anthropic');
                expect(fresh.patchAnthropic()).toBe(true);

                jest.dontMock('@anthropic-ai/sdk');
                jest.doMock('@anthropic-ai/sdk', () => {
                    throw new Error('should never be reached');
                }, { virtual: true });
                expect(fresh.patchAnthropic()).toBe(true);

                jest.dontMock('@anthropic-ai/sdk');
            });
        });
    });

    describe('wrapAnthropicCreate', () => {
        it('should create span and capture request attributes', async () => {
            const mockCreateFn = jest.fn().mockResolvedValue({
                id: 'msg_123',
                content: [{ type: 'text', text: 'response text' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 15, output_tokens: 25 }
            });
            
            const wrappedFn = wrapAnthropicCreate(mockCreateFn, {});
            
            await wrappedFn({
                model: 'claude-3-opus-20240229',
                messages: [
                    { role: 'user', content: 'Hello' }
                ]
            });

            expect(getTracer).toHaveBeenCalledWith('anthropic');
            expect(mockTracer.startActiveSpan).toHaveBeenCalledWith('llm.anthropic.messages', expect.any(Function));
            
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.vendor', 'anthropic');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.model', 'claude-3-opus-20240229');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.prompt', 'Hello');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.response', 'response text');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.stop_reason', 'end_turn');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.usage.input_tokens', 15);
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.usage.output_tokens', 25);
            expect(mockSpan.end).toHaveBeenCalled();
        });

        it('extracts prompt from complex content blocks', async () => {
            const mockCreateFn = jest.fn().mockResolvedValue({});
            const wrappedFn = wrapAnthropicCreate(mockCreateFn, {});
            
            await wrappedFn({
                model: 'claude-3-opus',
                messages: [
                    { role: 'user', content: [{ type: 'image', source: {} }, { type: 'text', text: 'Hello image' }] }
                ]
            });
            
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.prompt', 'Hello image');
        });

        it('should capture errors', async () => {
            const error = new Error('Anthropic API Error');
            const mockCreateFn = jest.fn().mockRejectedValue(error);
            const wrappedFn = wrapAnthropicCreate(mockCreateFn, {});
            
            await expect(wrappedFn({ model: 'claude-3' })).rejects.toThrow('Anthropic API Error');
            
            expect(mockSpan.recordException).toHaveBeenCalledWith(error);
            expect(mockSpan.status).toBe(SpanStatus.ERROR);
            expect(mockSpan.end).toHaveBeenCalled();
        });
    });
});
