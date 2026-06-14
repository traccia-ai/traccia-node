# Traccia SDK for Javascript/TypeScript

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![NPM Version](https://img.shields.io/npm/v/@traccia/sdk.svg?style=flat-square)](https://www.npmjs.com/package/@traccia/sdk)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg?style=flat-square)](https://www.typescriptlang.org/)

**Production-ready distributed tracing for AI agents and LLM applications**

Traccia is a lightweight, high-performance Javascript/TypeScript SDK for observability and tracing of AI agents, LLM applications, and complex distributed systems. Built on OpenTelemetry standards with specialized instrumentation for AI workloads.

---

## Features

- **Automatic Instrumentation**: Auto-patch OpenAI, Anthropic, LangChain support
- **LLM-Aware Tracing**: Track tokens, costs, prompts, and completions automatically
- **Zero-Config Start**: Simple `startTracing()` call with automatic config discovery
- **Decorator-Based**: Trace any function with `@observe` decorator
- **Multiple Exporters**: OTLP (compatible with Grafana Tempo, Jaeger, Zipkin), Console (for debugging)
- **Production-Ready**: Rate limiting, typed errors, config validation, robust flushing
- **Type-Safe**: Full TypeScript support with `TracciaError` hierarchy
- **High Performance**: Efficient batching, async support, minimal overhead
- **W3C Trace Context**: Native distributed tracing header propagation
- **Governance & Policies**: Lifecycle hooks for pre/post execution checks
- **Agent Identity**: Centralized configuration mapping to OTel resource attributes

---

## Quick Start

### Installation

```bash
npm install @traccia/sdk
```

### Basic Usage

```typescript
import { startTracing, observe } from '@traccia/sdk';

// Initialize (auto-loads from traccia.toml or env vars if present)
await startTracing();

// Trace any function
class Service {
  @observe()
  async doWork(input: string) {
    return `Processed: ${input}`;
  }
}

const service = new Service();
await service.doWork('hello');
```

### With LLM Calls

```typescript
import { startTracing, observe } from '@traccia/sdk';
import { ChatOpenAI } from '@langchain/openai';
import { TracciaCallbackHandler } from '@traccia/sdk/integrations';

await startTracing();

const model = new ChatOpenAI({
  modelName: 'gpt-4',
  callbacks: [new TracciaCallbackHandler()], // Seamless integration
});

@observe({ type: 'llm' })
async function generateText(prompt: string) {
  const res = await model.invoke(prompt);
  return res.content;
}

// Automatically tracks: model, tokens, cost, prompt, completion, latency
const text = await generateText("Write a haiku about TypeScript");
```

---

## Configuration

### Configuration File

Create a `traccia.toml` file in your project root:

```bash
npx traccia-ts config init
```

This creates a template config file:

```toml
[tracing]
# API key (optional - for future Traccia UI, not needed for OTLP backends)
api_key = ""

# Endpoint URL for OTLP trace ingestion
# Works with Grafana Tempo, Jaeger, Zipkin, and other OTLP-compatible backends
endpoint = "http://localhost:4318/v1/traces"

sample_rate = 1.0           # 0.0 to 1.0
use_otlp = true             # Use OTLP exporter

[exporters]
# Only enable ONE exporter at a time
enable_console = false        # Print traces to console

[instrumentation]
enable_token_counting = true    # Count tokens for LLM calls
enable_costs = true             # Calculate costs
```

### Environment Variables

All config parameters can be set via environment variables with the `TRACCIA_` prefix:

-   **Tracing**: `TRACCIA_API_KEY`, `TRACCIA_ENDPOINT`, `TRACCIA_SAMPLE_RATE`
-   **Exporters**: `TRACCIA_ENABLE_CONSOLE`
-   **Instrumentation**: `TRACCIA_ENABLE_TOKEN_COUNTING`, `TRACCIA_ENABLE_COSTS`

**Priority**: Explicit parameters > Environment variables > Config file > Defaults

---

## Usage Guide

### The `@observe` Decorator

The `@observe` decorator is the primary way to instrument your code:

```typescript
import { observe } from '@traccia/sdk';

class DataService {
  // Basic usage
  @observe()
  async processData(data: any) {
    return transform(data);
  }

  // Custom span name and attributes
  @observe({ 
    name: 'data_pipeline',
    attributes: { version: '2.0', env: 'prod' }
  })
  async processPipeline(data: any) {
    return transform(data);
  }

  // Specify span type (llm, tool, span)
  @observe({ type: 'llm' })
  async callLLM() {
    // ...
  }
}
```

### Manual Span Creation

For more control, create spans manually:

```typescript
import { getTracer } from '@traccia/sdk';

const tracer = getTracer('my-service');

await tracer.startActiveSpan('manual-operation', async (span) => {
  try {
    span.setAttribute('user_id', '123');
    // ... do work ...
  } catch (err) {
    span.recordException(err as Error);
    throw err;
  } finally {
    span.end();
  }
});
```

### Accessing Active Span

You can access the current span within an `@observe` decorated function using `getCurrentSpan`.

```typescript
import { observe, getCurrentSpan } from '@traccia/sdk';

@observe()
async function sensitiveOperation() {
  const span = getCurrentSpan();
  
  if (span) {
    span.addEvent('milestone_reached');
    span.setAttribute('dynamic_flag', true);
  }
}
```

---

## Integrations

### LangChain

The SDK provides a `TracciaCallbackHandler` for seamless integration with LangChain.

```typescript
import { TracciaCallbackHandler } from '@traccia/sdk/integrations';
import { ChatOpenAI } from '@langchain/openai';

const model = new ChatOpenAI({
  callbacks: [new TracciaCallbackHandler()],
});
```

### LangGraph

For LangGraph, use the `instrumentLangGraph` utility:

```typescript
import { instrumentLangGraph } from '@traccia/sdk/integrations/langgraph-instrumentation';

const graph = new StateGraph({ ... });
// ... define graph ...

const instrumentedApp = instrumentLangGraph(app, {
    traceGraphExecution: true,
    traceNodeExecution: true,
});
```

---

## Auto-Instrumentation

### OpenAI / Anthropic

```typescript
import { patchOpenAI, patchAnthropic } from '@traccia/sdk';

// Patch globally (monkey-patches the SDK)
patchOpenAI();
patchAnthropic();

// Or wrap specific calls
import { wrapOpenAICreate } from '@traccia/sdk';
const tracedCreate = wrapOpenAICreate(client.chat.completions.create, client);
```

### HTTP Clients

```typescript
import { patchAxios, patchFetch, createTracedFetch } from '@traccia/sdk';

// Global patching
patchAxios();   // Adds interceptors to axios
patchFetch();   // Patches globalThis.fetch

// Or create traced instances
const tracedFetch = createTracedFetch();
```

---

## Framework Middleware

### Express

```typescript
import express from 'express';
import { expressMiddleware, expressErrorMiddleware } from '@traccia/sdk';

const app = express();
app.use(expressMiddleware({ ignorePaths: ['/health'] }));
app.use(expressErrorMiddleware()); // Add after routes
```

### Fastify

```typescript
import fastify from 'fastify';
import { fastifyPlugin } from '@traccia/sdk';

const app = fastify();
app.register(fastifyPlugin({ ignorePaths: ['/health'] }));
```

---

## Advanced Features

### Agent Enrichment & Identity

You can define a centralized agent identity that maps directly to OpenTelemetry resource attributes.

```typescript
import { AgentIdentity, AgentEnrichmentProcessor } from '@traccia/sdk';

// Standardized identity mapping
const identity = new AgentIdentity({
  id: 'agent-42',
  name: 'SupportBot',
  type: 'workflow',
  env: 'production',
  project: 'customer-success'
});

const processor = new AgentEnrichmentProcessor({
  agentConfigPath: 'agent_config.json', // Still supported
  defaultEnv: 'production',
});
```

### Governance Hooks

Implement lifecycle hooks for dynamic policy enforcement, redaction, or moderation:

```typescript
import { GovernanceManager } from '@traccia/sdk';

const manager = new GovernanceManager();

manager.registerHooks({
  onBeforeExecute: (span, schema) => {
    if (schema.input.includes('PII')) {
      throw new Error('PII detected in input');
    }
  },
  onAfterExecute: (span, schema, result) => {
    // Validate output or enrich span
    span.setAttribute('governance.checked', true);
  }
});
```

### File Exporter

```typescript
import { FileExporter } from '@traccia/sdk';

const exporter = new FileExporter({
  filePath: 'traces.jsonl',
  resetOnStart: true,  // Clear file on first export
});
```

### Rate Limiting

```typescript
import { RateLimitingSpanProcessor } from '@traccia/sdk';

const processor = new RateLimitingSpanProcessor({
  maxSpansPerSecond: 100,
  maxBlockMs: 50,
  nextProcessor: batchProcessor,
});
```

---

## Contributing

Contributions are welcome! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

---

## License

Apache 2.0 - see [LICENSE](LICENSE) for details
