/**
 * Token counting processor for LLM spans.
 */

import { ISpan, ISpanProcessor } from '../types';

const BYTES_PER_TOKEN = 4; // Rough approximation

/**
 * Token counting processor.
 */
export class TokenCountingProcessor implements ISpanProcessor {
  onEnd(span: ISpan): void {
    try {
      // Estimate tokens from attributes if available
      const promptText = span.attributes['prompt'] as string | undefined;
      const completionText = span.attributes['completion'] as string | undefined;

      if (promptText) {
        const inputTokens = Math.ceil(promptText.length / BYTES_PER_TOKEN);
        // Direct attribute modification for processors (after span ends)
        span.attributes['input_tokens'] = inputTokens;
      }

      if (completionText) {
        const outputTokens = Math.ceil(completionText.length / BYTES_PER_TOKEN);
        // Direct attribute modification for processors (after span ends)
        span.attributes['output_tokens'] = outputTokens;
      }
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
