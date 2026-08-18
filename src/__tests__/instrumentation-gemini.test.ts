import { wrapGeminiInteractionsCreate } from '../instrumentation/gemini';
import { getTracer } from '../auto';
import { SpanStatus, ISpan } from '../types';

jest.mock('../auto', () => ({
    getTracer: jest.fn()
}));

/**
 * Fake standing in for the SDK's `GeminiNextGenInteractions` class
 * (accessible in the real SDK only via `client.interactions`, not exported
 * directly — see src/instrumentation/gemini.ts). Its `create()` shape
 * mirrors the real one: snake_case params/response fields, `usage.total_*`
 * counters, and a Stream-like object when `stream: true`.
 */
class GeminiNextGenInteractions {
    public create = jest.fn();
}

describe('Gemini Instrumentation', () => {
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

    describe('patchGemini', () => {
        // `_patched` is module-level state inside gemini.ts that persists once
        // set to true, so a shared import would let an earlier successful patch
        // mask a later test's require() failure (patchGemini short-circuits
        // before ever touching @google/genai). jest.isolateModules gives each
        // test a fresh module instance (fresh `_patched = false`) so every
        // branch is actually exercised.
        it('should patch when @google/genai is available', () => {
            jest.isolateModules(() => {
                jest.doMock('@google/genai', () => ({
                    GoogleGenAI: class {},
                }), { virtual: true });

                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const fresh = require('../instrumentation/gemini');
                expect(fresh.patchGemini()).toBe(true);

                jest.dontMock('@google/genai');
            });
        });

        it('should soft-fail (return false, not throw) when @google/genai is not installed', () => {
            jest.isolateModules(() => {
                jest.doMock('@google/genai', () => {
                    throw new Error('Cannot find module \'@google/genai\'');
                }, { virtual: true });

                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const fresh = require('../instrumentation/gemini');
                expect(() => fresh.patchGemini()).not.toThrow();
                expect(fresh.patchGemini()).toBe(false);

                jest.dontMock('@google/genai');
            });
        });

        it('should soft-fail when @google/genai resolves to a falsy module', () => {
            jest.isolateModules(() => {
                jest.doMock('@google/genai', () => null, { virtual: true });

                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const fresh = require('../instrumentation/gemini');
                expect(fresh.patchGemini()).toBe(false);

                jest.dontMock('@google/genai');
            });
        });

        it('should soft-fail when neither GoogleGenAI nor a default export is present', () => {
            jest.isolateModules(() => {
                jest.doMock('@google/genai', () => ({ SomeOtherExport: class {} }), { virtual: true });

                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const fresh = require('../instrumentation/gemini');
                expect(fresh.patchGemini()).toBe(false);

                jest.dontMock('@google/genai');
            });
        });

        it('should return true on subsequent calls without re-checking the module', () => {
            jest.isolateModules(() => {
                jest.doMock('@google/genai', () => ({ GoogleGenAI: class {} }), { virtual: true });

                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const fresh = require('../instrumentation/gemini');
                expect(fresh.patchGemini()).toBe(true);

                // Even once @google/genai is no longer mockable/available, a
                // second call should still report patched (cached) rather than
                // re-attempting the require and failing.
                jest.dontMock('@google/genai');
                jest.doMock('@google/genai', () => {
                    throw new Error('should never be reached');
                }, { virtual: true });
                expect(fresh.patchGemini()).toBe(true);

                jest.dontMock('@google/genai');
            });
        });
    });

    describe('wrapGeminiInteractionsCreate', () => {
        it('creates a span and captures request + usage attributes for a non-streaming call', async () => {
            const client = new GeminiNextGenInteractions();
            client.create.mockResolvedValue({
                id: 'interaction_123',
                model: 'models/gemini-2.5-flash',
                status: 'completed',
                output_text: 'The capital of France is Paris.',
                usage: {
                    total_input_tokens: 14,
                    total_output_tokens: 7,
                    total_thought_tokens: 3,
                    total_cached_tokens: 0,
                    total_tool_use_tokens: 0,
                    total_tokens: 24, // deliberately != input + output
                },
            });

            const wrapped = wrapGeminiInteractionsCreate(client.create, client);

            await wrapped({
                model: 'models/gemini-2.5-flash',
                input: 'What is the capital of France?',
            });

            expect(getTracer).toHaveBeenCalledWith('gemini');
            expect(mockTracer.startActiveSpan).toHaveBeenCalledWith(
                'llm.gemini.interaction',
                expect.any(Function),
            );

            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.vendor', 'google_gemini');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.model', 'models/gemini-2.5-flash');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.prompt', 'What is the capital of France?');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.completion', 'The capital of France is Paris.');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.response', 'The capital of France is Paris.');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.interaction_id', 'interaction_123');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.response.status', 'completed');

            // Usage must come straight from provider total_* fields, not be
            // synthesized from input+output (24 != 14 + 7).
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.usage.input_tokens', 14);
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.usage.output_tokens', 7);
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.usage.thought_tokens', 3);
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.usage.cached_tokens', 0);
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.usage.tool_use_tokens', 0);
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.usage.total_tokens', 24);
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.usage.source', 'provider_usage');

            expect(mockSpan.end).toHaveBeenCalled();
        });

        it('treats a 0 token count as present, not missing', async () => {
            const client = new GeminiNextGenInteractions();
            client.create.mockResolvedValue({
                usage: { total_input_tokens: 0, total_output_tokens: 5 },
            });

            const wrapped = wrapGeminiInteractionsCreate(client.create, client);
            await wrapped({ model: 'models/gemini-2.5-flash', input: 'hi' });

            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.usage.input_tokens', 0);
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.usage.output_tokens', 5);
        });

        it('falls back to input+output when the provider omits total_tokens', async () => {
            const client = new GeminiNextGenInteractions();
            client.create.mockResolvedValue({
                usage: { total_input_tokens: 10, total_output_tokens: 20 },
            });

            const wrapped = wrapGeminiInteractionsCreate(client.create, client);
            await wrapped({ model: 'models/gemini-2.5-flash', input: 'hi' });

            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.usage.total_tokens', 30);
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.usage.source', 'provider_usage');
        });

        it('falls back to resp.model when the model kwarg is absent', async () => {
            const client = new GeminiNextGenInteractions();
            client.create.mockResolvedValue({
                model: 'models/gemini-flash-latest',
                output_text: 'no model kwarg passed',
            });

            const wrapped = wrapGeminiInteractionsCreate(client.create, client);
            await wrapped({ input: 'no model kwarg passed' });

            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.model', 'models/gemini-flash-latest');
        });

        it('captures previous_interaction_id for multi-turn calls', async () => {
            const client = new GeminiNextGenInteractions();
            client.create.mockResolvedValue({ output_text: 'follow-up answer' });

            const wrapped = wrapGeminiInteractionsCreate(client.create, client);
            await wrapped({
                model: 'models/gemini-2.5-flash',
                input: 'follow-up question',
                previous_interaction_id: 'interaction_123',
            });

            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.previous_interaction_id', 'interaction_123');
        });

        it('skips span population for streaming calls instead of reading a Stream object', async () => {
            const client = new GeminiNextGenInteractions();
            const streamObj = { _isStream: true };
            client.create.mockResolvedValue(streamObj);

            const wrapped = wrapGeminiInteractionsCreate(client.create, client);
            const result = await wrapped({
                model: 'models/gemini-2.5-flash',
                input: 'stream this',
                stream: true,
            });

            expect(result).toBe(streamObj);
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.streaming', true);
            expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('llm.usage.total_tokens', expect.anything());
            expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('llm.completion', expect.anything());
            expect(mockSpan.end).toHaveBeenCalled();
        });

        it('should capture errors', async () => {
            const client = new GeminiNextGenInteractions();
            const error = new Error('Gemini API Error');
            client.create.mockRejectedValue(error);

            const wrapped = wrapGeminiInteractionsCreate(client.create, client);

            await expect(wrapped({ model: 'models/gemini-2.5-flash', input: 'hi' })).rejects.toThrow(
                'Gemini API Error',
            );

            expect(mockSpan.recordException).toHaveBeenCalledWith(error);
            expect(mockSpan.status).toBe(SpanStatus.ERROR);
            expect(mockSpan.end).toHaveBeenCalled();
        });

        it('serializes non-string input for the prompt attribute', async () => {
            const client = new GeminiNextGenInteractions();
            client.create.mockResolvedValue({});

            const wrapped = wrapGeminiInteractionsCreate(client.create, client);
            await wrapped({
                model: 'models/gemini-2.5-flash',
                input: [{ role: 'user', parts: [{ text: 'hello' }] }],
            });

            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.prompt', expect.any(String));
        });

        it('does not set llm.prompt when input is omitted', async () => {
            const client = new GeminiNextGenInteractions();
            client.create.mockResolvedValue({ output_text: 'answer' });

            const wrapped = wrapGeminiInteractionsCreate(client.create, client);
            await wrapped({ model: 'models/gemini-2.5-flash' });

            expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('llm.prompt', expect.anything());
        });

        it('does not set llm.prompt and does not throw when input cannot be JSON-serialized', async () => {
            const client = new GeminiNextGenInteractions();
            client.create.mockResolvedValue({ output_text: 'answer' });

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const circular: any = { role: 'user' };
            circular.self = circular;

            const wrapped = wrapGeminiInteractionsCreate(client.create, client);
            await expect(wrapped({ model: 'models/gemini-2.5-flash', input: circular })).resolves.toBeDefined();

            expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('llm.prompt', expect.anything());
        });

        it('handles a response with no usage/output fields without throwing', async () => {
            const client = new GeminiNextGenInteractions();
            client.create.mockResolvedValue(null);

            const wrapped = wrapGeminiInteractionsCreate(client.create, client);
            await expect(wrapped({ model: 'models/gemini-2.5-flash', input: 'hi' })).resolves.toBeNull();

            expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('llm.usage.total_tokens', expect.anything());
            expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('llm.completion', expect.anything());
            expect(mockSpan.end).toHaveBeenCalled();
        });

        it('handles a primitive (non-object) response without throwing', async () => {
            const client = new GeminiNextGenInteractions();
            client.create.mockResolvedValue('plain string response');

            const wrapped = wrapGeminiInteractionsCreate(client.create, client);
            await expect(wrapped({ model: 'models/gemini-2.5-flash', input: 'hi' })).resolves.toBe(
                'plain string response',
            );

            expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('llm.usage.total_tokens', expect.anything());
        });

        it('does not throw when called with no arguments', async () => {
            const client = new GeminiNextGenInteractions();
            client.create.mockResolvedValue({ output_text: 'answer' });

            const wrapped = wrapGeminiInteractionsCreate(client.create, client);
            await expect(wrapped()).resolves.toBeDefined();

            expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.vendor', 'google_gemini');
            expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('llm.model', expect.anything());
        });

        it('falls back to the wrapper\'s own `this` when no instance is provided', async () => {
            const client = new GeminiNextGenInteractions();
            client.create.mockImplementation(function (this: unknown) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (client as any).capturedThis = this;
                return Promise.resolve({ output_text: 'answer' });
            });

            // No `instance` argument -> the wrapper must fall back to its own `this`.
            const wrapped = wrapGeminiInteractionsCreate(client.create, undefined);
            const boundWrapped = wrapped.bind(client);

            await boundWrapped({ model: 'models/gemini-2.5-flash', input: 'hi' });

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect((client as any).capturedThis).toBe(client);
        });
    });
});
