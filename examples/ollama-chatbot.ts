/**
 * Example: Using Ollama with LangChain and Traccia
 * 
 * This example shows how to use local Ollama models with LangChain
 * and get automatic tracing with Traccia.
 * 
 * Prerequisites:
 * 1. Install Ollama from https://ollama.ai
 * 2. Start Ollama: ollama serve
 * 3. Pull a model: ollama pull mistral
 * 
 * Run with:
 *   npm run build
 *   npx ts-node examples/ollama-chatbot.ts
 */

import { startTracing, stopTracing } from '../dist/index';
import {
  createOllamaChatbot,
  createOllamaStreamingChatbot,
  getOllamaSetupInstructions,
} from '../dist/integrations';

async function main() {
  console.log('🚀 Ollama Chatbot with Traccia Tracing\n');

  // Initialize tracing
  await startTracing({
    enableConsoleExporter: true,
    sessionId: 'ollama-demo-' + Date.now(),
    userId: 'demo-user',
    enableTokenCounting: false,
    enableCostTracking: false,
  });

  try {
    // Create a simple chatbot using Ollama
    console.log('📝 Creating Ollama chatbot...\n');
    const chatbot = await createOllamaChatbot({
      model: 'mistral',
      baseUrl: 'http://localhost:11434',
      systemPrompt: 'You are a helpful assistant.',
      temperature: 0.7,
    });

    // Have a conversation
    const queries = [
      'What is machine learning?',
      'Explain neural networks in simple terms',
    ];

    for (const query of queries) {
      console.log(`\n🧠 User: "${query}"`);
      try {
        const response = await chatbot(query);
        console.log(`\n🤖 Assistant: "${response}"\n`);
      } catch (error) {
        if ((error as Error).message.includes('ECONNREFUSED')) {
          console.error(
            '❌ Could not connect to Ollama. Make sure:'
          );
          console.error('   1. Ollama is installed: https://ollama.ai');
          console.error('   2. Ollama is running: ollama serve');
          console.error(
            '   3. A model is pulled: ollama pull mistral\n'
          );
          console.log(getOllamaSetupInstructions());
          break;
        }
        throw error;
      }
    }

    // Show streaming example
    console.log('\n📡 Streaming example (if Ollama supports it):\n');
    try {
      const streamingChatbot = await createOllamaStreamingChatbot({
        model: 'mistral',
        baseUrl: 'http://localhost:11434',
        systemPrompt: 'You are a creative writer.',
        onChunk: (chunk) => process.stdout.write(chunk),
      });

      console.log('User: Write a haiku about programming\n');
      await streamingChatbot('Write a haiku about programming');
      console.log('\n');
    } catch (error) {
      console.log(
        '(Streaming not available with this model)\n'
      );
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await stopTracing();
    console.log('\n✨ Demo complete! Check spans output above.');
  }
}

main().catch(console.error);
