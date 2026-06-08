/**
 * Example: Agent with Callback Handler Pattern
 *
 * This example demonstrates the TraciaCallbackHandler pattern that
 * can be used with LangChain or similar frameworks.
 *
 * It shows how to:
 * - Create custom handlers for different agent lifecycle events
 * - Track metrics like token counts and latency
 * - Organize spans in a hierarchy
 *
 * Run with:
 *   npm run build
 *   npx ts-node examples/agent-with-callbacks.ts
 */

import { startTracing, stopTracing, getTracer } from '../dist/index';

// Callback handler interface
interface AgentCallbacks {
  onAgentStart?: (agentName: string, input: Record<string, any>) => void;
  onAgentAction?: (action: string, tool: string, input: string) => void;
  onAgentEnd?: (output: string) => void;
  onChainStart?: (chainName: string) => void;
  onChainEnd?: () => void;
  onLLMStart?: (model: string, prompts: string[]) => void;
  onLLMEnd?: (
    output: string,
    tokenInfo?: { prompt_tokens: number; completion_tokens: number }
  ) => void;
  onError?: (error: Error) => void;
}

// Mock LLM with fake token counting
class FakeLLM {
  private name: string;
  private callbacks: AgentCallbacks;

  constructor(name: string, callbacks: AgentCallbacks) {
    this.name = name;
    this.callbacks = callbacks;
  }

  async generate(prompt: string): Promise<string> {
    this.callbacks.onLLMStart?.(this.name, [prompt]);

    // Simulate LLM processing
    await new Promise((resolve) => setTimeout(resolve, 200));

    const response = this.generateResponse(prompt);

    // Simulate token counts
    const tokenInfo = {
      prompt_tokens: Math.ceil(prompt.length / 4),
      completion_tokens: Math.ceil(response.length / 4),
    };

    this.callbacks.onLLMEnd?.(response, tokenInfo);

    return response;
  }

  private generateResponse(prompt: string): string {
    const responses: Record<string, string> = {
      weather: 'The weather is sunny with a high of 72°F.',
      calculation: 'The answer to your math problem is 42.',
      search: 'I found 5 relevant sources about your topic.',
      greeting: 'Hello! How can I help you today?',
    };

    for (const [key, value] of Object.entries(responses)) {
      if (prompt.toLowerCase().includes(key)) {
        return value;
      }
    }

    return 'I processed your request. Here is my response.';
  }
}

// Tool executor with callbacks
class ToolExecutor {
  private callbacks: AgentCallbacks;

  constructor(callbacks: AgentCallbacks) {
    this.callbacks = callbacks;
  }

  async execute(toolName: string, toolInput: string): Promise<string> {
    this.callbacks.onAgentAction?.('execute', toolName, toolInput);

    // Simulate tool execution
    await new Promise((resolve) => setTimeout(resolve, 100));

    const result = `Result from ${toolName}: Executed with input "${toolInput}"`;
    return result;
  }
}

// Main agent with callbacks
class AgentWithCallbacks {
  private name: string;
  private llm: FakeLLM;
  private toolExecutor: ToolExecutor;
  private callbacks: AgentCallbacks;
  private tracer = getTracer('agent');

  constructor(name: string, callbacks: AgentCallbacks) {
    this.name = name;
    this.callbacks = callbacks;
    this.llm = new FakeLLM('gpt-4-fake', callbacks);
    this.toolExecutor = new ToolExecutor(callbacks);
  }

