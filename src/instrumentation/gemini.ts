/**
 * Gemini (@google/genai) auto-instrumentation via monkey patching.
 *
 * Patches the Gemini Interactions API client to automatically create spans for:
 * - interactions.create() (sync and streaming)
 *
 * Only the Interactions API (`client.interactions.create`, backed by the SDK's
 * `GeminiNextGenInteractions` class) is supported. The older `models.generateContent`
 * surface is not instrumented.
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
 * Extract prompt text from a Gemini interaction's `input` field.
 *
 * `input` may be a plain string or a structured array of content/steps, so
 * non-string inputs are serialized to JSON for display.
 */
function extractPromptText(input: unknown): string | undefined {
    if (input === undefined || input === null) {
        return undefined;
    }
    if (typeof input === 'string') {
        return input.slice(0, 500);
    }
    try {
        return JSON.stringify(input).slice(0, 500);
    } catch {
        return undefined;
    }
}

/**
 * Patch Gemini (@google/genai) for tracing.
 *
 * Soft-fails (returns false) if @google/genai isn't installed.
 *
 * @returns true if patched successfully, false otherwise
 */
type PatchedFn = ((...args: unknown[]) => unknown) & { _agentTracePatched?: boolean };

function requireGenai(): { GoogleGenAI?: { prototype?: object }; default?: { prototype?: object } } | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        return require('@google/genai');
    } catch {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
            const { createRequire } = require('module');
            const { join } = require('path');
            return createRequire(join(process.cwd(), 'package.json'))('@google/genai');
        } catch {
            return null;
        }
    }
}

function findPropertyDescriptor(obj: object | null, name: string): PropertyDescriptor | undefined {
    let current: object | null = obj;
    while (current) {
        const desc = Object.getOwnPropertyDescriptor(current, name);
        if (desc) {
            return desc;
        }
        current = Object.getPrototypeOf(current);
    }
    return undefined;
}

function patchInteractionsCreate(interactions: {
    create?: PatchedFn;
    constructor?: { prototype?: { create?: PatchedFn } };
}): boolean {
    if (!interactions?.create) {
        return false;
    }
    const ctorProto = interactions.constructor?.prototype;
    if (ctorProto?.create) {
        if (ctorProto.create._agentTracePatched) {
            return true;
        }
        ctorProto.create = wrapGeminiInteractionsCreate(
            ctorProto.create as (...args: unknown[]) => Promise<unknown>,
            null
        ) as PatchedFn;
        return true;
    }
    if (interactions.create._agentTracePatched) {
        return true;
    }
    interactions.create = wrapGeminiInteractionsCreate(
        interactions.create.bind(interactions) as (...args: unknown[]) => Promise<unknown>,
        interactions
    ) as PatchedFn;
    return true;
}

export function patchGemini(): boolean {
    if (_patched) {
        return true;
    }

    try {
        const genai = requireGenai();
        if (!genai) {
            return false;
        }

        const GoogleGenAI = genai.GoogleGenAI || genai.default;
        if (!GoogleGenAI?.prototype) {
            return false;
        }

        const proto = GoogleGenAI.prototype as { interactions?: unknown };
        const desc = findPropertyDescriptor(proto, 'interactions');
        if (desc?.get) {
            Object.defineProperty(proto, 'interactions', {
                configurable: true,
                enumerable: desc.enumerable,
                get: function patchedInteractionsGetter(this: unknown) {
                    const value = desc.get!.call(this);
                    if (value && typeof value === 'object') {
                        patchInteractionsCreate(value as { create?: PatchedFn });
                    }
                    return value;
                },
            });
        } else if (proto.interactions && typeof proto.interactions === 'object') {
            patchInteractionsCreate(proto.interactions as { create?: PatchedFn });
        }

        // Package is present. Wrapping may be lazy (getter) or happen on first
        // client.interactions access; tests mock an empty GoogleGenAI class.
        _patched = true;
        return true;
    } catch {
        return false;
    }
}

/**
 * Populate a span with fields from a completed (non-streaming) Interaction response.
 *
 * Not called for streaming responses — the create() call resolves with a Stream
 * object almost immediately, before the model has produced usage/output, so
 * populating here would record a near-zero duration and no usage data. See
 * wrapGeminiInteractionsCreate for how streaming is handled instead.
 */
