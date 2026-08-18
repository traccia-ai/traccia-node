import { wrapOpenAICreate, wrapOpenAIResponsesCreate } from '../instrumentation/openai';
import { getTracer } from '../auto';
import { SpanStatus, ISpan } from '../types';

jest.mock('../auto', () => ({
    getTracer: jest.fn()
}));

describe('OpenAI Instrumentation', () => {
    let mockSpan: ISpan;
    let mockTracer: any;

    beforeEach(() => {
        mockSpan = {
            attributes: {},
            setAttribute: jest.fn(function (this: any, key: string, value: unknown) {
                this.attributes[key] = value;
            }),
            end: jest.fn(),
            recordException: jest.fn(),
        } as unknown as ISpan;

        mockTracer = {
            startActiveSpan: jest.fn((name, fn) => fn(mockSpan))
        };

        (getTracer as jest.Mock).mockReturnValue(mockTracer);
        jest.clearAllMocks();
    });

    describe('patchOpenAI', () => {
        // `_patched` is module-level state inside openai.ts that persists once
        // set to true, so a shared import would let an earlier successful patch
        // mask a later test's require() failure (patchOpenAI short-circuits
        // before ever touching openai). jest.isolateModules gives each test a
        // fresh module instance (fresh `_patched = false`) so every branch is
        // actually exercised. See src/instrumentation/gemini.ts's equivalent fix
        // for the same underlying bug.
        it('should patch when openai is available (legacy SDK with chat on prototype)', () => {
            jest.isolateModules(() => {
                jest.doMock('openai', () => ({
                    OpenAI: { prototype: { chat: {} } },
                }), { virtual: true });

                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const fresh = require('../instrumentation/openai');
                expect(fresh.patchOpenAI()).toBe(true);

                jest.dontMock('openai');
            });
        });

        it('should return false when openai is not installed', () => {
            jest.isolateModules(() => {
                jest.doMock('openai', () => {
                    throw new Error('Cannot find module \'openai\'');
                }, { virtual: true });

                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const fresh = require('../instrumentation/openai');
                expect(() => fresh.patchOpenAI()).not.toThrow();
                expect(fresh.patchOpenAI()).toBe(false);

                jest.dontMock('openai');
            });
        });

        it('should return false when openai resolves to a falsy module', () => {
            jest.isolateModules(() => {
                jest.doMock('openai', () => null, { virtual: true });

                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const fresh = require('../instrumentation/openai');
                expect(fresh.patchOpenAI()).toBe(false);

                jest.dontMock('openai');
            });
        });

        it('should return true on subsequent calls without re-checking the module', () => {
            jest.isolateModules(() => {
                jest.doMock('openai', () => ({
                    OpenAI: { prototype: { chat: {} } },
                }), { virtual: true });

                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const fresh = require('../instrumentation/openai');
                expect(fresh.patchOpenAI()).toBe(true);

                jest.dontMock('openai');
                jest.doMock('openai', () => {
                    throw new Error('should never be reached');
                }, { virtual: true });
                expect(fresh.patchOpenAI()).toBe(true);

                jest.dontMock('openai');
            });
        });

        it('should return false when the OpenAI constructor has no prototype', () => {
            jest.isolateModules(() => {
                jest.doMock('openai', () => ({
                    OpenAI: {},
                }), { virtual: true });

                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const fresh = require('../instrumentation/openai');
                expect(fresh.patchOpenAI()).toBe(false);

                jest.dontMock('openai');
            });
        });

        it('should patch the "modern SDK" shape where chat is not present on the prototype', () => {
            jest.isolateModules(() => {
                jest.doMock('openai', () => ({
                    OpenAI: { prototype: {} },
                }), { virtual: true });

                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const fresh = require('../instrumentation/openai');
                expect(fresh.patchOpenAI()).toBe(true);

                jest.dontMock('openai');
            });
        });
    });

    describe('patchOpenAIResponses', () => {
        it('should return true when openai is available', () => {
            jest.isolateModules(() => {
                jest.doMock('openai', () => ({}), { virtual: true });

                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const fresh = require('../instrumentation/openai');
                expect(fresh.patchOpenAIResponses()).toBe(true);

                jest.dontMock('openai');
            });
        });

        it('should return false when openai is not installed', () => {
            jest.isolateModules(() => {
                jest.doMock('openai', () => {
                    throw new Error('Cannot find module \'openai\'');
                }, { virtual: true });

                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const fresh = require('../instrumentation/openai');
                expect(() => fresh.patchOpenAIResponses()).not.toThrow();
                expect(fresh.patchOpenAIResponses()).toBe(false);

                jest.dontMock('openai');
            });
        });

        it('should return false when openai resolves to a falsy module', () => {
            jest.isolateModules(() => {
                jest.doMock('openai', () => null, { virtual: true });

                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const fresh = require('../instrumentation/openai');
                expect(fresh.patchOpenAIResponses()).toBe(false);

                jest.dontMock('openai');
            });
        });

        it('should return true on subsequent calls without re-checking the module', () => {
            jest.isolateModules(() => {
                jest.doMock('openai', () => ({}), { virtual: true });

                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const fresh = require('../instrumentation/openai');
                expect(fresh.patchOpenAIResponses()).toBe(true);

                jest.dontMock('openai');
                jest.doMock('openai', () => {
                    throw new Error('should never be reached');
                }, { virtual: true });
                expect(fresh.patchOpenAIResponses()).toBe(true);

                jest.dontMock('openai');
            });
        });
    });

    describe('wrapOpenAICreate', () => {
        it('should create span and capture request attributes', async () => {
            const mockCreateFn = jest.fn().mockResolvedValue({
                id: 'chatcmpl-123',
                choices: [{ message: { content: 'response text' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
            });
            
            const wrappedFn = wrapOpenAICreate(mockCreateFn, {});
            
            await wrappedFn({
                model: 'gpt-4',
                messages: [
                    { role: 'system', content: 'You are a bot.' },
                    { role: 'user', content: 'Hello' }
                ]
            });

            expect(getTracer).toHaveBeenCalledWith('openai');
            expect(mockTracer.startActiveSpan).toHaveBeenCalledWith(
                'llm.openai.chat.completions',
                expect.any(Function),
            );
            
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.vendor', 'openai');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.model', 'gpt-4');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.prompt', 'Hello');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.openai.messages', expect.any(String));
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.completion', 'response text');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.response', 'response text');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.finish_reason', 'stop');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.usage.prompt_tokens', 10);
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.usage.completion_tokens', 20);
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.usage.total_tokens', 30);
            expect(mockSpan.end).toHaveBeenCalled();
        });

        it('should capture errors', async () => {
            const error = new Error('API Error');
            const mockCreateFn = jest.fn().mockRejectedValue(error);
            const wrappedFn = wrapOpenAICreate(mockCreateFn, {});
            
            await expect(wrappedFn({ model: 'gpt-4' })).rejects.toThrow('API Error');
            
            expect(mockSpan.recordException).toHaveBeenCalledWith(error);
            expect(mockSpan.status).toBe(SpanStatus.ERROR);
            expect(mockSpan.end).toHaveBeenCalled();
        });

        it('extracts messages string correctly with non-string content or single message', async () => {
            const mockCreateFn = jest.fn().mockResolvedValue({});
            const wrappedFn = wrapOpenAICreate(mockCreateFn, {});
            await wrappedFn({
                model: 'gpt-4',
                messages: [
                    { role: 'system', content: { complex: 'object' } }
                ]
            });
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.messages', expect.any(String));
        });

        it('passes through a non-object message entry unchanged', async () => {
            const mockCreateFn = jest.fn().mockResolvedValue({});
            const wrappedFn = wrapOpenAICreate(mockCreateFn, {});
            await wrappedFn({
                model: 'gpt-4',
                messages: ['a raw string message', { role: 'user', content: 'hi' }],
            });
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.openai.messages', expect.stringContaining('a raw string message'));
        });

        it('falls back to the first message when no user message with string content exists', async () => {
            const mockCreateFn = jest.fn().mockResolvedValue({});
            const wrappedFn = wrapOpenAICreate(mockCreateFn, {});
            await wrappedFn({
                model: 'gpt-4',
                messages: [{ role: 'system', content: 'system prompt as fallback' }],
            });
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.prompt', 'system prompt as fallback');
        });

        it('falls back to resp.model when the model kwarg is absent, without overwriting an explicit model', async () => {
            const mockCreateFn = jest.fn().mockResolvedValue({ model: 'gpt-4-from-response' });
            const wrappedFn = wrapOpenAICreate(mockCreateFn, {});
            await wrappedFn({ messages: [{ role: 'user', content: 'hi' }] });
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.model', 'gpt-4-from-response');
        });
    });

    describe('wrapOpenAIResponsesCreate', () => {
        it('should create span and capture response attributes', async () => {
            const mockCreateFn = jest.fn().mockResolvedValue({
                output: [{ type: 'text', text: 'response output' }],
                usage: { input_tokens: 15, output_tokens: 25 }
            });
            const wrappedFn = wrapOpenAIResponsesCreate(mockCreateFn, {});
            
            await wrappedFn({
                model: 'o1-preview',
                input: 'Hello response API'
            });

            expect(mockTracer.startActiveSpan).toHaveBeenCalledWith('llm.openai.responses', expect.any(Function));
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.vendor', 'openai');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.api', 'responses');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.model', 'o1-preview');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.prompt', 'Hello response API');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.completion', 'response output');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.response', 'response output');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.usage.input_tokens', 15);
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.usage.output_tokens', 25);
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.usage.total_tokens', 40);
            expect(mockSpan.end).toHaveBeenCalled();
        });

        it('extracts input array', async () => {
            const mockCreateFn = jest.fn().mockResolvedValue({});
            const wrappedFn = wrapOpenAIResponsesCreate(mockCreateFn, {});
            
            await wrappedFn({
                model: 'o1-preview',
                input: [{ type: 'user', content: 'Hello user input' }]
            });
            
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.prompt', 'Hello user input');
        });

        it('should capture errors', async () => {
            const error = new Error('Response API Error');
            const mockCreateFn = jest.fn().mockRejectedValue(error);
            const wrappedFn = wrapOpenAIResponsesCreate(mockCreateFn, {});

            await expect(wrappedFn({ model: 'gpt-4' })).rejects.toThrow('Response API Error');
            expect(mockSpan.recordException).toHaveBeenCalledWith(error);
            expect(mockSpan.status).toBe(SpanStatus.ERROR);
            expect(mockSpan.end).toHaveBeenCalled();
        });

        it('captures response.status and falls back to resp.model when the model kwarg is absent', async () => {
            const mockCreateFn = jest.fn().mockResolvedValue({
                model: 'o1-preview-from-response',
                status: 'completed',
            });
            const wrappedFn = wrapOpenAIResponsesCreate(mockCreateFn, {});

            await wrappedFn({ input: 'no model kwarg' });

            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.model', 'o1-preview-from-response');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.response.status', 'completed');
        });

        it('does not set llm.completion when output has no type:"text" item', async () => {
            const mockCreateFn = jest.fn().mockResolvedValue({
                output: [{ type: 'tool_call', name: 'search' }],
            });
            const wrappedFn = wrapOpenAIResponsesCreate(mockCreateFn, {});

            await wrappedFn({ model: 'o1-preview', input: 'hi' });

            expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('llm.completion', expect.anything());
        });

        it('uses llm.usage.total_tokens directly when the provider supplies it', async () => {
            const mockCreateFn = jest.fn().mockResolvedValue({
                usage: { input_tokens: 10, output_tokens: 20, total_tokens: 999 },
            });
            const wrappedFn = wrapOpenAIResponsesCreate(mockCreateFn, {});

            await wrappedFn({ model: 'o1-preview', input: 'hi' });

            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.usage.total_tokens', 999);
        });

        it('derives llm.usage.total_tokens from input+output when the provider omits it', async () => {
            const mockCreateFn = jest.fn().mockResolvedValue({
                usage: { input_tokens: 10, output_tokens: 20 },
            });
            const wrappedFn = wrapOpenAIResponsesCreate(mockCreateFn, {});

            await wrappedFn({ model: 'o1-preview', input: 'hi' });

            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.usage.total_tokens', 30);
        });
    });
});
