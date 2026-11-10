/**
 * OpenAI auto-instrumentation via monkey patching.
 *
 * Patches OpenAI client to automatically create spans for:
 * - chat.completions.create()
 * - responses.create() (Responses API)
 */

import { ISpan } from '../types';
import { tracedProviderCall } from './llm-call';

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

type PatchedFn = ((...args: unknown[]) => unknown) & { _agentTracePatched?: boolean };
type CreateWrapper = (
    createFn: (...args: unknown[]) => Promise<unknown>,
    instance: unknown
) => (...args: unknown[]) => Promise<unknown>;

type ResourceClass = { prototype?: { create?: PatchedFn } };
type OpenAIClass = { Chat?: { Completions?: ResourceClass }; Responses?: ResourceClass };
type OpenAIModule = OpenAIClass & { OpenAI?: OpenAIClass; default?: OpenAIClass };

function requireOpenAI(): OpenAIModule | null {
    try {
        // Dynamic import to avoid hard dependency
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        return require('openai') as OpenAIModule | null;
    } catch {
        return null;
    }
}

/**
 * Replace `proto.create` with a traced wrapper. Every client instance shares the
 * resource prototype, so this covers clients created before and after patching.
 *
 * @returns true if `create` is now wrapped, false if the prototype has no create
 */
function patchPrototypeCreate(proto: { create?: PatchedFn } | undefined, wrap: CreateWrapper): boolean {
    if (!proto || typeof proto.create !== 'function') {
        return false;
    }
    if (proto.create._agentTracePatched) {
        return true;
    }
    const wrapped = wrap(proto.create as (...args: unknown[]) => Promise<unknown>, null) as PatchedFn;
    wrapped._agentTracePatched = true;
    proto.create = wrapped;
    return true;
}

/**
 * Patch OpenAI chat completions (`client.chat.completions.create`) for tracing.
 *
 * @returns true if create was wrapped, false otherwise
 */
export function patchOpenAI(): boolean {
    if (_patched) {
        return true;
    }

    try {
        const openai = requireOpenAI();
        if (!openai) {
            return false;
        }

        const OpenAI: OpenAIClass = openai.OpenAI || openai.default || openai;
        if (!patchPrototypeCreate(OpenAI.Chat?.Completions?.prototype, wrapOpenAICreate as CreateWrapper)) {
            return false;
        }

        _patched = true;
        return true;
    } catch {
        return false;
    }
}

/**
 * Populate a span from a completed chat completion.
 */
function populateChatSpan(span: ISpan, response: unknown): void {
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
}

interface ChatStreamState {
    model?: string;
    content: string;
    finishReason?: string;
    usage?: unknown;
}

/**
 * Wrap an OpenAI chat completions create call (non-streaming and `stream: true`).
 */
export function wrapOpenAICreate<T>(
    createFn: (...args: unknown[]) => Promise<T>,
    instance: unknown
): (...args: unknown[]) => Promise<T> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return function wrappedCreate(this: any, ...args: unknown[]): Promise<T> {
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
        if (kwargs.stream === true) {
            attributes['llm.streaming'] = true;
        }
        if (promptText) {
            attributes['llm.prompt'] = promptText;
        }
        if (messages.length > 0) {
            const serialized = JSON.stringify(messages).slice(0, 2000);
            attributes['llm.openai.messages'] = serialized;
            attributes['llm.messages'] = serialized;
        }

        return tracedProviderCall<ChatStreamState>(createFn, instance || this, args, {
            tracerName: 'openai',
            spanName: 'llm.openai.chat.completions',
            attributes,
            onResponse: populateChatSpan,
            initStreamState: () => ({ content: '' }),
            onStreamEvent: (_span, chunk, state) => {
                state.model ??= safeGet(chunk, 'model') as string | undefined;
                const choice = (safeGet(chunk, 'choices') as unknown[] | undefined)?.[0];
                const delta = safeGet(choice, 'delta.content');
                if (typeof delta === 'string') {
                    state.content += delta;
                }
                const finishReason = safeGet(choice, 'finish_reason');
                if (finishReason) {
                    state.finishReason = String(finishReason);
                }
                // Only present when the caller sets stream_options.include_usage
                const usage = safeGet(chunk, 'usage');
                if (usage) {
                    state.usage = usage;
                }
            },
            onStreamEnd: (span, state) =>
                populateChatSpan(span, {
                    model: state.model,
                    usage: state.usage,
                    choices: [{ message: { content: state.content }, finish_reason: state.finishReason }],
                }),
        }) as unknown as Promise<T>;
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
        const openai = requireOpenAI();
        if (!openai) {
            return false;
        }

        const OpenAI: OpenAIClass = openai.OpenAI || openai.default || openai;
        if (!patchPrototypeCreate(OpenAI.Responses?.prototype, wrapOpenAIResponsesCreate as CreateWrapper)) {
            return false;
        }

        _responsesPatched = true;
        return true;
    } catch {
        return false;
    }
}

