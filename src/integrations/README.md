# Traccia SDK Integrations

Automatic instrumentation for popular frameworks and libraries. These integrations seamlessly add tracing to your applications without changing your code.

## Available Integrations

### LangChain Integration

Automatically trace LangChain agents, chains, and tools without any code changes.

#### Installation

```bash
npm install langchain @traccia/sdk
```

#### Usage

```typescript
import { ChatOpenAI } from 'langchain/chat_models/openai';
import { AgentExecutor, createOpenAIToolsAgent } from 'langchain/agents';
import { Tool } from '@langchain/core/tools';
import { TraciaCallbackHandler } from '@traccia/sdk/integrations/langchain-callback';

// Create your agent as usual
const tools = [/* your tools */];
const llm = new ChatOpenAI({ modelName: 'gpt-4' });

// Create Traccia callback handler
const traciaHandler = new TraciaCallbackHandler();

// Add callback to your chain/agent
const agent = await createOpenAIToolsAgent({ llm, tools, callbacks: [traciaHandler] });
const executor = new AgentExecutor({ agent, tools, callbacks: [traciaHandler] });

// Use as normal - fully traced!
const result = await executor.invoke({ input: 'What is 2+2?' });
```

#### Automatic Tracing Features

- **LLM Calls**: Captures model name, prompt length, completion tokens, total tokens
- **Chain Execution**: Traces chain start/end with chain name and execution time
- **Tool Usage**: Records tool invocations, inputs, and outputs
- **Agent Actions**: Captures agent decisions and reasoning steps
- **Error Handling**: Records exceptions and failures with full context
- **Nested Execution**: Automatically handles nested chains and tool calls through runId hierarchy

#### Span Hierarchy

Spans are automatically organized in a hierarchy:

```
agent-executor (root)
├── chain-1 (input processing)
│   └── llm-call (model inference)
├── tool-1 (tool execution)
│   └── api-call
└── chain-2 (final processing)
```

### LangGraph Integration

Automatic instrumentation for LangGraph state graphs and node execution.

#### Installation

```bash
npm install langraph @traccia/sdk
```

#### Usage - Option 1: Instrument Graph

```typescript
import { StateGraph } from '@langchain/langgraph';
import { instrumentLangGraph } from '@traccia/sdk/integrations/langgraph';

const graph = new StateGraph(AgentState)
  .addNode('agent', agentNode)
  .addNode('tools', toolsNode)
  .addEdge('agent', 'tools');

// Instrument for automatic tracing
const instrumentedGraph = instrumentLangGraph(graph, {
  graphName: 'my-agent-graph',
});

const compiled = instrumentedGraph.compile();

// Automatically traced!
await compiled.invoke({ messages: [] });
```

#### Usage - Option 2: Trace Individual Nodes

```typescript
import { createTracedNode } from '@traccia/sdk/integrations/langgraph';

const agentNode = createTracedNode('agent', async (state) => {
  // Your agent logic
  return { messages: [...state.messages, response] };
});

const toolsNode = createTracedNode('tools', async (state) => {
  // Your tool logic
  return { messages: [...state.messages, results] };
});

const graph = new StateGraph(AgentState)
  .addNode('agent', agentNode)
  .addNode('tools', toolsNode);
```

#### Usage - Option 3: Trace Conditionals

```typescript
import { createTracedConditional } from '@traccia/sdk/integrations/langgraph';

const shouldContinue = createTracedConditional('should_continue', (state) => {
  const messages = state.messages;
  if (messages[messages.length - 1].tool_calls) {
    return 'tools';
  }
  return 'end';
});

graph.addConditionalEdges('agent', shouldContinue);
```

#### Automatic Tracing Features

- **Graph Execution**: Root span for entire graph invocation
- **Streaming**: Traces streaming calls with event counts
- **Node Execution**: Individual spans for each node with execution context
- **Conditionals**: Records conditional routing decisions
- **Thread Context**: Captures thread_id for multi-turn conversations
- **Error Handling**: Records failures at any level with full stack traces

#### Span Hierarchy

```
langgraph-invoke (root)
├── node:agent
├── condition:should_continue
└── node:tools
```

