/**
 * Ollama integration for LangChain and LangGraph with automatic tracing.
 * 
 * Run Ollama models locally and trace them automatically with Traccia.
 * 
 * @example
 * // First, start Ollama:
 * // ollama pull llama2
 * // ollama serve
 * 
 * // Then use in your code:
 * const model = await createOllamaWithTracing({
 *   model: 'llama2',
 *   baseUrl: 'http://localhost:11434',
 * });
 * 
 * const response = await model.invoke({ input: 'Hello!' });
 * // Automatically traced!
 */

import { getTraciaHandler, withTracing, setupLangChainWithTracing } from './auto-langchain';
import { InstrumentationError } from '../errors';



/**
 * Create a traced Ollama model for LangChain.
 * 
 * @example
 * const model = await createOllamaWithTracing({
 *   model: 'mistral',
 *   baseUrl: 'http://localhost:11434',
 *   temperature: 0.7,
 * });
 * 
 * const response = await model.invoke({ input: 'Write a poem' });
 * // Automatically traced!
 */
export async function createOllamaWithTracing(config: {
  model: string;
  baseUrl?: string;
  temperature?: number;
  topK?: number;
  topP?: number;
  [key: string]: any;
}): Promise<any> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const langchainOllama = require('@langchain/ollama');
    
    const {
      model,
      baseUrl = 'http://localhost:11434',
      ...otherConfig
    } = config;

    const ollamaModel = new langchainOllama.Ollama({
      model,
      baseUrl,
      ...otherConfig,
      callbacks: [getTraciaHandler()],
    });

    return withTracing(ollamaModel);
  } catch (error) {
    throw new InstrumentationError(
      'Failed to create Ollama model. Make sure @langchain/ollama is installed and Ollama is running.\n' +
      'Install with: npm install @langchain/ollama\n' +
      'Run Ollama with: ollama serve'
    );
  }
}

/**
 * Set up LangChain with Ollama and automatic tracing.
 * 
 * @example
 * const { model, executor } = await setupOllamaWithTracing({
 *   model: 'mistral',
 *   tools: [weatherTool, calculatorTool],
 *   systemPrompt: 'You are a helpful assistant.',
 * });
 * 
 * const result = await executor.invoke({ input: 'What is the weather?' });
 * // Automatically traced!
 */
export async function setupOllamaWithTracing(options: {
  model: string;
  modelConfig?: Record<string, any>;
  baseUrl?: string;
  tools?: any[];
  systemPrompt?: string;
}): Promise<{
  model: any;
  executor: any;
  handler: any;
}> {
  try {
    const {
      model,
      modelConfig = {},
      baseUrl = 'http://localhost:11434',
      tools = [],
      systemPrompt,
    } = options;

    // Create traced Ollama model
    const ollamaModel = await createOllamaWithTracing({
      model,
      baseUrl,
      ...modelConfig,
    });

    // Set up with LangChain
    return await setupLangChainWithTracing({
      modelConfig: {},
      tools,
      systemPrompt,
      // We're using the ollama model directly, not creating a new one
    }).then((result) => ({
      model: ollamaModel,
      executor: result.executor,
      handler: getTraciaHandler(),
    }));
  } catch (error) {
    const err = error as Error;
    throw new InstrumentationError(`Failed to setup Ollama with tracing: ${err.message}`);
  }
}

/**
 * Create a simple chatbot using Ollama with automatic tracing.
 * 
 * @example
 * const chatbot = await createOllamaChatbot({
 *   model: 'neural-chat',
 *   systemPrompt: 'You are a helpful assistant.',
 * });
 * 
 * const response = await chatbot('What is machine learning?');
 * // Automatically traced!
 */
export async function createOllamaChatbot(options: {
  model: string;
  baseUrl?: string;
  systemPrompt?: string;
  temperature?: number;
}): Promise<(input: string) => Promise<string>> {
  try {
    const {
      model,
      baseUrl = 'http://localhost:11434',
      systemPrompt = 'You are a helpful assistant.',
      temperature = 0.7,
    } = options;

    const ollamaModel = await createOllamaWithTracing({
      model,
      baseUrl,
      temperature,
    });

    // Return a simple chatbot function
    return async (input: string): Promise<string> => {
      const { getTracer } = await import('../auto');
      const tracer = getTracer('ollama-chatbot');

      return tracer.startActiveSpan('chatbot-query', async (span) => {
        try {
          span.setAttribute('model', model);
          span.setAttribute('input_length', input.length);

          const response = await ollamaModel.invoke({
            input: `${systemPrompt}\n\nUser: ${input}`,
          });

          span.setAttribute('output_length', response.length || 0);
          span.setAttribute('success', true);

          return response;
        } catch (error) {
          if (error instanceof Error) {
            span.recordException(error);
          }
          throw error;
        }
      });
    };
  } catch (error) {
    const err = error as Error;
    throw new InstrumentationError(`Failed to create Ollama chatbot: ${err.message}`);
  }
}