/**
 * Responses output items that hand control back to the caller to run a tool, the
 * counterpart of a Chat Completions finish_reason of "tool_calls". Built-in tool items
 * (web_search_call, file_search_call, ...) run on OpenAI's side and do not end the turn.
 */
const RESPONSES_CLIENT_TOOL_ITEMS = new Set(['function_call', 'custom_tool_call']);

/**
 * `incomplete_details.reason` mapped to the Chat Completions finish_reason vocabulary,
 * so `llm.finish_reason` means the same thing for both OpenAI APIs.
 */
const RESPONSES_INCOMPLETE_REASONS: Record<string, string> = {
    max_output_tokens: 'length',
    content_filter: 'content_filter',
};

/**
 * The text a Responses API response produced, or undefined when it produced none.
 *
 * Text lives two levels down: `output` is a list of items, and each `message` item holds
 * `content` parts of type `output_text`. They are joined the way the SDK's own
 * `response.output_text` joins them. A response that only refused yields the refusal text,
 * so a refusal is still visible on the span.
 */
export function responsesCompletion(response: unknown): string | undefined {
    const output = safeGet(response, 'output');
    if (!Array.isArray(output)) {
        return undefined;
    }
    const texts: string[] = [];
    const refusals: string[] = [];
    for (const item of output) {
        // A bare top-level text item is accepted for older or hand-built payloads.
        if (safeGet(item, 'type') === 'text' && typeof safeGet(item, 'text') === 'string') {
            texts.push(safeGet(item, 'text') as string);
            continue;
        }
        const content = safeGet(item, 'content');
        if (!Array.isArray(content)) {
            continue;
        }
        for (const part of content) {
            const type = safeGet(part, 'type');
            if (type === 'output_text' || type === 'text') {
                const text = safeGet(part, 'text');
                if (typeof text === 'string') {
                    texts.push(text);
                }
            } else if (type === 'refusal') {
                const refusal = safeGet(part, 'refusal');
                if (typeof refusal === 'string') {
                    refusals.push(refusal);
                }
            }
        }
    }
    return texts.join('') || refusals.join('') || undefined;
}

/**
 * A Chat-style finish reason for a Responses API response.
 *
 * The Responses API has no finish_reason; it reports `status` and, when incomplete,
 * `incomplete_details.reason`. A completed response is "tool_calls" when it ends by asking
 * the caller to run a tool and "stop" otherwise. An incomplete one maps its reason
 * ("max_output_tokens" -> "length"; unknown reasons pass through). Other statuses (failed,
 * cancelled, in progress) have no finish reason; `llm.response.status` records them.
 */
export function responsesFinishReason(response: unknown): string | undefined {
    const status = safeGet(response, 'status');
    if (status === 'completed') {
        const output = safeGet(response, 'output');
        const callsTool =
            Array.isArray(output) &&
            output.some((item) => RESPONSES_CLIENT_TOOL_ITEMS.has(String(safeGet(item, 'type'))));
        return callsTool ? 'tool_calls' : 'stop';
    }
    if (status === 'incomplete') {
        const reason = safeGet(response, 'incomplete_details.reason');
        if (reason) {
            return RESPONSES_INCOMPLETE_REASONS[String(reason)] ?? String(reason);
        }
    }
    return undefined;
}

/**
 * Populate a span from a completed Responses API response.
 */
function populateResponsesSpan(span: ISpan, response: unknown): void {
    const completion = responsesCompletion(response);
    if (completion) {
        span.setAttribute('llm.completion', completion.slice(0, 1000));
        // Deprecated alias of llm.completion, kept for existing readers.
        span.setAttribute('llm.response', completion.slice(0, 1000));
    }
    const finishReason = responsesFinishReason(response);
    if (finishReason) {
        span.setAttribute('llm.finish_reason', finishReason);
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
}

/** Terminal Responses stream events carry the full final response. */
const RESPONSES_TERMINAL_EVENTS = new Set(['response.completed', 'response.incomplete', 'response.failed']);

/**
 * Wrap an OpenAI responses.create call (non-streaming and `stream: true`).
 */
export function wrapOpenAIResponsesCreate<T>(
    createFn: (...args: unknown[]) => Promise<T>,
    instance: unknown
): (...args: unknown[]) => Promise<T> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return function wrappedCreate(this: any, ...args: unknown[]): Promise<T> {
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
        if (kwargs.stream === true) {
            attributes['llm.streaming'] = true;
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

        return tracedProviderCall<{ final?: unknown }>(createFn, instance || this, args, {
            tracerName: 'openai',
            spanName: 'llm.openai.responses',
            attributes,
            onResponse: populateResponsesSpan,
            initStreamState: () => ({}),
            onStreamEvent: (_span, event, state) => {
                if (RESPONSES_TERMINAL_EVENTS.has(String(safeGet(event, 'type')))) {
                    state.final = safeGet(event, 'response');
                }
            },
            onStreamEnd: (span, state) => {
                if (state.final) {
                    populateResponsesSpan(span, state.final);
                }
            },
        }) as unknown as Promise<T>;
    };
}