## Configuration

Both integrations respect the standard Traccia SDK configuration through environment variables:

```bash
# Enable tracing
AGENT_DASHBOARD_ENABLED=true

# Set API endpoint and key (if using HTTP exporter)
AGENT_DASHBOARD_API_ENDPOINT=http://localhost:3000
AGENT_DASHBOARD_API_KEY=your-key

# Sampling and processing
AGENT_DASHBOARD_SAMPLE_RATE=1.0
AGENT_DASHBOARD_BATCH_SIZE=10
AGENT_DASHBOARD_BATCH_INTERVAL_MS=5000
```

See [Configuration Guide](../README.md#configuration) for all options.

## Error Handling

All integrations implement graceful error handling:

- Integration errors don't crash your application
- Failed spans are silently dropped if span system has issues
- Exceptions are recorded to spans with full context
- Stream/async processing continues on errors

## Performance Considerations

### Overhead

- **LangChain**: ~1-2ms per span creation (async, non-blocking)
- **LangGraph**: ~2-3ms per node execution overhead
- **Network**: Async batch export (configurable delays)

### Optimization Tips

1. **Increase Batch Size** for high-throughput apps:
   ```bash
   AGENT_DASHBOARD_BATCH_SIZE=100
   ```

2. **Use Sampling** to reduce data volume:
   ```bash
   AGENT_DASHBOARD_SAMPLE_RATE=0.1  # 10% sampling
   ```

3. **Disable Cost Tracking** if not needed:
   ```bash
   AGENT_DASHBOARD_ENABLE_COST_TRACKING=false
   ```

4. **Use Console Exporter** for development:
   ```typescript
   import { ConsoleExporter } from '@traccia/sdk';
   // No network overhead
   ```

## Testing

When testing applications with integrations, consider:

```typescript
import { ConsoleExporter } from '@traccia/sdk';
import { startTracing } from '@traccia/sdk';

// In test setup
startTracing({
  exporters: [new ConsoleExporter()],  // Avoid network calls
  enableTokenCounting: false,           // Skip token count overhead
});

// Your tests run with tracing enabled but no external calls
```

## Best Practices

1. **Initialize Before Creating Tools/Agents**:
   ```typescript
   // ✅ Good
   startTracing({ /* config */ });
   const llm = new ChatOpenAI();
   const handler = new TraciaCallbackHandler();

   // ❌ Avoid
   const llm = new ChatOpenAI();
   startTracing();
   ```

2. **Reuse Handler Instances**:
   ```typescript
   // ✅ Good - one handler for all chains
   const handler = new TraciaCallbackHandler();
   const executor1 = new AgentExecutor({ callbacks: [handler] });
   const executor2 = new AgentExecutor({ callbacks: [handler] });

   // ❌ Avoid - new handler for each (more overhead)
   const executor1 = new AgentExecutor({ callbacks: [new TraciaCallbackHandler()] });
   ```

3. **Use Graph Instrumentation Over Node Wrapping** (when possible):
   ```typescript
   // ✅ Good - cleaner API
   const graph = instrumentLangGraph(graph);

   // ✅ Also good - when you need fine-grained control
   const agentNode = createTracedNode('agent', func);
   ```

4. **Capture Domain-Specific Attributes**:
   ```typescript
   // Extend with custom metadata
   const handler = new TraciaCallbackHandler();
   // (Future: custom span enrichment support)
   ```

## Limitations & Known Issues

- **LangChain**: Requires langchain ≥ 0.1.0 (callback system)
- **LangGraph**: Works with compiled graphs; streaming has event-level tracking
- **Context Propagation**: Traces are linked through runId hierarchy; distributed tracing requires parent trace context

## Contributing

To add new integrations:

1. Create `src/integrations/{framework}-instrumentation.ts`
2. Export in `src/integrations/index.ts`
3. Add usage documentation here
4. Submit PR with tests and examples

## Support

For issues or questions:

- 📖 [Main README](../README.md)
- 🐛 [GitHub Issues](https://github.com/stratumtech/traccia-sdk)
- 💬 [Discussions](https://github.com/stratumtech/traccia-sdk/discussions)
