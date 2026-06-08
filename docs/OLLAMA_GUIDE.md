# Ollama Integration Guide

Complete guide to using Ollama with Traccia for automatic tracing of local LLM applications.

## Why Ollama?

✅ **Run LLMs locally** - No API keys, no cloud costs
✅ **Privacy** - Everything stays on your machine
✅ **Fast iteration** - Instant access to models
✅ **Cost-effective** - Pay once for hardware, use forever
✅ **Fully traceable** - Works with Traccia for observability

## Installation

### 1. Install Ollama

- **macOS**: https://ollama.ai/download/Ollama-darwin.zip
- **Windows**: https://ollama.ai/download/OllamaSetup.exe
- **Linux**: `curl https://ollama.ai/install.sh | sh`

### 2. Start Ollama

```bash
ollama serve
```

This starts Ollama on `http://localhost:11434`

### 3. Pull a Model

In another terminal:

```bash
ollama pull mistral      # Recommended - fastest 7B
ollama pull llama2       # Meta's Llama 2
ollama pull neural-chat  # Best for conversations
```

### 4. Use with Traccia

```typescript
import { startTracing } from '@traccia/sdk';
import { createOllamaChatbot } from '@traccia/sdk/integrations';

await startTracing();

const chatbot = await createOllamaChatbot({
  model: 'mistral',
});

const response = await chatbot('Hello!');
// Automatically traced!
```

## Quick Examples

### Simple Chatbot

```typescript
import { createOllamaChatbot } from '@traccia/sdk/integrations';

const chatbot = await createOllamaChatbot({
  model: 'mistral',
  systemPrompt: 'You are a helpful assistant.',
  temperature: 0.7,
});

const response = await chatbot('What is machine learning?');
console.log(response);
```

### Streaming Responses

```typescript
import { createOllamaStreamingChatbot } from '@traccia/sdk/integrations';

const chatbot = await createOllamaStreamingChatbot({
  model: 'mistral',
  onChunk: (chunk) => process.stdout.write(chunk),
});

await chatbot('Tell me a story');
// Output streams in real-time!
```

### LangChain Integration

```typescript
import { createOllamaWithTracing } from '@traccia/sdk/integrations';

const model = await createOllamaWithTracing({
  model: 'mistral',
  baseUrl: 'http://localhost:11434',
  temperature: 0.7,
});

// Use with LangChain normally
const response = await model.invoke({ input: 'Hello!' });
// Automatically traced!
```

### LangGraph Workflow

```typescript
import { createAgentWorkflow, traceableFunction } from '@traccia/sdk/integrations';
import { createOllamaWithTracing } from '@traccia/sdk/integrations';

const model = await createOllamaWithTracing({ model: 'mistral' });

const processInput = traceableFunction('process', async (state) => {
  const response = await model.invoke({ input: state.input });
  return { ...state, result: response };
});

const graph = await createAgentWorkflow({
  processInput,
  routeDecision: (state) => 'done',
});

const result = await graph.compile().invoke({ input: 'Hello' });
// Full workflow traced with spans!
```

## Available Models

### Recommended (Fast & Good Quality)

| Model | Size | Speed | Quality | Best For |
|-------|------|-------|---------|----------|
| **mistral** | 5.4GB | ⚡⚡⚡ | ⭐⭐⭐ | General use, speed |
| **neural-chat** | 3.8GB | ⚡⚡⚡ | ⭐⭐⭐ | Conversations |
| **orca-mini** | 1.5GB | ⚡⚡⚡⚡ | ⭐⭐ | Fast responses |

### Versatile Models

| Model | Size | Speed | Quality | Best For |
|-------|------|-------|---------|----------|
| **llama2** | 3.8GB | ⚡⚡⚡ | ⭐⭐⭐ | General purpose |
| **opencodeup** | 3.5GB | ⚡⚡⚡ | ⭐⭐⭐ | Code generation |