  async run(input: string): Promise<string> {
    const agentSpan = this.tracer.startSpan('agent-run', {
      attributes: {
        agent_name: this.name,
        input_length: input.length,
      },
    });

    try {
      this.callbacks.onAgentStart?.(this.name, { input });

      // Step 1: Chain thinking
      const thinkingSpan = this.tracer.startSpan('agent-thinking', {
        attributes: {
          step: 1,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      thinkingSpan.end();

      // Step 2: LLM decision
      const llmResponse = await this.llm.generate(input);

      // Step 3: Tool selection
      let toolName = 'default';
      if (input.toLowerCase().includes('weather')) {
        toolName = 'weather_tool';
      } else if (input.toLowerCase().includes('calculate')) {
        toolName = 'calculator_tool';
      }

      // Step 4: Execute tool
      const toolResult = await this.toolExecutor.execute(toolName, input);

      // Step 5: Final response generation
      const responseSpan = this.tracer.startSpan('response-generation', {
        attributes: {
          llm_output_length: llmResponse.length,
          tool_result_length: toolResult.length,
        },
      });

      const finalResponse = `${llmResponse} ${toolResult}`;

      responseSpan.end();
      this.callbacks.onAgentEnd?.(finalResponse);

      agentSpan.setAttribute('output_length', finalResponse.length);
      agentSpan.end();

      return finalResponse;
    } catch (error) {
      this.callbacks.onError?.(error as Error);
      agentSpan.recordException(error as Error);
      agentSpan.end();
      throw error;
    }
  }
}

// Create custom callback handler
class ConsoleCallbackHandler implements AgentCallbacks {
  private tracer = getTracer('callbacks');

  onAgentStart(agentName: string, input: Record<string, any>) {
    const span = this.tracer.startSpan('callback:agent-start', {
      attributes: {
        agent_name: agentName,
        input_keys: Object.keys(input).join(','),
      },
    });
    span.end();
    console.log(`  📍 Agent started: ${agentName}`);
  }

  onAgentAction(action: string, tool: string, input: string) {
    const span = this.tracer.startSpan('callback:agent-action', {
      attributes: {
        action,
        tool_name: tool,
        input_length: input.length,
      },
    });
    span.end();
    console.log(`  🔧 Agent action: ${action} using ${tool}`);
  }

  onAgentEnd(output: string) {
    const span = this.tracer.startSpan('callback:agent-end', {
      attributes: {
        output_length: output.length,
      },
    });
    span.end();
    console.log(`  ✅ Agent finished`);
  }

  onChainStart(chainName: string) {
    const span = this.tracer.startSpan('callback:chain-start', {
      attributes: {
        chain_name: chainName,
      },
    });
    span.end();
    console.log(`  ⛓️  Chain started: ${chainName}`);
  }

  onChainEnd() {
    const span = this.tracer.startSpan('callback:chain-end');
    span.end();
    console.log(`  ⛓️  Chain ended`);
  }

  onLLMStart(model: string, prompts: string[]) {
    const span = this.tracer.startSpan('callback:llm-start', {
      attributes: {
        model,
        prompt_count: prompts.length,
        total_prompt_length: prompts.reduce((a, b) => a + b.length, 0),
      },
    });
    span.end();
    console.log(`  🤖 LLM call: ${model} with ${prompts.length} prompt(s)`);
  }

  onLLMEnd(
    output: string,
    tokenInfo?: { prompt_tokens: number; completion_tokens: number }
  ) {
    const span = this.tracer.startSpan('callback:llm-end', {
      attributes: {
        output_length: output.length,
        prompt_tokens: tokenInfo?.prompt_tokens || 0,
        completion_tokens: tokenInfo?.completion_tokens || 0,
        total_tokens:
          (tokenInfo?.prompt_tokens || 0) + (tokenInfo?.completion_tokens || 0),
      },
    });
    span.end();
    console.log(
      `  🤖 LLM response received (${tokenInfo?.prompt_tokens || 0} prompt + ${tokenInfo?.completion_tokens || 0} completion tokens)`
    );
  }

  onError(error: Error) {
    const span = this.tracer.startSpan('callback:error', {
      attributes: {
        error_type: error.constructor.name,
        error_message: error.message,
      },
    });
    span.recordException(error);
    span.end();
    console.log(`  ❌ Error: ${error.message}`);
  }
}

// Main demo
async function main() {
  console.log('🚀 Agent with Callback Handlers\n');

  await startTracing({
    enableConsoleExporter: true,
    sessionId: 'callback-demo-' + Date.now(),
    userId: 'demo-user',
    enableTokenCounting: false,
    enableCostTracking: false,
    maxExportBatchSize: 512,           // Default batch size
    scheduleDelayMs: 5000,             // Default flush interval
  });

  const callbacks = new ConsoleCallbackHandler();
  const agent = new AgentWithCallbacks('ReasoningAgent', callbacks);

  const queries = [
    'What is the weather in San Francisco?',
    'Calculate 100 + 50',
    'Tell me something interesting',
  ];

  console.log('📝 Running agent with callbacks...\n');

  for (const query of queries) {
    console.log(`\n❓ Query: "${query}"`);
    try {
      const result = await agent.run(query);
      console.log(`📤 Response: "${result}"\n`);
    } catch (error) {
      console.error(`Error: ${error}`);
    }
  }

  await stopTracing();
  console.log('\n✨ Demo complete! Check spans output above.');
}

main().catch(console.error);
