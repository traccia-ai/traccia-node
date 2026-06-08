/**
 * LangChain callback handler for automatic tracing.
 * Integrates with LangChain's callback system to automatically instrument
 * LLM calls, chains, agents, and tools.
 */

import { ISpan } from '../types';
import { getTracer } from '../auto';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';

/**
 * LangChain Callback Handler for Traccia SDK.
 * Automatically traces LLM calls, chains, agents, and tools.
 *
 * Extends LangChain's BaseCallbackHandler for proper interface compliance.
 * Compatible with LangChain 0.0.x, 0.1.x, 0.2.x, and 1.x versions.
 *
 * @example
 * import { ChatOpenAI } from '@langchain/openai';
 * import { TracciaCallbackHandler } from '@traccia/sdk/integrations';
 *
 * const handler = new TracciaCallbackHandler();
 * const model = new ChatOpenAI({ callbacks: [handler] });
 *
 * const response = await model.invoke({ input: 'Hello!' });
 * // Automatically traced with spans for LLM calls, tokens, latency, etc.
 */
export class TracciaCallbackHandlerOld extends BaseCallbackHandler {
  name = 'TracciaCallbackHandlerOld';
  private tracer = getTracer('langchain');
  private spanStack: Map<string, ISpan> = new Map();
  private streamingStartTimes: Record<string, Date> = {};

  /**
   * Extract model name from LLM instance, checking multiple property locations.
   * Different LLM implementations store the model name in different properties.
   */
  private extractModelName(llm: any): string {
    // Check common model name properties
    if (llm.modelName) return llm.modelName;           // ChatOpenAI, ChatAnthropic, etc.
    if (llm.model) return llm.model;                   // Ollama, etc.
    if (llm.name && !llm.name.startsWith('langchain')) return llm.name;  // Generic name
    if (llm._modelType) return llm._modelType;         // Fallback to type
    if (llm.client?.model) return llm.client.model;    // Nested model property
    return 'unknown';
  }

  /**
   * Handle LLM start - called when an LLM begins execution.
   */
  public async handleLLMStart(
    llm: any,
    prompts: string[],
    runId: string,
    _parentRunId?: string
  ): Promise<void> {
    const modelName = this.extractModelName(llm);
    
    const attributes: Record<string, any> = {
      type: 'llm',
      model: modelName,
      prompt_count: prompts.length,
      first_prompt_length: prompts[0]?.length || 0,
    };

    // Capture temperature if available
    if (llm.temperature !== undefined) {
      attributes.temperature = llm.temperature;
    }

    // Capture max tokens if available
    if (llm.maxTokens !== undefined) {
      attributes.max_tokens = llm.maxTokens;
    }
    if (llm.max_tokens !== undefined) {
      attributes.max_tokens = llm.max_tokens;
    }

    // Capture top_p if available
    if (llm.topP !== undefined) {
      attributes.top_p = llm.topP;
    }

    // Capture top_k if available
    if (llm.topK !== undefined) {
      attributes.top_k = llm.topK;
    }

    // Capture base URL for local models (Ollama, etc.)
    if (llm.baseUrl) {
      attributes.base_url = llm.baseUrl;
    }

    const span = this.tracer.startSpan('llm', { attributes });
    this.spanStack.set(runId, span);
  }

