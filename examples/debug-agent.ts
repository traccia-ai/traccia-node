/**
 * Example: Debug Agent with Manual Span Output
 *
 * This example demonstrates how to see spans being created and finished.
 * It manually logs spans for visibility.
 *
 * Run with:
 *   npm run build
 *   npx ts-node examples/debug-agent.ts
 */

import { getTracer } from '../dist/auto';

// Simple function to log span creation
function logSpan(spanName: string, duration: number, attributes: Record<string, any>) {
  console.log('\n=== Span ===');
  console.log(`Name: ${spanName}`);
  console.log(`Duration: ${duration}ms`);
  console.log('Attributes:', attributes);
}

// Fake tools
interface Tool {
  name: string;
  call(input: string): Promise<string>;
}

const tools: Record<string, Tool> = {
  weather: {
    name: 'weather',
    call: async () => 'Weather: Sunny, 72°F',
  },
  search: {
    name: 'search',
    call: async () => 'Found 5 relevant articles',
  },
};

async function simulateAgent() {
  const tracer = getTracer('debug-agent');

  console.log('\n' + '='.repeat(60));
  console.log('🤖 Starting Agent Simulation');
  console.log('='.repeat(60));

  // Create root span
  const startTime = Date.now();
  const rootSpan = tracer.startSpan('agent-execution', {
    attributes: {
      agent_name: 'demo-agent',
      task: 'weather-query',
    },
  });

  console.log('\n📍 Root span started: agent-execution');

  // Simulate LLM call
  console.log('\n→ Step 1: LLM Decision Making');
  const llmStart = Date.now();
  const llmSpan = tracer.startSpan('llm-call', {
    attributes: {
      model: 'gpt-4',
      input: 'What is the weather?',
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 200));
  llmSpan.setAttribute('output', 'use_weather_tool');
  llmSpan.end();
  
  logSpan('llm-call', Date.now() - llmStart, {
    model: 'gpt-4',
    input: 'What is the weather?',
    output: 'use_weather_tool',
  });
  console.log('  ✓ LLM decided to use weather_tool');

  // Simulate tool use
  console.log('\n→ Step 2: Tool Execution');
  const toolStart = Date.now();
  const toolSpan = tracer.startSpan('tool-execution', {
    attributes: {
      tool_name: 'weather',
      input: 'New York',
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 150));
  const toolResult = await tools.weather.call('');
  toolSpan.setAttribute('result', toolResult);
  toolSpan.setAttribute('result_length', toolResult.length);
  toolSpan.end();
  
  logSpan('tool-execution', Date.now() - toolStart, {
    tool_name: 'weather',
    input: 'New York',
    result: toolResult,
    result_length: toolResult.length,
  });
  console.log(`  ✓ Tool returned: "${toolResult}"`);

  // Simulate response generation
  console.log('\n→ Step 3: Response Generation');
  const responseStart = Date.now();
  const responseSpan = tracer.startSpan('response-generation', {
    attributes: {
      type: 'final_answer',
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  const finalResponse = `The weather in New York is: ${toolResult}`;
  responseSpan.setAttribute('response', finalResponse);
  responseSpan.end();
  
  logSpan('response-generation', Date.now() - responseStart, {
    type: 'final_answer',
    response: finalResponse,
  });
  console.log('  ✓ Final response generated');

  // End root span
  rootSpan.end();
  
  const totalDuration = Date.now() - startTime;
  logSpan('agent-execution', totalDuration, {
    agent_name: 'demo-agent',
    task: 'weather-query',
    total_duration: totalDuration,
  });

  console.log('\n📍 Root span ended: agent-execution');
  console.log('\n' + '='.repeat(60));
}

async function main() {
  console.log('\n🚀 Debug Agent - Manual Span Output Demo\n');
  console.log('This demo shows spans being created and finished.');
  console.log('Each span is logged with its duration and attributes.\n');

  try {
    await simulateAgent();
    console.log('\n✨ Agent simulation complete!\n');
    console.log('Each "=== Span ===" block above shows a traced operation.\n');
  } catch (error) {
    console.error('Error:', error);
  }
}

main().catch(console.error);