### High Quality (Larger)

| Model | Size | Speed | Quality | Best For |
|-------|------|-------|---------|----------|
| **dolphin-mixtral** | 26GB | ⚡⚡ | ⭐⭐⭐⭐ | Complex tasks |

## Performance Tips

### 1. Choose the Right Model

```typescript
// For speed (minimum hardware)
const chatbot = await createOllamaChatbot({ model: 'orca-mini' });

// For balance (recommended)
const chatbot = await createOllamaChatbot({ model: 'mistral' });

// For quality (GPU recommended)
const chatbot = await createOllamaChatbot({ model: 'dolphin-mixtral' });
```

### 2. Adjust Temperature

```typescript
// Lower = More deterministic
const model = await createOllamaWithTracing({
  model: 'mistral',
  temperature: 0.1,  // Factual, consistent
});

// Higher = More creative
const model = await createOllamaWithTracing({
  model: 'mistral',
  temperature: 1.0,  // Creative, varied
});
```

### 3. Use Streaming for Long Responses

```typescript
// Better UX - shows response as it's generated
const chatbot = await createOllamaStreamingChatbot({
  model: 'mistral',
  onChunk: (chunk) => process.stdout.write(chunk),
});

await chatbot('Write a long essay about AI');
```

### 4. Batch Requests

```typescript
// For multiple queries, reuse the model
const model = await createOllamaWithTracing({ model: 'mistral' });

for (const query of queries) {
  const response = await model.invoke({ input: query });
  // All requests traced in one session
}
```

## Tracing Features

All Ollama requests are automatically traced with:

```typescript
{
  'model': 'mistral',           // Model name
  'input_length': 42,           // Character count
  'output_length': 156,         // Response length
  'latency_ms': 2341,           // Time taken
  'success': true,              // Completion status
  'error_type': null,           // Error info if failed
  'streaming': false,           // Streaming or regular
}
```

## Troubleshooting

### Connection Error

```
Error: connect ECONNREFUSED 127.0.0.1:11434
```

**Solution:**
```bash
# Make sure Ollama is running
ollama serve
```

### Model Not Found

```
Error: model 'mistral' not found
```

**Solution:**
```bash
# Download the model
ollama pull mistral
```

### Out of Memory

```
Error: ggml_cuda_malloc: out of memory
```

**Solutions:**
1. Use a smaller model: `ollama pull orca-mini`
2. Add more RAM
3. Enable GPU acceleration (see Ollama docs)

### Slow Responses

**Solutions:**
1. Check if Ollama process is running
2. Use a faster model: `mistral` > `llama2` > `dolphin-mixtral`
3. Reduce temperature: `temperature: 0.1`
4. Check system resources

## Production Considerations

### 1. Environment Variables

```bash
OLLAMA_HOST=0.0.0.0:11434  # Accept remote connections
OLLAMA_KEEP_ALIVE=5m       # Keep model in memory
```

### 2. Monitoring

```typescript
import { setupLangChainWithTracing } from '@traccia/sdk/integrations';

// All Ollama calls are traced
const { model } = await setupOllamaWithTracing({
  model: 'mistral',
});

// Monitor via Traccia dashboard
```

### 3. Error Handling

```typescript
try {
  const response = await chatbot('query');
} catch (error) {
  if (error.message.includes('ECONNREFUSED')) {
    console.error('Ollama not running');
  } else if (error.message.includes('not found')) {
    console.error('Model not downloaded');
  } else {
    console.error('Other error:', error);
  }
}
```

### 4. Logging

```typescript
// Enable detailed logging
await startTracing({
  enableSpanLogging: true,
  enableConsoleExporter: true,
});
```

## Next Steps

- Explore more models: https://ollama.ai/library
- Learn LangChain: https://docs.langchain.com
- Learn LangGraph: https://langchain-ai.github.io/langgraph
- Traccia docs: See main README.md