/**
 * Available Ollama models you can pull and use.
 * 
 * @example
 * const models = POPULAR_OLLAMA_MODELS;
 * // Use any of: mistral, neural-chat, llama2, orca-mini, etc.
 */
export const POPULAR_OLLAMA_MODELS = [
  {
    name: 'mistral',
    description: 'Fast and powerful 7B model',
    size: '5.4GB',
    command: 'ollama pull mistral',
  },
  {
    name: 'neural-chat',
    description: 'Intel Neural Chat, good for conversations',
    size: '3.8GB',
    command: 'ollama pull neural-chat',
  },
  {
    name: 'llama2',
    description: 'Meta Llama 2, versatile 7B model',
    size: '3.8GB',
    command: 'ollama pull llama2',
  },
  {
    name: 'orca-mini',
    description: 'Small 3B model, fast',
    size: '1.5GB',
    command: 'ollama pull orca-mini',
  },
  {
    name: 'dolphin-mixtral',
    description: 'Mixtral MoE, high quality but larger',
    size: '26GB',
    command: 'ollama pull dolphin-mixtral',
  },
  {
    name: 'opencodeup',
    description: 'Specialized for code generation',
    size: '3.5GB',
    command: 'ollama pull opencodeup',
  },
];

/**
 * Helper to get setup instructions for Ollama.
 * 
 * @example
 * console.log(getOllamaSetupInstructions());
 */
export function getOllamaSetupInstructions(): string {
  return `
📦 Ollama Setup Instructions

1. Install Ollama:
   - macOS: https://ollama.ai/download/Ollama-darwin.zip
   - Windows: https://ollama.ai/download/OllamaSetup.exe
   - Linux: curl https://ollama.ai/install.sh | sh

2. Start Ollama in the background:
   ollama serve

3. Pull a model (in another terminal):
   ollama pull mistral    # Fast 7B model (recommended)
   # or
   ollama pull neural-chat  # Optimized for chat
   # or
   ollama pull llama2       # Meta's Llama 2

4. Use in Traccia:
   import { createOllamaWithTracing } from '@traccia/sdk/integrations';
   
   const model = await createOllamaWithTracing({
     model: 'mistral',
     baseUrl: 'http://localhost:11434',
   });
   
   const response = await model.invoke({ input: 'Hello!' });

📚 Available Models:
${POPULAR_OLLAMA_MODELS.map((m) => `  - ${m.name}: ${m.description}`).join('\n')}

🔗 More info: https://ollama.ai/
  `;
}

/**
 * Create a streaming chatbot with Ollama.
 * 
 * @example
 * const chatbot = await createOllamaStreamingChatbot({
 *   model: 'mistral',
 *   onChunk: (chunk) => process.stdout.write(chunk),
 * });
 * 
 * await chatbot('Tell me a story');
 * // Streams response as it's generated!
 */
export async function createOllamaStreamingChatbot(options: {
  model: string;
  baseUrl?: string;
  systemPrompt?: string;
  temperature?: number;
  onChunk?: (chunk: string) => void;
}): Promise<(input: string) => Promise<void>> {
  try {
    const {
      model,
      baseUrl = 'http://localhost:11434',
      systemPrompt = 'You are a helpful assistant.',
      temperature = 0.7,
      onChunk = (chunk) => process.stdout.write(chunk),
    } = options;

    const ollamaModel = await createOllamaWithTracing({
      model,
      baseUrl,
      temperature,
    });

    return async (input: string): Promise<void> => {
      const { getTracer } = await import('../auto');
      const tracer = getTracer('ollama-streaming-chatbot');

      return tracer.startActiveSpan('streaming-query', async (span) => {
        try {
          span.setAttribute('model', model);
          span.setAttribute('input_length', input.length);

          const prompt = `${systemPrompt}\n\nUser: ${input}`;
          let totalChunks = 0;

          // Use streaming if available
          if (ollamaModel.stream) {
            for await (const chunk of await ollamaModel.stream({
              input: prompt,
            })) {
              const text = typeof chunk === 'string' ? chunk : chunk.text || '';
              onChunk(text);
              totalChunks += text.length;
            }
          } else {
            // Fallback to regular invoke
            const response = await ollamaModel.invoke({ input: prompt });
            onChunk(response);
            totalChunks = response.length;
          }

          span.setAttribute('output_length', totalChunks);
          span.setAttribute('success', true);
        } catch (error) {
          if (error instanceof Error) {
            span.recordException(error);
          }
          throw error;
        }
      });
    };
  } catch (error) {
    const err = error as Error;
    throw new InstrumentationError(
      `Failed to create streaming Ollama chatbot: ${err.message}`
    );
  }
}
