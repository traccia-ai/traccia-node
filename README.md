# Traccia SDK for Javascript/TypeScript

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![NPM Version](https://img.shields.io/npm/v/@traccia/sdk.svg?style=flat-square)](https://www.npmjs.com/package/@traccia/sdk)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg?style=flat-square)](https://www.typescriptlang.org/)
[![Socket Badge](https://badge.socket.dev/npm/package/@traccia/sdk)](https://badge.socket.dev/npm/package/@traccia/sdk)
[![Snyk](https://img.shields.io/badge/Snyk-0%20Vulnerabilities-success?style=flat-square&logo=snyk)](https://security.snyk.io/package/npm/%40traccia%2Fsdk)

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
- **Governance & Policies**: Trace evidence enrichment, `disclosure()`, lifecycle hooks, and runtime `govern()` policy enforcement.
- **Agent Identity**: Centralized configuration mapping to OTel resource attributes.
- **Prompt Management**: `loadPrompt` / `prefetchPrompts` with cache, stale-while-revalidate, fallback, and `traccia.prompt.*` span identity.

---

## Quick Start

### Installation

```bash
npm install @traccia/sdk
```

### Basic Usage

Initialize the SDK and trace your application functions using decorators.

```typescript
import { Traccia, observe } from '@traccia/sdk';

// Initialize (auto-loads from traccia.toml or env vars if present)
await Traccia.init();

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

### Load a versioned prompt

Fetch prompts from your Traccia library by name and deploy label. Compiling fills `{{variables}}` and stamps the active span with prompt identity.

```typescript
import { init, observe, loadPrompt, prefetchPrompts } from '@traccia/sdk';

await init({ apiKey: '...', promptCacheTtlS: 60 });
await prefetchPrompts(['support-reply']); // optional warm-up

const reply = observe({ type: 'llm' })(async (question: string) => {
  const prompt = await loadPrompt({
    name: 'support-reply',
    label: 'production',
    fallback: {
      type: 'chat',
      messages: [{ role: 'system', content: 'You are a helpful assistant.' }],
    },
  });
  const messages = prompt.compile({ question });
  // pass messages to your LLM client
  return messages;
});
```

Requires the [Traccia platform](https://app.traccia.ai): create a workspace API key under **Settings → API Keys**. Tracing and prompt fetch use the same key and default to `https://api.traccia.ai`. Pass an explicit `fallback` so agents can still run if a fetch fails. See [Prompts in the SDK](https://traccia.ai/docs/sdk/prompts).

### Integration with LLMs (LangChain)

Seamlessly integrate with LangChain to automatically track model usage, tokens, and latency.

```typescript
import { Traccia, observe } from '@traccia/sdk';
import { ChatOpenAI } from '@langchain/openai';
import { TracciaCallbackHandler } from '@traccia/sdk/integrations';

await Traccia.init();

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
# Endpoint URL for OTLP trace ingestion (Traccia platform default)
endpoint = "https://api.traccia.ai/v2/traces"

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
- `TRACCIA_ENDPOINT`: The OTLP endpoint (default: `https://api.traccia.ai/v2/traces`).
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

## Governance

### `observe()` vs `govern()`

| API | Purpose | Requires Traccia platform |
|-----|---------|----------------------------|
| `observe()` | Observability only | No |
| `govern()` | Observability + runtime policy enforcement | **Yes** |

`govern()` calls the Traccia agent-status API before each invocation. Tracing-only or self-hosted users should use `observe()`.

Policy URLs are derived from your tracing endpoint automatically — no `[governance]` section needed unless you use custom endpoints.

```typescript
import { Traccia, govern, AgentBlockedError } from '@traccia/sdk';

await Traccia.init({ apiKey: '...', endpoint: 'https://api.traccia.ai/v2/traces' });

const runAgent = govern({
  agentId: 'my-agent',
  failOpen: false,
  name: 'run_agent',
})(async (prompt: string) => {
  return callLlm(prompt);
});
```

**Advanced (optional):** override endpoints in `traccia.toml`:

```toml
[governance]
status_check_endpoint = "https://custom.example/agents/{agent_id}/status"
post_block_endpoint = "https://custom.example/agents/{agent_id}/blocks"
status_cache_ttl_seconds = 120
```

### Transparency — `disclosure()`

Record EU AI Act Art. 50 transparency evidence on the active span when your UI shows an AI disclosure:

```typescript
import { disclosure } from '@traccia/sdk';

disclosure({ channel: 'ui', disclosedToUser: true });
```

### HIPAA-oriented init

```ts
init({
  compliance: { frameworks: ['hipaa'] },
  redactPii: true, // recommended; defaults on when hipaa is in frameworks unless set false
});
```

Soft warnings only — Traccia does not block PHI. See [HIPAA docs](https://traccia.ai/docs/compliance/hipaa) and the [Trust Center](https://traccia.ai/trust-center). No signed BAA yet — contact [support@traccia.ai](mailto:support@traccia.ai).

---

## License

This project is licensed under the MIT License. See the [LICENSE](./LICENSE) file for details.
