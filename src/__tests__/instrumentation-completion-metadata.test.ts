import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import {
    patchOpenAIResponses,
    responsesCompletion,
    responsesFinishReason,
} from '../instrumentation/openai';
import { anthropicCompletion, patchAnthropic } from '../instrumentation/anthropic';
import { getTracer } from '../auto';
import { ISpan } from '../types';

jest.mock('../auto', () => ({
    getTracer: jest.fn(),
}));

jest.mock('../governance/pep', () => ({
    enforceLlmCall: jest.fn().mockResolvedValue(undefined),
    finishLlmCall: jest.fn().mockResolvedValue(undefined),
}));

// Regression for TRC-282: Responses spans read text from the wrong output level and type,
// so real responses (output -> message -> output_text) recorded no llm.completion and no
// finish reason; Anthropic spans recorded only llm.response, not the llm.completion the UI reads.
// These go through the real provider SDKs so the fixtures are decoded exactly as in production.
describe('completion and finish metadata against the real provider SDKs (TRC-282)', () => {
    let span: ISpan;

    const jsonFetch = (body: unknown) =>
        jest.fn(async () =>
            new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        );

    const sseFetch = (events: Array<{ event: string; data: unknown }>) =>
        jest.fn(async () => {
            const encoder = new TextEncoder();
            let i = 0;
            const body = new ReadableStream<Uint8Array>({
                pull(controller) {
                    if (i < events.length) {
                        const { event, data } = events[i++];
                        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
                    } else {
                        controller.close();
                    }
                },
            });
            return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        });

    const flush = () => new Promise((resolve) => setImmediate(resolve));

    const message = (...content: unknown[]) => ({
        type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content,
    });
    const text = (t: string) => ({ type: 'output_text', text: t, annotations: [] });
    const refusal = (r: string) => ({ type: 'refusal', refusal: r });
    const functionCall = {
        type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{}', status: 'completed',
    };
    const reasoning = { type: 'reasoning', id: 'rs_1', summary: [] };
    const webSearch = { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'q' } };

    const responseBody = (output: unknown[], status = 'completed', incompleteReason?: string) => ({
        id: 'resp_1', object: 'response', created_at: 0, model: 'gpt-4o-mini', status,
        incomplete_details: incompleteReason ? { reason: incompleteReason } : null,
        parallel_tool_calls: true, tool_choice: 'auto', tools: [], output,
        usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
    });

    beforeAll(() => {
        expect(patchOpenAIResponses()).toBe(true);
        expect(patchAnthropic()).toBe(true);
    });

    beforeEach(() => {
        span = {
            attributes: {},
            setAttribute: jest.fn(function (this: { attributes: Record<string, unknown> }, k: string, v: unknown) {
                this.attributes[k] = v;
            }),
            end: jest.fn(),
            recordException: jest.fn(),
        } as unknown as ISpan;
        (getTracer as jest.Mock).mockReturnValue({ startSpan: jest.fn(() => span) });
    });

    describe('OpenAI Responses API', () => {
        it.each([
            ['text', [message(text('hello'))], 'completed', undefined, 'hello', 'stop'],
            ['multi-part', [message(text('Hello, '), text('world'))], 'completed', undefined, 'Hello, world', 'stop'],
            [
                'mixed items',
                [reasoning, message(text('first')), webSearch, message(text(' second'))],
                'completed', undefined, 'first second', 'stop',
            ],
            ['tool only', [functionCall], 'completed', undefined, undefined, 'tool_calls'],
            ['text and tool', [message(text('Looking that up.')), functionCall], 'completed', undefined, 'Looking that up.', 'tool_calls'],
            ['max_output_tokens', [message(text('truncat'))], 'incomplete', 'max_output_tokens', 'truncat', 'length'],
            ['refusal', [message(refusal("I can't help with that."))], 'completed', undefined, "I can't help with that.", 'stop'],
            ['content_filter', [], 'incomplete', 'content_filter', undefined, 'content_filter'],
            ['failed', [], 'failed', undefined, undefined, undefined],
            ['empty', [], 'completed', undefined, undefined, 'stop'],
        ])(
            '%s: records llm.completion and llm.finish_reason',
            async (_name, output, status, incompleteReason, completion, finishReason) => {
                const client = new OpenAI({
                    apiKey: 'test',
                    fetch: jsonFetch(responseBody(output, status, incompleteReason)),
                });

                const res = await client.responses.create({ model: 'gpt-4o-mini', input: 'hello' });

                expect(span.attributes['llm.completion']).toBe(completion);
                expect(span.attributes['llm.response']).toBe(completion);
                expect(span.attributes['llm.finish_reason']).toBe(finishReason);
                expect(span.attributes['llm.response.status']).toBe(status);
                expect(span.attributes['llm.usage.total_tokens']).toBe(17);
                if (completion && output.some((i) => (i as { content?: Array<{ type: string }> }).content?.some((p) => p.type === 'output_text'))) {
                    // The span carries exactly what the SDK itself reports as the response text.
                    expect(span.attributes['llm.completion']).toBe(res.output_text);
                }
            }
        );

        it('truncates a long completion', async () => {
            const client = new OpenAI({ apiKey: 'test', fetch: jsonFetch(responseBody([message(text('x'.repeat(5000)))])) });
            await client.responses.create({ model: 'gpt-4o-mini', input: 'hello' });
            expect(span.attributes['llm.completion']).toBe('x'.repeat(1000));
        });

        it('records completion and finish reason for a stream from its terminal event', async () => {
            const final = responseBody([message(text('Hel'), text('lo'))]);
            const client = new OpenAI({
                apiKey: 'test',
                fetch: sseFetch([
                    { event: 'response.created', data: { type: 'response.created', sequence_number: 0, response: { ...final, status: 'in_progress', output: [] } } },
                    { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', sequence_number: 1, item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Hello' } },
                    { event: 'response.completed', data: { type: 'response.completed', sequence_number: 2, response: final } },
                ]),
            });

            const stream = await client.responses.create({ model: 'gpt-4o-mini', input: 'hello', stream: true });
            for await (const event of stream) {
                void event;
            }
            await flush();

            expect(span.attributes['llm.completion']).toBe('Hello');
            expect(span.attributes['llm.finish_reason']).toBe('stop');
            expect(span.end).toHaveBeenCalledTimes(1);
        });

        it.each([
            ['legacy top-level text item', { status: 'completed', output: [{ type: 'text', text: 'legacy' }] }, 'legacy', 'stop'],
            ['legacy nested text part', { status: 'completed', output: [{ content: [{ type: 'text', text: 'nested' }] }] }, 'nested', 'stop'],
            ['unknown incomplete reason', { status: 'incomplete', incomplete_details: { reason: 'something_new' }, output: [] }, undefined, 'something_new'],
            ['incomplete without details', { status: 'incomplete', output: [] }, undefined, undefined],
            ['in progress', { status: 'in_progress', output: null }, undefined, undefined],
            ['empty text', { output: [message(text(''))] }, undefined, undefined],
            ['undefined', undefined, undefined, undefined],
        ])('extractors handle %s', (_name, response, completion, finishReason) => {
            expect(responsesCompletion(response)).toBe(completion);
            expect(responsesFinishReason(response)).toBe(finishReason);
        });
    });

    describe('Anthropic Messages API', () => {
        const anthropicBody = (content: unknown[], stopReason = 'end_turn') => ({
            id: 'm1', type: 'message', role: 'assistant', model: 'claude-x', content,
            stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 3 },
        });

        it.each([
            ['single text block', [{ type: 'text', text: 'hi' }], 'end_turn', 'hi'],
            [
                'thinking then text',
                [{ type: 'thinking', thinking: 'hmm', signature: 'sig' }, { type: 'text', text: 'answer' }],
                'end_turn', 'answer',
            ],
            [
                'text split around a citation',
                [{ type: 'text', text: 'The sky is ' }, { type: 'text', text: 'blue', citations: [] }, { type: 'text', text: '.' }],
                'end_turn', 'The sky is blue.',
            ],
            [
                'text then tool use',
                [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 't1', name: 'lookup', input: {} }],
                'tool_use', 'Checking.',
            ],
            ['tool use only', [{ type: 'tool_use', id: 't1', name: 'lookup', input: {} }], 'tool_use', undefined],
        ])('%s: records llm.completion and llm.stop_reason', async (_name, content, stopReason, completion) => {
            const client = new Anthropic({ apiKey: 'test', fetch: jsonFetch(anthropicBody(content, stopReason)) });

            await client.messages.create({ model: 'claude-x', max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] });

            expect(span.attributes['llm.completion']).toBe(completion);
            // llm.response stays as a backwards-compatible alias.
            expect(span.attributes['llm.response']).toBe(completion);
            expect(span.attributes['llm.stop_reason']).toBe(stopReason);
            // Anthropic keeps its native stop reason; llm.finish_reason is the OpenAI-family key.
            expect(span.attributes['llm.finish_reason']).toBeUndefined();
            expect(span.attributes['llm.usage.output_tokens']).toBe(3);
        });

        it('records llm.completion for a raw stream across text blocks, skipping thinking', async () => {
            const client = new Anthropic({
                apiKey: 'test',
                fetch: sseFetch([
                    {
                        event: 'message_start',
                        data: {
                            type: 'message_start',
                            message: {
                                id: 'm1', type: 'message', role: 'assistant', model: 'claude-x', content: [],
                                stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 },
                            },
                        },
                    },
                    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } } },
                    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'secret' } } },
                    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
                    { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
                    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi ' } } },
                    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
                    { event: 'content_block_start', data: { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } } },
                    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'there' } } },
                    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 2 } },
                    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } } },
                    { event: 'message_stop', data: { type: 'message_stop' } },
                ]),
            });

            const stream = await client.messages.create({
                model: 'claude-x', max_tokens: 16, messages: [{ role: 'user', content: 'hello' }], stream: true,
            });
            for await (const event of stream) {
                void event;
            }
            await flush();

            expect(span.attributes['llm.completion']).toBe('Hi there');
            expect(span.attributes['llm.response']).toBe('Hi there');
            expect(span.attributes['llm.stop_reason']).toBe('end_turn');
            expect(span.end).toHaveBeenCalledTimes(1);
        });

        it('extractor ignores non-array or text-less content', () => {
            expect(anthropicCompletion(undefined)).toBeUndefined();
            expect(anthropicCompletion({ content: 'not blocks' })).toBeUndefined();
            expect(anthropicCompletion({ content: [{ type: 'text', text: '' }] })).toBeUndefined();
            expect(anthropicCompletion({ content: [{ type: 'text', text: 42 }] })).toBeUndefined();
        });
    });
});