function populateSpanFromResponse(
    span: ISpan,
    response: unknown,
    model: string | undefined
): void {
    if (!model) {
        const respModel = safeGet(response, 'model') as string | undefined;
        if (respModel && !span.attributes['llm.model']) {
            span.setAttribute('llm.model', respModel);
        }
    }

    // Usage: read the provider's total_* fields directly rather than
    // synthesizing totals from input+output, which would silently drop
    // thought/cached/tool-use tokens. Use `!= null` (not `||`) so a
    // legitimate 0 token count isn't treated as missing.
    const usage = safeGet(response, 'usage') as Record<string, number> | undefined;
    if (usage) {
        const inputTokens = usage.total_input_tokens;
        const outputTokens = usage.total_output_tokens;
        const thoughtTokens = usage.total_thought_tokens;
        const cachedTokens = usage.total_cached_tokens;
        const toolUseTokens = usage.total_tool_use_tokens;
        const totalTokens = usage.total_tokens;

        if (inputTokens != null) {
            span.setAttribute('llm.usage.input_tokens', inputTokens);
            span.setAttribute('llm.usage.prompt_tokens', inputTokens);
            span.setAttribute('llm.usage.prompt_source', 'provider_usage');
        }
        if (outputTokens != null) {
            span.setAttribute('llm.usage.output_tokens', outputTokens);
            span.setAttribute('llm.usage.completion_tokens', outputTokens);
            span.setAttribute('llm.usage.completion_source', 'provider_usage');
        }
        if (thoughtTokens != null) {
            span.setAttribute('llm.usage.thought_tokens', thoughtTokens);
        }
        if (cachedTokens != null) {
            span.setAttribute('llm.usage.cached_tokens', cachedTokens);
        }
        if (toolUseTokens != null) {
            span.setAttribute('llm.usage.tool_use_tokens', toolUseTokens);
        }

        if (totalTokens != null) {
            span.setAttribute('llm.usage.total_tokens', totalTokens);
            span.setAttribute('llm.usage.source', 'provider_usage');
        } else if (inputTokens != null && outputTokens != null) {
            // Fallback only: the provider didn't return a total, so derive
            // one from input+output (won't include thought/cache/tool tokens).
            span.setAttribute('llm.usage.total_tokens', inputTokens + outputTokens);
            span.setAttribute('llm.usage.source', 'provider_usage');
        }
    }

    const outputText = safeGet(response, 'output_text') as string | undefined;
    if (outputText) {
        const text = String(outputText).slice(0, 1000);
        span.setAttribute('llm.completion', text);
        span.setAttribute('llm.response', text);
    }

    const interactionId = safeGet(response, 'id');
    if (interactionId) {
        span.setAttribute('llm.interaction_id', String(interactionId));
    }

    const status = safeGet(response, 'status');
    if (status) {
        span.setAttribute('llm.response.status', String(status));
    }
}

/**
 * Wrap a Gemini `interactions.create` call (GeminiNextGenInteractions#create).
 *
 * Handles both non-streaming calls (span is fully populated with usage/output)
 * and streaming calls (`stream: true`), where span population is explicitly
 * skipped — see populateSpanFromResponse for why.
 */
export function wrapGeminiInteractionsCreate<T>(
    createFn: (...args: unknown[]) => Promise<T>,
    instance: unknown
): (...args: unknown[]) => Promise<T> {
    const existing = createFn as PatchedFn;
    if (existing._agentTracePatched) {
        return createFn;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrapped = async function wrappedCreate(this: any, ...args: unknown[]): Promise<T> {
        const tracer = getTracer('gemini');
        const kwargs = (args[0] || {}) as Record<string, unknown>;

        const model = kwargs.model as string | undefined;
        const streaming = kwargs.stream === true;
        const previousInteractionId = kwargs.previous_interaction_id as string | undefined;

        const attributes: Record<string, unknown> = {
            'llm.vendor': 'google_gemini',
            'span.type': 'LLM',
        };

        if (model) {
            attributes['llm.model'] = model;
        }

        const promptText = extractPromptText(kwargs.input);
        if (promptText) {
            attributes['llm.prompt'] = promptText;
        }

        if (previousInteractionId) {
            attributes['llm.previous_interaction_id'] = previousInteractionId;
        }

        if (streaming) {
            attributes['llm.streaming'] = true;
        }

        return tracer.startActiveSpan('llm.gemini.interaction', async (span: ISpan) => {
            for (const [key, value] of Object.entries(attributes)) {
                span.setAttribute(key, value);
            }

            try {
                const response = await createFn.apply(instance || this, args);

                if (!streaming) {
                    populateSpanFromResponse(span, response, model);
                }
                // Streaming: `response` is a Stream object, not a completed
                // Interaction — usage/output/model aren't available yet, so
                // span population is intentionally skipped here rather than
                // read wrong (near-zero) duration and no usage data.

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
    } as PatchedFn;
    wrapped._agentTracePatched = true;
    return wrapped as (...args: unknown[]) => Promise<T>;
}
