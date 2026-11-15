/**
 * Anthropic auto-instrumentation via monkey patching.
 *
 * Patches Anthropic client to automatically create spans for:
 * - messages.create()
 */

import { ISpan } from '../types';
import { tracedProviderCall } from './llm-call';

let _patched = false;

/**
 * Safely get a nested property from an object.
 */
function safeGet(obj: unknown, path: string, defaultValue: unknown = undefined): unknown {
    let current: unknown = obj;
    for (const part of path.split('.')) {
        if (current === null || current === undefined) {
            return defaultValue;
        }
        if (typeof current === 'object') {
            current = (current as Record<string, unknown>)[part];
        } else {
            return defaultValue;
        }
    }
    return current ?? defaultValue;
}

type PatchedFn = ((...args: unknown[]) => unknown) & { _agentTracePatched?: boolean };

type AnthropicClass = { Messages?: { prototype?: { create?: PatchedFn } } };
type AnthropicModule = AnthropicClass & { Anthropic?: AnthropicClass; default?: AnthropicClass };

function requireAnthropic(): AnthropicModule | null {
    try {
        // Dynamic import to avoid hard dependency
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        return require('@anthropic-ai/sdk') as AnthropicModule | null;
    } catch {
        return null;
    }
}

/**
 * Patch Anthropic `client.messages.create` for tracing by wrapping the shared
 * Messages prototype, so every client instance is covered.
 *
 * @returns true if create was wrapped, false otherwise
 */
export function patchAnthropic(): boolean {
    if (_patched) {
        return true;
    }

    try {
        const anthropic = requireAnthropic();
        if (!anthropic) {
            return false;
        }

        const Anthropic: AnthropicClass = anthropic.Anthropic || anthropic.default || anthropic;
        const proto = Anthropic.Messages?.prototype;
        if (!proto || typeof proto.create !== 'function') {
            return false;
        }
        if (!proto.create._agentTracePatched) {
            const wrapped = wrapAnthropicCreate(
                proto.create as (...args: unknown[]) => Promise<unknown>,
                null
            ) as PatchedFn;
            wrapped._agentTracePatched = true;
            proto.create = wrapped;
        }

        _patched = true;
        return true;
    } catch {
        return false;
    }
}

/**
 * Populate a span from a completed Anthropic message.
 */
function populateAnthropicSpan(span: ISpan, response: unknown): void {
    // Extract usage from response
    const usage = safeGet(response, 'usage') as Record<string, number> | undefined;
    if (usage) {
        span.setAttribute('llm.usage.source', 'provider_usage');

        if (usage.input_tokens !== undefined) {
            span.setAttribute('llm.usage.input_tokens', usage.input_tokens);
            // Provide OpenAI-style aliases for consistency
            span.setAttribute('llm.usage.prompt_tokens', usage.input_tokens);
            span.setAttribute('llm.usage.prompt_source', 'provider_usage');
        }

        if (usage.output_tokens !== undefined) {
            span.setAttribute('llm.usage.output_tokens', usage.output_tokens);
            // Provide OpenAI-style aliases for consistency
            span.setAttribute('llm.usage.completion_tokens', usage.output_tokens);
            span.setAttribute('llm.usage.completion_source', 'provider_usage');
        }
    }

    // Extract stop reason
    const stopReason = safeGet(response, 'stop_reason');
    if (stopReason) {
        span.setAttribute('llm.stop_reason', String(stopReason));
    }

    const completion = anthropicCompletion(response);
    if (completion) {
        span.setAttribute('llm.completion', completion.slice(0, 1000));
        // Deprecated alias of llm.completion, kept for existing readers.
        span.setAttribute('llm.response', completion.slice(0, 1000));
    }
}

/**
 * The text of an Anthropic message: every `text` content block, joined. A cited answer
 * arrives as several text blocks, and the stream accumulator concatenates every
 * text_delta the same way, so streamed and non-streamed calls record the same completion.
 * Thinking, tool_use and other non-text blocks are skipped.
 */
