/**
 * Automatic LangChain instrumentation - simple one-line setup.
 * 
 * Instead of manually passing callbacks to every component, use these
 * convenience functions for automatic instrumentation with zero boilerplate.
 */

import { TracciaCallbackHandler } from './langchain-callback';
import { InstrumentationError } from '../errors';

/**
 * Global handler instance to avoid creating multiple handlers
 */
let globalTraciaHandler: TracciaCallbackHandler | null = null;

/**
 * Get or create the global Traccia callback handler.
 * 
 * @example
 * // Instead of:
 * const handler = new TracciaCallbackHandler();
 * const model = new ChatOpenAI({ callbacks: [handler] });
 * 
 * // Just do:
 * const model = new ChatOpenAI({ callbacks: [getTraciaHandler()] });
 */
export function getTraciaHandler(): TracciaCallbackHandler {
  if (!globalTraciaHandler) {
    globalTraciaHandler = new TracciaCallbackHandler();
  }
  return globalTraciaHandler;
}

/**
 * Wrap any LangChain model/chain/agent with automatic tracing.
 * 
 * @example
 * const model = new ChatOpenAI({ modelName: 'gpt-4' });
 * const tracedModel = withTracing(model);
 * 
 * const response = await tracedModel.invoke({ input: 'Hello' });
 * // Automatically traced!
 */
export function withTracing<T extends any>(component: T): T {
  const handler = getTraciaHandler();
  
  // For models and chains, add the handler to callbacks
  if (component && typeof component === 'object') {
    if ('callbacks' in component) {
      // If callbacks exist, add our handler
      const existing = (component as any).callbacks || [];
      (component as any).callbacks = Array.isArray(existing) 
        ? [...existing, handler] 
        : [existing, handler];
    } else {
      // Otherwise create callbacks array
      (component as any).callbacks = [handler];
    }
  }
  
  return component;
}

/**
 * Create a traced ChatOpenAI model with one line.
 * 
 * @example
 * const model = createTracedOpenAI({ modelName: 'gpt-4' });
 * const response = await model.invoke({ input: 'Hello' });
 */
export async function createTracedOpenAI(config: any): Promise<any> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const langchainOpenai = require('@langchain/openai');
    const model = new langchainOpenai.ChatOpenAI(config);
    return withTracing(model);
  } catch (error) {
    throw new InstrumentationError(
      'Failed to create traced ChatOpenAI. Make sure @langchain/openai is installed.'
    );
  }
}

/**
 * Create a traced agent executor with one line.
 * 
 * @example
 * const executor = createTracedAgentExecutor({
 *   agent,
 *   tools,
 *   agentExecutorOptions: { maxIterations: 10 }
 * });
 * 
 * const result = await executor.invoke({ input: 'What time is it?' });
 */
export async function createTracedAgentExecutor(options: {
  agent: any;
  tools: any[];
  agentExecutorOptions?: Record<string, any>;
}): Promise<any> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const langchainAgents = require('langchain/agents');
    const { agent, tools, agentExecutorOptions = {} } = options;
    
    const executor = langchainAgents.AgentExecutor.fromAgentAndTools({
      agent,
      tools,
      ...agentExecutorOptions,
      callbacks: [getTraciaHandler(), ...(agentExecutorOptions.callbacks || [])],
    });
    
    return executor;
  } catch (error) {
    throw new InstrumentationError(
      'Failed to create traced AgentExecutor. Make sure langchain/agents is installed.'
    );
  }
}

/**
 * Create a traced LLMChain with one line.
 * 
 * @example
 * const chain = createTracedLLMChain({
 *   llm: new ChatOpenAI(),
 *   prompt: chatPrompt
 * });
 * 
 * const result = await chain.invoke({ question: 'Hello?' });
 */
export async function createTracedLLMChain(options: {
  llm: any;
  prompt: any;
}): Promise<any> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const langchainChains = require('langchain/chains');
    const { llm, prompt } = options;
    
    const chain = new langchainChains.LLMChain({
      llm: withTracing(llm),
      prompt,
      callbacks: [getTraciaHandler()],
    });
    
    return chain;
  } catch (error) {
    throw new InstrumentationError(
      'Failed to create traced LLMChain. Make sure langchain/chains is installed.'
    );
  }
}

/**
 * Decorator for methods that should be traced.
 * 
 * @example
 * class MyAgent {
 *   @traced('agent-process')
 *   async process(input: string) {
 *     return await this.llm.invoke({ input });
 *   }
 * }
 * 
 * const agent = new MyAgent();
 * const result = await agent.process('Hello'); // Automatically traced!
 */
export function traced(spanName: string) {
  return function (
    _target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const { getTracer } = await import('../auto');
      const tracer = getTracer('decorated-method');
      
      return tracer.startActiveSpan(spanName, async (span) => {
        try {
          span.setAttribute('method', propertyKey);
          span.setAttribute('args_count', args.length);
          const result = await originalMethod.apply(this, args);
          span.setAttribute('success', true);
          return result;
        } catch (error) {
          if (error instanceof Error) {
            span.recordException(error);
          }
          throw error;
        }
      });
    };

    return descriptor;
  };
}

/**
 * Simple configuration helper for common LangChain setup patterns.
 * 
 * @example
 * const { model, executor } = await setupLangChainWithTracing({
 *   modelName: 'gpt-4',
 *   tools: [weatherTool, calculatorTool],
 *   systemPrompt: 'You are a helpful assistant.'
 * });
 * 
 * const result = await executor.invoke({ input: 'What is the weather?' });
 */
export async function setupLangChainWithTracing(options: {
  modelName?: string;
  modelConfig?: Record<string, any>;
  tools?: any[];
  systemPrompt?: string;
}): Promise<{
  model: any;
  executor: any;
  handler: TracciaCallbackHandler;
}> {
  try {
    const {
      modelName = 'gpt-4',
      modelConfig = {},
      tools = [],
      systemPrompt,
    } = options;

    // Create traced model
    const model = await createTracedOpenAI({
      modelName,
      ...modelConfig,
    });

    // Create agent if tools provided
    let executor = null;
    if (tools.length > 0) {
      try {
        // Try to create agent with tools
        const langchainAgents = require('langchain/agents');
        const langchainCore = require('@langchain/core/prompts');

        // Create prompt
        const prompt = langchainCore.ChatPromptTemplate.fromMessages([
          ...(systemPrompt
            ? [['system', systemPrompt]]
            : [['system', 'You are a helpful assistant.']]),
          ['human', '{input}'],
          new langchainCore.MessagesPlaceholder('agent_scratchpad'),
        ]);

        // Create agent
        const agent = await langchainAgents.createOpenAIToolsAgent({
          llmWithTools: model,
          tools,
          prompt,
          callbacks: [getTraciaHandler()],
        });

        // Create executor
        executor = await createTracedAgentExecutor({
          agent,
          tools,
        });
      } catch (error) {
        // If agent creation fails, just return model without executor
        console.warn('Could not create agent executor:', (error as Error).message);
      }
    }

    return {
      model,
      executor,
      handler: getTraciaHandler(),
    };
  } catch (error) {
    const err = error as Error;
    throw new InstrumentationError(
      `Failed to setup LangChain with tracing: ${err.message}`
    );
  }
}
