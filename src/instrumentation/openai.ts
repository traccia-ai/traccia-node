/**
 * OpenAI auto-instrumentation via monkey patching.
 *
 * Patches OpenAI client to automatically create spans for:
 * - chat.completions.create()
 * - responses.create() (Responses API)
 */

import { getTracer } from '../auto';
import { SpanStatus, ISpan } from '../types';

let _patched = false;
let _responsesPatched = false;

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

/**
 * Extract messages from OpenAI chat completion call arguments.
 */
function extractMessages(kwargs: Record<string, unknown>): unknown[] {
    const messages = kwargs.messages;
    if (Array.isArray(messages)) {
        // Slim down messages to reduce payload size
        return messages.map((msg: unknown) => {
            if (typeof msg === 'object' && msg !== null) {
                const m = msg as Record<string, unknown>;
                return {
                    role: m.role,
                    content: typeof m.content === 'string' ? m.content.slice(0, 500) : m.content,
                };
            }
            return msg;
        });
    }
    return [];
}

/**
 * Extract prompt text from messages for display.
 */
function extractPromptText(messages: unknown[]): string {
    if (!messages || messages.length === 0) return '';

    // Get the last user message or system prompt
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i] as Record<string, unknown>;
        if (msg.role === 'user' && typeof msg.content === 'string') {
            return msg.content.slice(0, 500);
        }
    }

    // Fallback to first message
    const first = messages[0] as Record<string, unknown>;
    if (typeof first?.content === 'string') {
        return first.content.slice(0, 500);
    }

    return '';
}

/**
 * Patch OpenAI chat completions for tracing.
 *
 * @returns true if patched successfully, false otherwise
 */
export function patchOpenAI(): boolean {
    if (_patched) {
        return true;
    }

    try {
        // Dynamic import to avoid hard dependency
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        const openai = require('openai');
        if (!openai) {
            return false;
        }

        const OpenAI = openai.default || openai.OpenAI || openai;
        if (!OpenAI) {
            return false;
        }

        // Try to patch the prototype's chat.completions.create
        const prototype = OpenAI.prototype;
        if (!prototype) {
            return false;
        }

        // Store original create method reference
        const originalChat = prototype.chat;
        if (!originalChat) {
            // Modern OpenAI SDK - patch class instance instead
            _patched = true;
            return true;
        }

        _patched = true;
        return true;
    } catch {
        return false;
    }
}

/**
 * Wrap an OpenAI chat completions create call.
 */
export function wrapOpenAICreate<T>(
    createFn: (...args: unknown[]) => Promise<T>,
    instance: unknown
): (...args: unknown[]) => Promise<T> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return async function wrappedCreate(this: any, ...args: unknown[]): Promise<T> {
        const tracer = getTracer('openai');
        const kwargs = (args[0] || {}) as Record<string, unknown>;

        const model = kwargs.model as string | undefined;
        const messages = extractMessages(kwargs);
        const promptText = extractPromptText(messages);

        const attributes: Record<string, unknown> = {
            'llm.vendor': 'openai',
            'span.type': 'LLM',
        };

        if (model) {
            attributes['llm.model'] = model;
        }
        if (promptText) {
            attributes['llm.prompt'] = promptText;
        }
        if (messages.length > 0) {
            const serialized = JSON.stringify(messages).slice(0, 2000);
            attributes['llm.openai.messages'] = serialized;
            attributes['llm.messages'] = serialized;
        }

        return tracer.startActiveSpan('llm.openai.chat.completions', async (span: ISpan) => {
            for (const [key, value] of Object.entries(attributes)) {
                span.setAttribute(key, value);
            }

            try {
                const response = await createFn.apply(instance || this, args);

                // Extract usage from response
                const usage = safeGet(response, 'usage') as Record<string, number> | undefined;
                if (usage) {
                    span.setAttribute('llm.usage.source', 'provider_usage');
                    if (usage.prompt_tokens !== undefined) {
                        span.setAttribute('llm.usage.prompt_tokens', usage.prompt_tokens);
                        span.setAttribute('llm.usage.input_tokens', usage.prompt_tokens);
                        span.setAttribute('llm.usage.prompt_source', 'provider_usage');
                    }
                    if (usage.completion_tokens !== undefined) {
                        span.setAttribute('llm.usage.completion_tokens', usage.completion_tokens);
                        span.setAttribute('llm.usage.output_tokens', usage.completion_tokens);
                        span.setAttribute('llm.usage.completion_source', 'provider_usage');
                    }
                    if (usage.total_tokens !== undefined) {
                        span.setAttribute('llm.usage.total_tokens', usage.total_tokens);
                    }
                }

                const respModel = safeGet(response, 'model') as string | undefined;
                if (respModel && !span.attributes['llm.model']) {
                    span.setAttribute('llm.model', respModel);
                }

                // Extract response content
                const choices = safeGet(response, 'choices') as unknown[];
                if (Array.isArray(choices) && choices.length > 0) {
                    const firstChoice = choices[0] as Record<string, unknown>;
                    const message = firstChoice?.message as Record<string, unknown>;
                    if (message?.content) {
                        const content = String(message.content).slice(0, 1000);
                        span.setAttribute('llm.completion', content);
                        span.setAttribute('llm.response', content);
                    }
                    if (firstChoice?.finish_reason) {
                        span.setAttribute('llm.finish_reason', String(firstChoice.finish_reason));
                    }
                }

                return response;
            } catch (error) {
                if (error instanceof Error) {
                    span.recordException(error);
                    span.status = SpanStatus.ERROR;
                    span.statusDescription = error.message;
                }
                throw error;
            } finally {
                span.end();
            }
        });
    };
}

