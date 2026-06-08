/**
 * Example: Fake AI Agent with Tracing
 *
 * This example demonstrates a mock AI agent that simulates:
 * - LLM interactions
 * - Tool usage
 * - Agent reasoning and decision making
 *
 * All interactions are automatically traced using the Traccia SDK.
 *
 * Run with:
 *   npm run build
 *   npx ts-node examples/fake-agent.ts
 */

import { startTracing, stopTracing, getTracer } from '../dist/index';

// Fake tools that the agent can use
interface Tool {
  name: string;
  description: string;
  call(input: string): Promise<string>;
}

const tools: Record<string, Tool> = {
  search: {
    name: 'search',
    description: 'Search the web for information',
    async call(query: string): Promise<string> {
      // Simulate search latency
      await new Promise((resolve) => setTimeout(resolve, 100));
      return `Search results for "${query}": Found 5 relevant articles about the topic.`;
    },
  },
  calculator: {
    name: 'calculator',
    description: 'Perform mathematical calculations',
    async call(expression: string): Promise<string> {
      // Simulate calculation
      await new Promise((resolve) => setTimeout(resolve, 50));
      try {
        // Very basic eval (unsafe, just for demo)
        const result = Function(`"use strict"; return (${expression})`)();
        return `Result: ${result}`;
      } catch (e) {
        return `Error: Invalid expression`;
      }
    },
  },
  weather: {
    name: 'weather',
    description: 'Get weather information for a location',
    async call(location: string): Promise<string> {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return `Weather in ${location}: Sunny, 72°F, Humidity 65%`;
    },
  },
};

// Fake LLM that responds to prompts
async function callFakeLLM(prompt: string): Promise<string> {
  const tracer = getTracer('fake-agent');

  // Simulate thinking about which tool to use
  const span = tracer.startSpan('llm-decision', {
    attributes: {
      prompt_length: prompt.length,
      model: 'fake-gpt-4',
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 150)); // Simulate LLM latency

  // Simple pattern matching to decide which tool to use
  let toolDecision = '';
  if (prompt.toLowerCase().includes('weather')) {
    toolDecision = 'weather';
  } else if (prompt.toLowerCase().includes('calculate') || prompt.includes('=')) {
    toolDecision = 'calculator';
  } else if (prompt.toLowerCase().includes('search') || prompt.toLowerCase().includes('find')) {
    toolDecision = 'search';
  } else {
    toolDecision = 'none';
  }

  span.setAttribute('decision', toolDecision);
  span.end();

  return toolDecision;
}

// Fake Agent that orchestrates LLM calls and tool usage
class FakeAgent {
  private tracer = getTracer('agent');
  private conversationHistory: Array<{ role: string; content: string }> = [];

  async chat(userMessage: string): Promise<string> {
    const agentSpan = this.tracer.startSpan('agent-chat', {
      attributes: {
        user_message_length: userMessage.length,
      },
    });

    try {
      // Add user message to history
      this.conversationHistory.push({ role: 'user', content: userMessage });

      // Step 1: Decide if we need tools
      const toolName = await callFakeLLM(userMessage);

      let response = '';

      if (toolName === 'none') {
        // Direct response without tools
        const directSpan = this.tracer.startSpan('direct-response', {
          attributes: {
            type: 'direct',
          },
        });

        response = `I can help with that. Based on your question about "${userMessage.substring(0, 50)}...", here's what I know.`;

        directSpan.end();
      } else {
        // Use a tool
        const tool = tools[toolName];
        const toolSpan = this.tracer.startSpan(`tool-use:${toolName}`, {
          attributes: {
            tool_name: toolName,
            tool_description: tool.description,
          },
        });

        try {
          const toolResult = await tool.call(userMessage);
          toolSpan.setAttribute('tool_result_length', toolResult.length);
          response = `I used the ${toolName} tool and got: ${toolResult}`;
        } catch (error) {
          toolSpan.recordException(error as Error);
          response = `Error using ${toolName} tool`;
        }

        toolSpan.end();
      }

      // Step 2: Generate final response (simulate reasoning)
      const reasoningSpan = this.tracer.startSpan('reasoning', {
        attributes: {
          conversation_turns: this.conversationHistory.length,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 100)); // Simulate reasoning time
      reasoningSpan.end();

      // Add assistant response to history
      this.conversationHistory.push({ role: 'assistant', content: response });

      agentSpan.setAttribute('response_length', response.length);
      agentSpan.end();

      return response;
    } catch (error) {
      agentSpan.recordException(error as Error);
      agentSpan.end();
      throw error;
    }
  }

  getConversationHistory() {
    return this.conversationHistory;
  }
}

// Main demo
async function main() {
  console.log('🚀 Starting Fake AI Agent with Tracing\n');

  // Initialize tracing with console exporter to see spans
  await startTracing({
    enableConsoleExporter: true,
    sessionId: 'fake-agent-demo-' + Date.now(),
    userId: 'demo-user',
    enableTokenCounting: false,
    enableCostTracking: false,
  });

  const agent = new FakeAgent();

  // Test conversations
  const testQueries = [
    'What is the weather in New York?',
    'Calculate 25 * 4',
    'Search for information about artificial intelligence',
    'Hey there, how are you?',
  ];

  console.log('📝 Running test conversations...\n');

  for (const query of testQueries) {
    console.log(`\n🧠 User: "${query}"`);
    try {
      const response = await agent.chat(query);
      console.log(`✅ Agent: "${response}"\n`);
    } catch (error) {
      console.error(`❌ Error: ${error}`);
    }
  }

  // Show conversation history
  console.log('\n📋 Conversation History:');
  const history = agent.getConversationHistory();
  history.forEach((msg, idx) => {
    console.log(`${idx + 1}. ${msg.role.toUpperCase()}: ${msg.content}`);
  });

  // Stop tracing and flush remaining spans
  await stopTracing();

  console.log('\n✨ Tracing complete! Check console output above for span details.');
}

main().catch(console.error);
