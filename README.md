# Traccia SDK for Javascript/TypeScript

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![NPM Version](https://img.shields.io/npm/v/@traccia/sdk.svg?style=flat-square)](https://www.npmjs.com/package/@traccia/sdk)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg?style=flat-square)](https://www.typescriptlang.org/)

**Production-ready distributed tracing for AI agents and LLM applications**

Traccia is a lightweight, high-performance Javascript/TypeScript SDK for observability and tracing of AI agents, LLM applications, and complex distributed systems. Built on OpenTelemetry standards with specialized instrumentation for AI workloads.

---

## Features

- **Automatic Instrumentation**: Auto-patch OpenAI, Anthropic, LangChain support.
- **LLM-Aware Tracing**: Track tokens, costs, prompts, and completions automatically.
- **Zero-Config Start**: Simple `startTracing()` call with automatic config discovery.
- **Decorator-Based**: Trace any function with the `@observe` decorator.
- **Multiple Exporters**: OTLP (compatible with Grafana Tempo, Jaeger, Zipkin) and Console exporters.
- **Production-Ready**: Rate limiting, typed errors, config validation, robust flushing.
- **Type-Safe**: Full TypeScript support with `TracciaError` hierarchy.
- **High Performance**: Efficient batching, async support, minimal overhead.
- **W3C Trace Context**: Native distributed tracing header propagation.
- **Governance & Policies**: Lifecycle hooks for pre- and post-execution checks.
- **Agent Identity**: Centralized configuration mapping to OTel resource attributes.

---

## Quick Start

### Installation

```bash
npm install @traccia/sdk
```

### Basic Usage

Initialize the SDK and trace your application functions using decorators.

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

### Integration with LLMs (LangChain)

Seamlessly integrate with LangChain to automatically track model usage, tokens, and latency.

```typescript
import { startTracing, observe } from '@traccia/sdk';
import { ChatOpenAI } from '@langchain/openai';
import { TracciaCallbackHandler } from '@traccia/sdk/integrations';

await startTracing();

const model = new ChatOpenAI({
  modelName: 'gpt-4',
  callbacks: [new TracciaCallbackHandler()],
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

Create a `traccia.toml` file in your project root using the CLI:

```bash
npx traccia-ts config init
```

This creates a template config file with the following structure:

```toml
[tracing]
# Endpoint URL for OTLP trace ingestion
endpoint = "http://localhost:8000/v2/traces"

# Flush interval for batching spans (in ms)
flush_interval = 5000

# Maximum size of span batch before forced flush
batch_size = 512

[agent]
# Name of the agent emitting traces
name = "my-typescript-agent"

# Type of the agent (e.g., 'workflow', 'llm', 'retriever')
type = "workflow"

# Environment (e.g., 'development', 'staging', 'production')
env = "development"

# Project this agent belongs to
project = "my-default-project"

[integrations]
# Enable/disable specific integrations
langchain = true
openai = true
```

### Environment Variables

Configuration can also be provided via standard environment variables:

- `TRACCIA_API_KEY`: API Key for ingestion authentication.
- `TRACCIA_ENDPOINT`: The OTLP endpoint (e.g., `http://localhost:8000/v2/traces`).
- `TRACCIA_AGENT_NAME`: The name of the agent tracing execution.
- `TRACCIA_ENV`: The environment (e.g., `development`, `production`).

---

## Advanced Usage

### Custom Traces and Attributes

You can manually trace components and add custom business metrics to spans:

```typescript
import { trace } from '@opentelemetry/api';
import { observe } from '@traccia/sdk';

class DataPipeline {
  @observe({ type: 'retriever', name: 'fetch_user_data' })
  async fetchData(userId: string) {
    const activeSpan = trace.getActiveSpan();
    
    // Add custom business metrics
    activeSpan?.setAttribute('app.user.id', userId);
    activeSpan?.setAttribute('db.query.latency', 45);
    
    return { id: userId, status: 'active' };
  }
}
```

### Stopping the SDK

To ensure all queued telemetry data is successfully flushed to the backend before the process exits, invoke `stopTracing()`:

```typescript
import { stopTracing } from '@traccia/sdk';

// Flush buffered spans and shut down the provider safely
await stopTracing();
```

---

## License

This project is licensed under the MIT License. See the [LICENSE](./LICENSE) file for details.