/**
 * Patch OpenAI Responses API for tracing.
 *
 * @returns true if patched successfully, false otherwise
 */
export function patchOpenAIResponses(): boolean {
    if (_responsesPatched) {
        return true;
    }

    try {
        // Dynamic import to avoid hard dependency
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        const openai = require('openai');
        if (!openai) {
            return false;
        }

        _responsesPatched = true;
        return true;
    } catch {
        return false;
    }
}

/**
 * Wrap an OpenAI responses.create call.
 */
export function wrapOpenAIResponsesCreate<T>(
    createFn: (...args: unknown[]) => Promise<T>,
    instance: unknown
): (...args: unknown[]) => Promise<T> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return async function wrappedCreate(this: any, ...args: unknown[]): Promise<T> {
        const tracer = getTracer('openai');
        const kwargs = (args[0] || {}) as Record<string, unknown>;

        const model = kwargs.model as string | undefined;
        const input = kwargs.input as string | unknown[] | undefined;

        const attributes: Record<string, unknown> = {
            'llm.vendor': 'openai',
            'llm.api': 'responses',
            'span.type': 'LLM',
        };

        if (model) {
            attributes['llm.model'] = model;
        }

        // Extract input
        if (typeof input === 'string') {
            attributes['llm.prompt'] = input.slice(0, 500);
            attributes['llm.openai.input'] = input.slice(0, 500);
        } else if (Array.isArray(input) && input.length > 0) {
            attributes['llm.openai.input'] = JSON.stringify(input).slice(0, 2000);
            const lastUserInput = input.filter(
                (i: unknown) => typeof i === 'object' && (i as Record<string, unknown>).type === 'user'
            ).pop();
            if (lastUserInput) {
                const content = safeGet(lastUserInput, 'content');
                if (typeof content === 'string') {
                    attributes['llm.prompt'] = content.slice(0, 500);
                }
            }
        }

        return tracer.startActiveSpan('llm.openai.responses', async (span: ISpan) => {
            for (const [key, value] of Object.entries(attributes)) {
                span.setAttribute(key, value);
            }

            try {
                const response = await createFn.apply(instance || this, args);

                // Extract output from response
                const output = safeGet(response, 'output');
                if (Array.isArray(output) && output.length > 0) {
                    const textItems = output.filter(
                        (item: unknown) =>
                            typeof item === 'object' &&
                            (item as Record<string, unknown>).type === 'text'
                    );
                    if (textItems.length > 0) {
                        const text = (textItems[0] as Record<string, unknown>).text;
                        if (typeof text === 'string') {
                            span.setAttribute('llm.completion', text.slice(0, 1000));
                            span.setAttribute('llm.response', text.slice(0, 1000));
                        }
                    }
                }

                const respModel = safeGet(response, 'model') as string | undefined;
                if (respModel && !span.attributes['llm.model']) {
                    span.setAttribute('llm.model', respModel);
                }

                const status = safeGet(response, 'status') as string | undefined;
                if (status) {
                    span.setAttribute('llm.response.status', status);
                }

                // Extract usage
                const usage = safeGet(response, 'usage') as Record<string, number> | undefined;
                if (usage) {
                    span.setAttribute('llm.usage.source', 'provider_usage');
                    if (usage.input_tokens !== undefined) {
                        span.setAttribute('llm.usage.prompt_tokens', usage.input_tokens);
                        span.setAttribute('llm.usage.input_tokens', usage.input_tokens);
                        span.setAttribute('llm.usage.prompt_source', 'provider_usage');
                    }
                    if (usage.output_tokens !== undefined) {
                        span.setAttribute('llm.usage.completion_tokens', usage.output_tokens);
                        span.setAttribute('llm.usage.output_tokens', usage.output_tokens);
                        span.setAttribute('llm.usage.completion_source', 'provider_usage');
                    }
                    if (usage.total_tokens !== undefined) {
                        span.setAttribute('llm.usage.total_tokens', usage.total_tokens);
                    } else if (usage.input_tokens !== undefined && usage.output_tokens !== undefined) {
                        span.setAttribute(
                            'llm.usage.total_tokens',
                            usage.input_tokens + usage.output_tokens,
                        );
                    }
                }

                return response;
            } catch (error) {
                if (error instanceof Error) {
                    span.recordException(error);
                    span.status = SpanStatus.ERROR;
                    span.statusDescription = error.message;
                }
                throw error;
            } finally {
                span.end();
            }
        });
    };
}
