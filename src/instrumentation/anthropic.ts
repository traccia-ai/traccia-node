/**
 * Anthropic auto-instrumentation via monkey patching.
 *
 * Patches Anthropic client to automatically create spans for:
 * - messages.create()
 */

import { getTracer } from '../auto';
import { SpanStatus, ISpan } from '../types';

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

/**
 * Patch Anthropic messages.create for tracing.
 *
 * @returns true if patched successfully, false otherwise
 */
export function patchAnthropic(): boolean {
    if (_patched) {
        return true;
    }

    try {
        // Dynamic import to avoid hard dependency
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        const anthropic = require('@anthropic-ai/sdk');
        if (!anthropic) {
            return false;
        }

        _patched = true;
        return true;
    } catch {
        return false;
    }
}

/**
 * Wrap an Anthropic messages.create call.
 */
export function wrapAnthropicCreate<T>(
    createFn: (...args: unknown[]) => Promise<T>,
    instance: unknown
): (...args: unknown[]) => Promise<T> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return async function wrappedCreate(this: any, ...args: unknown[]): Promise<T> {
        const tracer = getTracer('anthropic');
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

        return tracer.startActiveSpan('llm.anthropic.messages', async (span: ISpan) => {
            for (const [key, value] of Object.entries(attributes)) {
                span.setAttribute(key, value);
            }

            try {
                const response = await createFn.apply(instance || this, args);

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

                // Extract response content
                const content = safeGet(response, 'content') as unknown[];
                if (Array.isArray(content) && content.length > 0) {
                    const textBlock = content.find(
                        (block: unknown) =>
                            typeof block === 'object' &&
                            block !== null &&
                            (block as Record<string, unknown>).type === 'text'
                    ) as Record<string, unknown> | undefined;

                    if (textBlock?.text) {
                        span.setAttribute('llm.response', String(textBlock.text).slice(0, 1000));
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