  /**
   * Handle LLM end - called when an LLM finishes execution.
   */
  public async handleLLMEnd(output: any, runId: string): Promise<void> {
    const span = this.spanStack.get(runId);
    if (span) {
      try {
        // Try multiple ways to get token usage
        // OpenAI format and new @langchain/core format
        const tokenUsage = 
          output?.llmOutput?.token_usage || 
          output?.llmOutput?.tokenUsage ||
          output?.token_usage || 
          output?.metadata?.token_usage;

        if (tokenUsage) {
          // Handle standard token counts
          const promptTokens = tokenUsage.prompt_tokens ?? tokenUsage.promptTokens;
          const completionTokens = tokenUsage.completion_tokens ?? tokenUsage.completionTokens;
          const totalTokens = tokenUsage.total_tokens ?? tokenUsage.totalTokens;

          if (promptTokens !== undefined) {
            span.setAttribute('llm.tokens.prompt', promptTokens);
          }
          if (completionTokens !== undefined) {
            span.setAttribute('llm.tokens.completion', completionTokens);
          }
          if (totalTokens !== undefined) {
            span.setAttribute('llm.tokens.total', totalTokens);
          }

          // Handle detailed token breakdown for models like GPT-4o vision
          // input_token_details contains breakdown of prompt token usage
          if (tokenUsage.input_token_details && typeof tokenUsage.input_token_details === 'object') {
            for (const [key, value] of Object.entries(tokenUsage.input_token_details)) {
              if (typeof value === 'number') {
                span.setAttribute(`llm.tokens.input_${key}`, value);
              }
            }
          }

          // output_token_details contains breakdown of completion token usage
          if (tokenUsage.output_token_details && typeof tokenUsage.output_token_details === 'object') {
            for (const [key, value] of Object.entries(tokenUsage.output_token_details)) {
              if (typeof value === 'number') {
                span.setAttribute(`llm.tokens.output_${key}`, value);
              }
            }
          }
        }

        // Capture output text length
        if (output?.text) {
          span.setAttribute('output_length', output.text.length);
        } else if (output?.generations && Array.isArray(output.generations)) {
          const firstGeneration = output.generations[0];
          if (firstGeneration?.[0]?.text) {
            span.setAttribute('output_length', firstGeneration[0].text.length);
          }
        } else if (output?.message?.content) {
          // Ollama format (uses message.content)
          const content = output.message.content;
          const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
          span.setAttribute('output_length', contentStr.length);
        } else if (typeof output === 'string') {
          // Direct string output
          span.setAttribute('output_length', output.length);
        }

        // Capture finish reason if available
        if (output?.llmOutput?.finish_reason) {
          span.setAttribute('finish_reason', output.llmOutput.finish_reason);
        }
      } catch (error) {
        // Silently fail on attribute setting
      }

      span.end();
      this.spanStack.delete(runId);
    }
  }

  /**
   * Handle LLM error.
   */
  public async handleLLMError(error: Error, runId: string): Promise<void> {
    const span = this.spanStack.get(runId);
    if (span) {
      span.recordException(error, { source: 'langchain-llm' });
      span.end();
      this.spanStack.delete(runId);
    }
  }

  /**
   * Handle LLM new token - called when a new token is generated during streaming.
   * Tracks first token latency and token count for streaming scenarios.
   */
  public async handleLLMNewToken(
    _token: string,
    _idx?: any,
    runId?: string
  ): Promise<void> {
    if (runId && !(runId in this.streamingStartTimes)) {
      // Record the time of the first streaming token
      this.streamingStartTimes[runId] = new Date();
      const span = this.spanStack.get(runId);
      if (span) {
        try {
          span.setAttribute('stream.first_token_generated', true);
        } catch (error) {
          // Silently fail
        }
      }
    }
  }

  /**
   * Handle chain start - called when a chain begins execution.
   */
  public async handleChainStart(
    chain: any,
    inputs: any,
    runId: string,
    _parentRunId?: string
  ): Promise<void> {
    const chainName = chain.name || chain._chainType || 'chain';
    
    const attributes: Record<string, any> = {
      type: 'chain',
      chain_name: chainName,
      chain_type: chain._chainType,
      input_keys: Object.keys(inputs || {}).join(','),
      input_count: Object.keys(inputs || {}).length,
    };

    // Capture total input length
    try {
      const inputStr = JSON.stringify(inputs);
      attributes.input_length = inputStr.length;
    } catch (error) {
      // Silently fail
    }

    const span = this.tracer.startSpan(`chain:${chainName}`, { attributes });
    this.spanStack.set(runId, span);
  }

  /**
   * Handle chain end - called when a chain finishes execution.
   */
  public async handleChainEnd(output: any, runId: string): Promise<void> {
    const span = this.spanStack.get(runId);
    if (span) {
      try {
        if (output) {
          const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
          span.setAttribute('output_length', outputStr.length);
        }
      } catch (error) {
        // Silently fail
      }

      span.end();
      this.spanStack.delete(runId);
    }
  }

  /**
   * Handle chain error.
   */
  public async handleChainError(error: Error, runId: string): Promise<void> {
    const span = this.spanStack.get(runId);
    if (span) {
      span.recordException(error, { source: 'langchain-chain' });
      span.end();
      this.spanStack.delete(runId);
    }
  }

