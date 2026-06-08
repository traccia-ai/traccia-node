/**
 * Example: Fake AI Agent with Tracing - WITH VISIBLE SPAN OUTPUT
 *
 * This example shows all spans in the console by using a small batch size
 * and short export interval to flush spans immediately.
 *
 * Run with:
 *   npm run build
 *   npx ts-node examples/fake-agent-with-spans.ts
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
      await new Promise((resolve) => setTimeout(resolve, 100));
      return `Search results for "${query}": Found 5 relevant articles about the topic.`;
    },
  },
  calculator: {
    name: 'calculator',
    description: 'Perform mathematical calculations',
    async call(expression: string): Promise<string> {
      await new Promise((resolve) => setTimeout(resolve, 50));
      try {
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

  const span = tracer.startSpan('llm-decision', {
    attributes: {
      prompt_length: prompt.length,
      model: 'fake-gpt-4',
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 150));

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

  async chat(userMessage: string): Promise<string> {
    const agentSpan = this.tracer.startSpan('agent-chat', {
      attributes: {
        user_message_length: userMessage.length,
      },
    });

    try {
      const toolName = await callFakeLLM(userMessage);

      let response = '';

      if (toolName === 'none') {
        const directSpan = this.tracer.startSpan('direct-response', {
          attributes: {
            type: 'direct',
          },
        });

        response = `I can help with that. Here's my response to "${userMessage.substring(0, 50)}..."`;

        directSpan.end();
      } else {
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

      const reasoningSpan = this.tracer.startSpan('reasoning', {
        attributes: {
          response_length: response.length,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      reasoningSpan.end();

      agentSpan.setAttribute('response_length', response.length);
      agentSpan.end();

      return response;
    } catch (error) {
      agentSpan.recordException(error as Error);
      agentSpan.end();
      throw error;
    }
  }
}

// Main demo
async function main() {
  console.log('🚀 Fake AI Agent with Visible Span Output\n');
  console.log('Configuration:');
  console.log('  - Console Exporter: ENABLED');
  console.log('  - Batch Size: 1 (flush immediately)');
  console.log('  - Export Interval: 100ms (very quick)');
  console.log('  - Span Logging: ENABLED\n');

  // Initialize tracing with aggressive flushing to see spans immediately
  startTracing({
    enableConsoleExporter: true,
    enableSpanLogging: true, // This enables span logging
    sessionId: 'fake-agent-demo-' + Date.now(),
    userId: 'demo-user',
    enableTokenCounting: false,
    enableCostTracking: false,
    maxExportBatchSize: 1, // Flush after 1 span
    scheduleDelayMs: 100, // Flush every 100ms
  });

  const agent = new FakeAgent();

  // Test conversations - just one to see the output clearly
  const testQueries = [
    'What is the weather in New York?',
  ];

  console.log('\n📝 Running test conversation...\n');
  console.log('==========================================\n');

  for (const query of testQueries) {
    console.log(`\n🧠 User: "${query}"`);
    console.log('⏳ Processing...\n');
    try {
      const response = await agent.chat(query);
      console.log(`\n✅ Agent: "${response}"\n`);
    } catch (error) {
      console.error(`❌ Error: ${error}`);
    }
  }

  console.log('\n==========================================\n');
  console.log('⏳ Waiting for all spans to be exported...\n');

  // Stop tracing and flush remaining spans
  await stopTracing();

  console.log('\n✨ Tracing complete! ');
  console.log('Look above for the "=== Span ===" output showing all traced operations.\n');
}

main().catch(console.error);