export function anthropicCompletion(response: unknown): string | undefined {
    const content = safeGet(response, 'content');
    if (!Array.isArray(content)) {
        return undefined;
    }
    const text = content
        .filter((block) => safeGet(block, 'type') === 'text' && typeof safeGet(block, 'text') === 'string')
        .map((block) => safeGet(block, 'text') as string)
        .join('');
    return text || undefined;
}

interface AnthropicStreamState {
    model?: string;
    text: string;
    stopReason?: string;
    inputTokens?: number;
    outputTokens?: number;
}

/**
 * Wrap an Anthropic messages.create call (non-streaming and `stream: true`).
 */
export function wrapAnthropicCreate<T>(
    createFn: (...args: unknown[]) => Promise<T>,
    instance: unknown
): (...args: unknown[]) => Promise<T> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return function wrappedCreate(this: any, ...args: unknown[]): Promise<T> {
        const kwargs = (args[0] || {}) as Record<string, unknown>;

        const model = kwargs.model as string | undefined;
        const messages = kwargs.messages as unknown[] | undefined;

        const attributes: Record<string, unknown> = {
            'llm.vendor': 'anthropic',
            'span.type': 'LLM',
        };

        if (model) {
            attributes['llm.model'] = model;
        }
        if (kwargs.stream === true) {
            attributes['llm.streaming'] = true;
        }

        // Extract prompt from messages
        if (Array.isArray(messages) && messages.length > 0) {
            const lastUserMessage = messages.filter(
                (m: unknown) =>
                    typeof m === 'object' &&
                    m !== null &&
                    (m as Record<string, unknown>).role === 'user'
            ).pop() as Record<string, unknown> | undefined;

            if (lastUserMessage?.content) {
                const content = lastUserMessage.content;
                if (typeof content === 'string') {
                    attributes['llm.prompt'] = content.slice(0, 500);
                } else if (Array.isArray(content) && content.length > 0) {
                    // Handle content blocks
                    const textBlock = content.find(
                        (block: unknown) =>
                            typeof block === 'object' &&
                            block !== null &&
                            (block as Record<string, unknown>).type === 'text'
                    ) as Record<string, unknown> | undefined;
                    if (textBlock?.text) {
                        attributes['llm.prompt'] = String(textBlock.text).slice(0, 500);
                    }
                }
            }
        }

        return tracedProviderCall<AnthropicStreamState>(createFn, instance || this, args, {
            tracerName: 'anthropic',
            spanName: 'llm.anthropic.messages',
            attributes,
            onResponse: populateAnthropicSpan,
            initStreamState: () => ({ text: '' }),
            onStreamEvent: (_span, event, state) => {
                switch (safeGet(event, 'type')) {
                    case 'message_start':
                        state.model = safeGet(event, 'message.model') as string | undefined;
                        state.inputTokens = safeGet(event, 'message.usage.input_tokens') as number | undefined;
                        break;
                    case 'content_block_delta': {
                        const text = safeGet(event, 'delta.text');
                        if (typeof text === 'string') {
                            state.text += text;
                        }
                        break;
                    }
                    case 'message_delta': {
                        const stopReason = safeGet(event, 'delta.stop_reason');
                        if (stopReason) {
                            state.stopReason = String(stopReason);
                        }
                        const outputTokens = safeGet(event, 'usage.output_tokens');
                        if (typeof outputTokens === 'number') {
                            state.outputTokens = outputTokens;
                        }
                        break;
                    }
                }
            },
            onStreamEnd: (span, state) => {
                if (state.model && !span.attributes['llm.model']) {
                    span.setAttribute('llm.model', state.model);
                }
                populateAnthropicSpan(span, {
                    usage:
                        state.inputTokens !== undefined || state.outputTokens !== undefined
                            ? { input_tokens: state.inputTokens, output_tokens: state.outputTokens }
                            : undefined,
                    stop_reason: state.stopReason,
                    content: [{ type: 'text', text: state.text }],
                });
            },
        }) as unknown as Promise<T>;
    };
}
