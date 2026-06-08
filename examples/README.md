# Traccia SDK Examples

This directory contains example applications demonstrating how to use the Traccia SDK for tracing AI agents and applications.

## Examples

### 1. Basic Usage (`basic-usage.ts`)

Simple example showing how to initialize the SDK and create spans.

```bash
npx ts-node examples/basic-usage.ts
```

**Features:**
- Basic span creation and lifecycle
- Automatic token counting
- HTTP exporter configuration

### 2. Custom Exporters (`custom-exporters.ts`)

Demonstrates how to create and use custom exporters.

```bash
npx ts-node examples/custom-exporters.ts
```

**Features:**
- Custom file-based exporter implementation
- Span serialization
- Error handling in exporters

### 3. Debug Agent with Visible Spans (`debug-agent.ts`) ⭐ **START HERE**

A simple agent that manually logs spans so you can see the tracing in action.

```bash
npm run build
npx ts-node examples/debug-agent.ts
```

**Features:**
- Clear console output showing each span
- Demonstrates span creation and end events
- Shows span attributes and duration
- Perfect for understanding span hierarchy

**Output Example:**
```
=== Span ===
Name: llm-call
Duration: 201ms
Attributes: {
  model: 'gpt-4',
  input: 'What is the weather?',
  output: 'use_weather_tool'
}
```

### 4. Fake AI Agent (`fake-agent.ts`)

A mock AI agent that simulates real agent behavior with tools.

```bash
npm run build
npx ts-node examples/fake-agent.ts
```

**Features:**
- Simulated LLM decision making
- Tool execution (weather, calculator, search)
- Span hierarchy (agent → tool → LLM)
- Conversation history tracking

### 5. Fake AI Agent with Spans (`fake-agent-with-spans.ts`)

Enhanced version of fake agent with aggressive span flushing for better visibility.

```bash
npm run build
npx ts-node examples/fake-agent-with-spans.ts
```

**Features:**
- All features from fake-agent.ts
- Batch size 1 for immediate span export
- Short export intervals
- Console span logging enabled

### 6. Agent with Callbacks (`agent-with-callbacks.ts`)

Advanced example showing callback-based instrumentation pattern.

```bash
npm run build
npx ts-node examples/agent-with-callbacks.ts
```

**Features:**
- Custom callback handlers for agent lifecycle events
- Token count tracking
- LLM response tracking
- Fine-grained span organization
- Error handling with span exceptions

**Callback Events:**
- `onAgentStart` - Agent begins processing
- `onAgentAction` - Agent takes an action
- `onAgentEnd` - Agent completes
- `onChainStart`/`onChainEnd` - Chain execution
- `onLLMStart`/`onLLMEnd` - LLM invocation
- `onError` - Error occurred

## Seeing Span Output

### Method 1: Manual Span Logging (Recommended for Development)

Use the debug-agent.ts example which manually logs spans as they complete:

```bash
npx ts-node examples/debug-agent.ts
```

This shows:
- ✅ Clear console output
- ✅ Span name, duration, and attributes
- ✅ Easy to understand format
- ✅ No configuration needed

**Output:**
```
=== Span ===
Name: llm-call
Duration: 201ms
Attributes: { model: 'gpt-4', ... }
```

### Method 2: Console Exporter (Automatic Export)

Enable console exporter in your code:

```typescript
startTracing({
  enableConsoleExporter: true,
  maxExportBatchSize: 1,      // Export immediately
  scheduleDelayMs: 100,        // Fast flushing
  enableSpanLogging: true,     // Enable logging processor
});
```

This exports spans automatically but requires configuration tweaking for visibility.

### Method 3: HTTP Export (Production)

For real applications, export to a backend:

```typescript
startTracing({
  apiKey: process.env.AGENT_DASHBOARD_API_KEY,
  endpoint: process.env.AGENT_DASHBOARD_API_ENDPOINT,
});
```

Spans are sent to your observability backend for dashboards and analytics.

## Tracing Architecture

### Span Hierarchy Example

```
agent-run (root)
├─ agent-thinking (step 1)
├─ llm-decision (LLM choosing tool)
├─ tool-use:weather (executing weather tool)
├─ response-generation (final response)
└─ agent-end
```

### Attributes Example

Each span can have attributes that provide context:

```typescript
const span = tracer.startSpan('my-span', {
  attributes: {
    user_id: 'user-123',
    input_length: 150,
    tool_name: 'weather_api',
  }
});
```

## Integration with Real Agents

To use Traccia with real LangChain agents:

```typescript
import { TraciaCallbackHandler } from '@traccia/sdk/integrations/langchain-callback';
import { LLMChain } from 'langchain/chains';

const handler = new TraciaCallbackHandler();
const chain = new LLMChain({
  llm: new ChatOpenAI(),
  callbacks: [handler],
});

// Now all LLM calls and chains are automatically traced!
await chain.run({ input: 'What is 2+2?' });
```

## Key Concepts

### Span Lifecycle

1. **Create** - `tracer.startSpan(name, { attributes })`
2. **Update** - `span.setAttribute(key, value)`
3. **Record Exceptions** - `span.recordException(error)`
4. **End** - `span.end()`

### Attributes

- Should be JSON-serializable
- Useful for filtering and analytics
- Examples: user_id, model_name, input_length, tool_name

### Span Hierarchy

- Spans created inside other spans are child spans
- Parent-child relationships are automatic via AsyncLocalStorage
- Used for tracing nested operations

## Testing Tracing

To verify tracing is working:

1. Run examples with `enableConsoleExporter: true`
2. Check console output for `[Span]` entries
3. Verify span names, durations, and attributes

## Next Steps

- **Real Agent**: Replace fake agent with actual LangChain agent
- **HTTP Export**: Configure HTTP exporter to send spans to Agent Dashboard
- **Token Counting**: Enable `enableTokenCounting` for LLM token tracking
- **Cost Tracking**: Enable `enableCostTracking` with pricing overrides

## Troubleshooting

**No spans appearing in console:**
- Verify `enableConsoleExporter: true` is set
- Check that `span.end()` is being called
- Look for errors in stderr output

**Spans not hierarchical:**
- Ensure spans are created/ended in proper nested order
- SDK uses AsyncLocalStorage for context propagation

**Missing attributes:**
- Attributes must be set before `span.end()`
- Check attribute values are JSON-serializable
