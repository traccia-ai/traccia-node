/**
 * Example: Ollama with LangGraph and Traccia
 * 
 * This example shows how to build an agentic workflow with local Ollama models
 * using LangGraph, with automatic distributed tracing.
 * 
 * Prerequisites:
 * 1. Install Ollama from https://ollama.ai
 * 2. Start Ollama: ollama serve
 * 3. Pull a model: ollama pull mistral
 * 
 * Run with:
 *   npm run build
 *   npx ts-node examples/ollama-langgraph-agent.ts
 */

import { startTracing, stopTracing } from '../dist/index';
import {
  createAgentWorkflow,
  traceableFunction,
} from '../dist/integrations';
import {
  createOllamaWithTracing,
  getOllamaSetupInstructions,
} from '../dist/integrations';

// Define our agent's state
interface AgentState {
  input: string;
  context?: string;
  analysis?: string;
  decision?: string;
  result?: string;
}

async function main() {
  console.log('🚀 Ollama LangGraph Agent with Traccia Tracing\n');

  // Initialize tracing
  await startTracing({
    enableConsoleExporter: true,
    sessionId: 'ollama-langgraph-' + Date.now(),
    userId: 'demo-user',
    enableTokenCounting: false,
    enableCostTracking: false,
  });

  try {
    // Create the Ollama model
    console.log('📝 Creating Ollama model...\n');
    let model: any;
    try {
      model = await createOllamaWithTracing({
        model: 'mistral',
        baseUrl: 'http://localhost:11434',
        temperature: 0.7,
      });
    } catch (error) {
      console.error(
        '❌ Could not connect to Ollama. Make sure:'
      );
      console.error('   1. Ollama is installed: https://ollama.ai');
      console.error('   2. Ollama is running: ollama serve');
      console.error('   3. A model is pulled: ollama pull mistral\n');
      console.log(getOllamaSetupInstructions());
      return;
    }

    // Create traced workflow functions
    const analyzeInput = traceableFunction(
      'analyze-input',
      async (state: AgentState) => {
        const response = await model.invoke({
          input: `Analyze this input briefly: "${state.input}"\nProvide a 1-2 sentence analysis.`,
        });
        return { ...state, analysis: response };
      }
    );

    const makeDecision = traceableFunction(
      'make-decision',
      async (state: AgentState) => {
        const response = await model.invoke({
          input: `Based on this analysis: "${state.analysis}"\n\nIs this a simple question or complex query? Answer with just "simple" or "complex".`,
        });
        const decision = response.toLowerCase().includes('simple')
          ? 'simple'
          : 'complex';
        return { ...state, decision };
      }
    );

    const generateResponse = traceableFunction(
      'generate-response',
      async (state: AgentState) => {
        const prompt =
          state.decision === 'simple'
            ? `Answer this question simply: "${state.input}"\nKeep it brief (1-2 sentences).`
            : `Provide a detailed explanation for: "${state.input}"\nInclude relevant context and examples.`;

        const response = await model.invoke({ input: prompt });
        return { ...state, result: response };
      }
    );

    // Create the agent workflow
    console.log('🔧 Setting up agent workflow...\n');
    const graph = await createAgentWorkflow({
      processInput: analyzeInput,
      routeDecision: (state: AgentState) => {
        return state.decision === 'simple' ? 'done' : 'review';
      },
      reviewStep: makeDecision,
      finalStep: generateResponse,
    });

    // Compile the graph
    const compiled = graph.compile();

    // Test queries
    const queries = [
      'What is the capital of France?',
      'Explain how neural networks learn patterns in data',
    ];

    for (const query of queries) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`\n🧠 User Query: "${query}"\n`);

      try {
        const result = await compiled.invoke({ input: query });
        console.log(`\n🤖 Agent Response:\n${result.result}\n`);
        console.log(`Decision: ${result.decision}`);
      } catch (error) {
        console.error(
          'Error processing query:',
          (error as Error).message
        );
      }
    }

    console.log(`\n${'='.repeat(60)}\n`);
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await stopTracing();
    console.log('✨ Demo complete! Check spans output above.');
  }
}

main().catch(console.error);
