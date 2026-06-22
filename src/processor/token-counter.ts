/**
 * Token counting processor for LLM spans (aligned with traccia-py).
 */

import { ISpan, ISpanProcessor } from '../types';

const BYTES_PER_TOKEN = 4;

function estimateTokensFromText(text: string): [number, string] {
  if (!text) {
    return [0, 'estimated.heuristic'];
  }
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    return [words.length, 'estimated.heuristic'];
  }
  return [Math.max(1, Math.ceil(text.length / BYTES_PER_TOKEN)), 'estimated.heuristic'];
}

function parseMessages(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function estimateOpenAIChatPromptTokens(
  messages: unknown,
): [number, string] | null {
  const parsed = parseMessages(messages);
  if (!parsed || parsed.length === 0) {
    return null;
  }

  const parts: string[] = [];
  for (const msg of parsed.slice(0, 50)) {
    if (!msg || typeof msg !== 'object') {
      continue;
    }
    const record = msg as Record<string, unknown>;
    const role = String(record.role ?? '');
    const content =
      typeof record.content === 'string' ? record.content : String(record.content ?? '');
    parts.push(`${role} ${content}`.trim());
  }

  const text = parts.filter(Boolean).join('\n');
  if (!text) {
    return null;
  }

  const [count, source] = estimateTokensFromText(text);
  return [count + 3, source === 'estimated.heuristic' ? 'estimated.chat_heuristic' : source];
}

function readPromptText(attrs: Record<string, unknown>): string | undefined {
  const value = attrs['llm.prompt'] ?? attrs['prompt'];
  return typeof value === 'string' ? value : undefined;
}

function readCompletionText(attrs: Record<string, unknown>): string | undefined {
  const value = attrs['llm.completion'] ?? attrs['completion'];
  return typeof value === 'string' ? value : undefined;
}

function readOpenAIMessages(attrs: Record<string, unknown>): unknown {
  return attrs['llm.openai.messages'] ?? attrs['llm.messages'];
}

function syncDerivedUsageAttrs(span: ISpan, attrs: Record<string, unknown>): void {
  const prompt = attrs['llm.usage.prompt_tokens'] as number | undefined;
  const completion = attrs['llm.usage.completion_tokens'] as number | undefined;

  if (prompt != null) {
    attrs['llm.usage.input_tokens'] = prompt;
    attrs['input_tokens'] = prompt;
    attrs['gen_ai.usage.input_tokens'] = prompt;
  }
  if (completion != null) {
    attrs['llm.usage.output_tokens'] = completion;
    attrs['output_tokens'] = completion;
    attrs['gen_ai.usage.output_tokens'] = completion;
  }
  if (prompt != null || completion != null) {
    attrs['llm.usage.total_tokens'] = (prompt ?? 0) + (completion ?? 0);
  }

  for (const [key, value] of Object.entries(attrs)) {
    span.attributes[key] = value;
  }
}

/**
 * Token counting processor.
 */
export class TokenCountingProcessor implements ISpanProcessor {
  onEnd(span: ISpan): void {
    try {
      const attrs = span.attributes || {};
      const promptText = readPromptText(attrs);
      const completionText = readCompletionText(attrs);
      const openaiMessages = readOpenAIMessages(attrs);

      let wrotePrompt = false;
      let wroteCompletion = false;

      if (attrs['llm.usage.prompt_tokens'] == null) {
        const chatEstimate = estimateOpenAIChatPromptTokens(openaiMessages);
        if (chatEstimate) {
          const [count, source] = chatEstimate;
          attrs['llm.usage.prompt_tokens'] = count;
          attrs['llm.usage.prompt_source'] = source;
          wrotePrompt = true;
        } else if (promptText) {
          const [count, source] = estimateTokensFromText(promptText);
          attrs['llm.usage.prompt_tokens'] = count;
          attrs['llm.usage.prompt_source'] = source;
          wrotePrompt = true;
        }
      }

      if (attrs['llm.usage.completion_tokens'] == null && completionText) {
        const [count, source] = estimateTokensFromText(completionText);
        attrs['llm.usage.completion_tokens'] = count;
        attrs['llm.usage.completion_source'] = source;
        wroteCompletion = true;
      }

      if (wrotePrompt || wroteCompletion) {
        const promptSource = attrs['llm.usage.prompt_source'] as string | undefined;
        const completionSource = attrs['llm.usage.completion_source'] as string | undefined;
        if (!attrs['llm.usage.source']) {
          if (promptSource && completionSource && promptSource === completionSource) {
            attrs['llm.usage.source'] = promptSource;
          } else if (promptSource || completionSource) {
            attrs['llm.usage.source'] = 'mixed';
          }
        } else if (attrs['llm.usage.source'] === 'provider_usage' && (wrotePrompt || wroteCompletion)) {
          attrs['llm.usage.source'] = 'mixed';
        }
      }

      syncDerivedUsageAttrs(span, attrs);
    } catch {
      // Silently fail
    }
  }

  async shutdown(): Promise<void> {
    // No-op
  }

  async forceFlush(): Promise<void> {
    // No-op
  }
}
