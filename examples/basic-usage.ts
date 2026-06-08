/**
 * Complete example showing SDK usage for LLM applications.
 */

import {
  startTracing,
  getTracer,
  stopTracing,
  getTracerProvider,
} from '../dist/index';
import { ISpan } from '../dist/types';

/**
 * Example LLM application with tracing.
 */
async function exampleLLMApplication() {
  // Initialize tracing
  // The SDK automatically reads configuration from environment variables:
  // - AGENT_DASHBOARD_API_KEY
  // - AGENT_DASHBOARD_ENDPOINT
  // - AGENT_DASHBOARD_SAMPLE_RATE
  // You only need to pass overrides or session-specific values
  console.log('Starting tracing...');
  await startTracing({
    sessionId: 'session-123',
    userId: 'user-456',
    enableConsoleExporter: true, // Optional: log spans to console for debugging
  });

  const tracer = getTracer('llm-app');

  try {
    // Example 1: Simple span creation
    console.log('\n=== Example 1: Simple Span ===');
    const simpleSpan = tracer.startSpan('simple-operation', {
      attributes: {
        userId: 'user-123',
        version: '1.0.0',
      },
    });

    // Simulate work
    await new Promise((resolve) => setTimeout(resolve, 100));

    simpleSpan.setAttribute('status', 'completed');
    simpleSpan.end();

    // Example 2: Nested spans using active spans
    console.log('\n=== Example 2: Nested Spans ===');
    await tracer.startActiveSpan('parent-operation', async (parentSpan: ISpan) => {
      parentSpan.setAttribute('operation', 'process');

      // Child spans automatically inherit parent context
      const childSpan = tracer.startSpan('child-operation', {
        attributes: {
          step: 1,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      childSpan.setAttribute('result', 'success');
      childSpan.end();
    });

    // Example 3: Error handling
    console.log('\n=== Example 3: Error Handling ===');
    const errorSpan = tracer.startSpan('error-operation');

    try {
      throw new Error('Example error');
    } catch (error) {
      errorSpan.recordException(error as Error, {
        context: 'processing',
        severity: 'high',
      });
    }

    errorSpan.end();

    // Example 4: LLM call with token tracking
    console.log('\n=== Example 4: LLM Call with Token Tracking ===');
    const llmSpan = tracer.startSpan('llm-call', {
      attributes: {
        model: 'gpt-3.5-turbo',
        provider: 'openai',
        temperature: 0.7,
      },
    });

    // Simulate LLM call
    const prompt = 'Hello, how can I help you?';
    const completion = 'I can help you with various tasks...';

    llmSpan.setAttribute('prompt', prompt);
    llmSpan.setAttribute('completion', completion);
    llmSpan.setAttribute('input_tokens', 15);
    llmSpan.setAttribute('output_tokens', 25);

    await new Promise((resolve) => setTimeout(resolve, 100));
    llmSpan.end();

    // Example 5: Multiple events
    console.log('\n=== Example 5: Events ===');
    const eventSpan = tracer.startSpan('multi-step-operation');

    eventSpan.addEvent('step_1_started', {
      timestamp: Date.now(),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    eventSpan.addEvent('step_1_completed', {
      duration: 50,
      result: 'success',
    });

    eventSpan.addEvent('step_2_started');
    await new Promise((resolve) => setTimeout(resolve, 50));
    eventSpan.addEvent('step_2_completed');

    eventSpan.end();

    // Example 6: Agent execution
    console.log('\n=== Example 6: Agent Execution ===');
    await tracer.startActiveSpan(
      'agent-execution',
      async (agentSpan: ISpan) => {
        agentSpan.setAttribute('agent', 'research-assistant');
        agentSpan.setAttribute('task', 'search-and-summarize');

        // Tool use
        const toolSpan = tracer.startSpan('tool-use', {
          attributes: {
            tool: 'search_api',
            query: 'latest AI trends',
          },
        });

        await new Promise((resolve) => setTimeout(resolve, 100));
        toolSpan.setAttribute('results_count', 10);
        toolSpan.end();

        // LLM processing
        const llmProcessingSpan = tracer.startSpan('llm-processing', {
          attributes: {
            model: 'gpt-4',
            task: 'summarize',
          },
        });

        await new Promise((resolve) => setTimeout(resolve, 150));
        llmProcessingSpan.setAttribute('summary_length', 250);
        llmProcessingSpan.end();
      },
      {
        attributes: {
          retry_count: 0,
        },
      }
    );

    // Force flush to ensure all spans are exported
    console.log('\n=== Flushing Spans ===');
    const provider = getTracerProvider();
    await provider.forceFlush(5000);
  } finally {
    // Graceful shutdown
    console.log('\n=== Shutting Down ===');
    await stopTracing();
    console.log('Tracing stopped.');
  }
}

// Run the example
if (require.main === module) {
  exampleLLMApplication().catch(console.error);
}

export { exampleLLMApplication };