  /**
   * Handle tool start - called when a tool is invoked.
   */
  public async handleToolStart(
    tool: any,
    input: string,
    runId: string,
    _parentRunId?: string
  ): Promise<void> {
    const toolName = tool.name || 'unknown-tool';
    
    const attributes: Record<string, any> = {
      type: 'tool',
      tool_name: toolName,
      tool_description: tool.description || '',
      input_length: typeof input === 'string' ? input.length : (typeof input === 'object' ? JSON.stringify(input).length : 0),
    };

    // Try to capture structured input
    try {
      if (typeof input === 'object') {
        attributes.input_keys = Object.keys(input).join(',');
      }
    } catch (error) {
      // Silently fail
    }

    const span = this.tracer.startSpan(`tool:${toolName}`, { attributes });
    this.spanStack.set(runId, span);
  }

  /**
   * Handle tool end - called when a tool finishes execution.
   */
  public async handleToolEnd(output: string, runId: string): Promise<void> {
    const span = this.spanStack.get(runId);
    if (span) {
      try {
        span.setAttribute('output_length', output?.length || 0);
      } catch (error) {
        // Silently fail
      }

      span.end();
      this.spanStack.delete(runId);
    }
  }

  /**
   * Handle tool error.
   */
  public async handleToolError(error: Error, runId: string): Promise<void> {
    const span = this.spanStack.get(runId);
    if (span) {
      span.recordException(error, { source: 'langchain-tool' });
      span.end();
      this.spanStack.delete(runId);
    }
  }

  /**
   * Handle agent action.
   */
  public async handleAgentAction(action: any, runId: string): Promise<void> {
    const span = this.spanStack.get(runId);
    if (span) {
      try {
        span.setAttribute('agent_action', action.tool);
      } catch (error) {
        // Silently fail
      }
    }
  }

  /**
   * Handle agent finish.
   */
  public async handleAgentFinish(finish: any, runId: string): Promise<void> {
    const span = this.spanStack.get(runId);
    if (span) {
      try {
        span.setAttribute('agent_finish_output', JSON.stringify(finish.returnValues));
      } catch (error) {
        // Silently fail
      }

      span.end();
      this.spanStack.delete(runId);
    }
  }

  // LangChain uses 'on*' prefix for callback methods
  // Provide aliases for compatibility
  public async onLLMStart(
    llm: any,
    prompts: string[],
    runId: string,
    parentRunId?: string
  ): Promise<void> {
    return this.handleLLMStart(llm, prompts, runId, parentRunId);
  }

  public async onLLMEnd(output: any, runId: string): Promise<void> {
    return this.handleLLMEnd(output, runId);
  }

  public async onLLMError(error: Error, runId: string): Promise<void> {
    return this.handleLLMError(error, runId);
  }

  public async onLLMNewToken(
    _token: string,
    idx?: any,
    runId?: string
  ): Promise<void> {
    return this.handleLLMNewToken(_token, idx, runId);
  }

  public async onChainStart(
    chain: any,
    inputs: any,
    runId: string,
    parentRunId?: string
  ): Promise<void> {
    return this.handleChainStart(chain, inputs, runId, parentRunId);
  }

  public async onChainEnd(output: any, runId: string): Promise<void> {
    return this.handleChainEnd(output, runId);
  }

  public async onChainError(error: Error, runId: string): Promise<void> {
    return this.handleChainError(error, runId);
  }

  public async onToolStart(
    tool: any,
    input: string,
    runId: string,
    parentRunId?: string
  ): Promise<void> {
    return this.handleToolStart(tool, input, runId, parentRunId);
  }

  public async onToolEnd(output: string, runId: string): Promise<void> {
    return this.handleToolEnd(output, runId);
  }

  public async onToolError(error: Error, runId: string): Promise<void> {
    return this.handleToolError(error, runId);
  }

  public async onAgentAction(action: any, runId: string): Promise<void> {
    return this.handleAgentAction(action, runId);
  }

  public async onAgentFinish(finish: any, runId: string): Promise<void> {
    return this.handleAgentFinish(finish, runId);
  }
}

