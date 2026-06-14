# Quick Start Guide

Get started with the Traccia SDK in 5 minutes.

## Installation

```bash
npm install @traccia/sdk
```

## 1. Initialize Tracing

Add this to your application's entry point (e.g., `index.ts` or `app.ts`):

```typescript
import { Traccia } from '@traccia/sdk';

// Initialize tracing (defaults to OTLP export at http://localhost:4318/v1/traces)
// This will automatically load configuration from traccia.toml or environment variables
await Traccia.init();
```

## 2. Instrument Functions

The easiest way to trace your code is using the `@observe` decorator:

```typescript
import { observe } from '@traccia/sdk';

class UserService {
  @observe()
  async getUser(id: string) {
    // A span named "getUser" is automatically created
    return await db.findUser(id);
  }

  @observe({ type: 'llm' })
  async generateBio(user: any) {
    // Tracks tokens and costs automatically for LLM calls
    return await callLLM(user.prompt);
  }
}
```

## 3. Manual Tracing (Optional)

For fine-grained control, use the tracer directly:

```typescript
import { getTracer } from '@traccia/sdk';

const tracer = getTracer('my-app');

await tracer.startActiveSpan('manual-operation', async (span) => {
  try {
    span.setAttribute('user_id', '123');
    // ... do work ...
  } catch (err) {
    span.recordException(err as Error);
  } finally {
    span.end();
  }
});
```

## 4. Configuration

You can configure the SDK using environment variables or a `traccia.toml` file.

### Environment Variables

```bash
TRACCIA_API_KEY=your-key
TRACCIA_ENDPOINT=https://api.example.com/traces
TRACCIA_SAMPLE_RATE=1.0
TRACCIA_ENABLE_CONSOLE=true
```

### Identity Configuration

Define your agent's identity using the `AgentIdentity` model to automatically tag all emitted traces with canonical resource attributes:

```typescript
import { AgentIdentity } from '@traccia/sdk';

const identity = new AgentIdentity({
  id: 'my-agent-id',
  name: 'My Cool Agent',
  type: 'assistant',
  env: 'production'
});

// Pass this configuration when initializing your processors or tracer provider
```

## 5. Integrations

### LangChain

```typescript
import { TracciaCallbackHandler } from '@traccia/sdk/integrations';
import { ChatOpenAI } from '@langchain/openai';

const model = new ChatOpenAI({
  callbacks: [new TracciaCallbackHandler()],
});
```

## Next Steps

- Read the full [README.md](./README.md) for comprehensive documentation.
- See [examples/](./examples/) for complete sample applications.
