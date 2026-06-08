# SDK Structure Summary

## Project Overview

This is a production-grade TypeScript SDK for distributed tracing in agent applications. It follows the same architectural patterns as the Python SDK but with optimizations and idioms specific to TypeScript/Node.js.

## Directory Structure

```
traccia-sdk-ts/
├── src/                              # Source code
│   ├── index.ts                     # Main SDK exports
│   ├── auto.ts                      # Auto-initialization helpers
│   ├── types.ts                     # Core type definitions
│   ├── tracer/                      # Tracer implementation
│   │   ├── index.ts
│   │   ├── span.ts                  # Span class with lifecycle
│   │   ├── span-context.ts          # Span context and validation
│   │   ├── tracer.ts                # Tracer for creating spans
│   │   └── provider.ts              # TracerProvider for management
│   ├── context/                     # Context management
│   │   └── context.ts               # AsyncLocalStorage-based context
│   ├── config/                      # Configuration
│   │   ├── runtime-config.ts        # Runtime state management
│   │   ├── env-config.ts            # Environment variable loading
│   │   └── pricing-config.ts        # Pricing table management
│   ├── exporter/                    # Span exporters
│   │   ├── index.ts
│   │   ├── http-exporter.ts         # HTTP with retry/backoff
│   │   └── console-exporter.ts      # Debug console output
│   ├── processor/                   # Span processors
│   │   ├── index.ts
│   │   ├── sampler.ts               # Probability-based sampling
│   │   ├── batch-processor.ts       # Batching and export
│   │   ├── token-counter.ts         # Token counting
│   │   ├── cost-processor.ts        # Cost calculation
│   │   └── logging-processor.ts     # Console logging
│   └── __tests__/                   # Test suite
│       ├── span.test.ts
│       ├── tracer.test.ts
│       ├── processor.test.ts
│       └── exporter.test.ts
├── examples/                         # Usage examples
│   ├── basic-usage.ts               # Complete walkthrough
│   └── custom-exporters.ts          # Custom extension examples
├── package.json                      # Dependencies and scripts
├── tsconfig.json                     # TypeScript configuration
├── jest.config.js                    # Jest configuration
├── .eslintrc.json                    # ESLint configuration
├── .prettierrc.json                  # Prettier configuration
├── .gitignore                        # Git ignore rules
├── README.md                         # User documentation
├── QUICKSTART.md                     # 5-minute quick start
├── DEVELOPER.md                      # Developer guide
├── CONTRIBUTING.md                   # Contribution guidelines
├── CHANGELOG.md                      # Release history
└── LICENSE                           # MIT License
```

## Core Modules

### 1. Tracer Module (`src/tracer/`)

**Purpose**: Create and manage spans

**Key Classes**:
- `TracerProvider`: Singleton managing tracers and processors
- `Tracer`: Creates spans with parent tracking
- `Span`: Unit of work with lifecycle management
- `SpanContext`: Trace/span ID container

**Key Methods**:
```typescript
tracer.startSpan(name, options)      // Create span
tracer.startActiveSpan(name, fn)     // Create active span with automatic parent
span.setAttribute(key, value)         // Set attributes
span.addEvent(name, attributes)       // Add events
span.recordException(error)           // Record exceptions
span.end()                           // End span
```

### 2. Context Module (`src/context/`)

**Purpose**: Automatic context propagation

**Key Features**:
- Uses `AsyncLocalStorage` for implicit parent tracking
- Automatic parent-child relationships
- No need for explicit parent passing in most cases

**Key Functions**:
```typescript
getCurrentSpan()                      // Get current span from context
setCurrentSpan(span)                 // Set current span
runWithSpan(span, fn)                // Run code with specific span
runWithSpanAsync(span, fn)           // Async variant
```

### 3. Configuration Module (`src/config/`)

**Purpose**: Configuration management

**Components**:
- `runtime-config.ts`: In-memory runtime configuration
- `env-config.ts`: Environment variable and .env loading
- `pricing-config.ts`: Pricing table management

**Key Functions**:
```typescript
loadEnvFile(path)                    // Load .env file
loadEnvConfig()                      // Load from environment variables
loadPricingWithSource()               // Load pricing with source tracking
getConfig()                          // Get current runtime config
updateConfig(partial)                 // Update runtime config
```

### 4. Exporter Module (`src/exporter/`)

**Purpose**: Send spans to backends

**Exporters**:
- `HttpExporter`: HTTP with retry/backoff logic
- `ConsoleExporter`: Debug output to console
- Custom exporters via `ISpanExporter` interface

**Features**:
- Automatic retry with exponential backoff
- Transient vs permanent failure detection
- Request timeout handling
- API key authentication

### 5. Processor Module (`src/processor/`)

**Purpose**: Process spans through a pipeline

**Processors**:
- `Sampler`: Probabilistic sampling (0.0 to 1.0)
- `TokenCountingProcessor`: Estimate tokens from text
- `CostAnnotatingProcessor`: Calculate costs from tokens
- `LoggingSpanProcessor`: Console logging
- `BatchSpanProcessor`: Batch and export

**Pattern**: Chain of processors, each enriches and processes spans

## Key Design Patterns

### 1. Provider Pattern
Global singleton for tracer management
```typescript
const provider = getTracerProvider();
const tracer = provider.getTracer('scope');
```

### 2. Processor Chain
Multiple processors in sequence
```typescript
provider.addSpanProcessor(new TokenCountingProcessor());
provider.addSpanProcessor(new CostAnnotatingProcessor(pricing));
provider.addSpanProcessor(new BatchSpanProcessor({ exporter }));
```

### 3. Context Propagation
Automatic parent-child via `AsyncLocalStorage`
```typescript
await tracer.startActiveSpan('parent', async () => {
  const child = tracer.startSpan('child');
  // child.parentSpanId === parent.spanId (automatic)
});
```

### 4. Graceful Degradation
Processors don't crash the system
```typescript
try {
  processor.onEnd(span);
} catch {
  // Swallow errors; resilience over strictness
}
```

## Configuration

### Via Environment Variables

```bash
AGENT_DASHBOARD_API_KEY=your-key
AGENT_DASHBOARD_ENDPOINT=https://api.example.com/traces
AGENT_DASHBOARD_SAMPLE_RATE=1.0
AGENT_DASHBOARD_PRICING_JSON='{"gpt-4":{"inputCost":0.03}}'
```

### Via .env File

```bash
# .env
AGENT_DASHBOARD_API_KEY=your-key
AGENT_DASHBOARD_ENDPOINT=https://api.example.com/traces
```

### Programmatic

```typescript
await startTracing({
  apiKey: 'key',
  endpoint: 'https://api.example.com/traces',
  sampleRate: 0.1,
  maxQueueSize: 5000,
  scheduleDelayMs: 5000,
  enableTokenCounting: true,
  enableCostTracking: true,
  sessionId: 'session-123',
  userId: 'user-456',
  tenantId: 'tenant-789',
  projectId: 'project-101',
  debug: false,
});
```

## Initialization Flow

```
startTracing(config)
  ├→ loadEnvFile()                    // Load .env if enabled
  ├→ loadEnvConfig()                  // Load from environment
  ├→ findAgentConfigPath()            // Locate agent config
  ├→ updateConfig()                   // Set runtime config
  ├→ getTracerProvider()              // Get or create provider
  ├→ setSampler()                     // Set sampling strategy
  ├→ Create HttpExporter              // Initialize exporter
  ├→ loadPricingWithSource()          // Load pricing tables
  ├→ addSpanProcessor(TokenCounter)   // Add processors in order
  ├→ addSpanProcessor(CostProcessor)
  ├→ addSpanProcessor(BatchProcessor)
  ├→ registerShutdown()               // Register SIGTERM/SIGINT
  └→ Return provider
```

## Export Flow

```
span.end()
  ├→ Set endTimeNs
  └→ provider.notifySpanEnd(span)
      └→ For each processor:
          ├→ TokenCountingProcessor.onEnd()
          ├→ CostAnnotatingProcessor.onEnd()
          └→ BatchSpanProcessor.onEnd()
              ├→ Enqueue span
              ├→ Check queue size
              └→ Trigger flush if needed
                  └→ Drain queue
                  └→ HttpExporter.export()
                      ├→ Serialize spans
                      ├→ Add headers
                      └→ POST with retry
```

## Testing

### Test Coverage

- Unit tests for all core modules
- Integration tests for processor chains
- Mock implementations for external dependencies
- >75% code coverage threshold

### Running Tests

```bash
npm test                    # Run all tests
npm test:watch            # Watch mode
npm test:cov              # Coverage report
npm test -- -t "pattern"  # Run specific tests
```

## Build and Publish

### Build

```bash
npm run build             # Compile TypeScript
npm run build:watch       # Watch mode
npm run clean            # Remove dist
```

### Quality Checks

```bash
npm run lint             # Check code style
npm run lint:fix         # Fix linting issues
npm run format          # Format with Prettier
npm test                # Run tests
```

### Publish to npm

```bash
npm version patch       # Bump version
npm publish            # Publish to npm
git tag v1.0.0        # Tag release
git push origin v1.0.0 # Push tag
```

## Performance Characteristics

### Span Creation
- O(1) time complexity
- ~100 bytes memory per span (baseline)

### Batching
- Configurable batch size (default 512)
- Configurable flush interval (default 5000ms)
- Background thread prevents blocking

### Memory
- Bounded queue with configurable max size (default 5000)
- Spans removed after export
- No memory leaks under normal operation

### Network
- HTTP with automatic retry (default 5 attempts)
- Exponential backoff with jitter
- Transient failure detection (429, 503, 504)
- Timeout handling (default 10s)

## Comparison with Python SDK

| Aspect | Python | TypeScript |
|--------|--------|-----------|
| **Runtime** | CPython 3.9+ | Node.js 16+ |
| **Context** | contextvars | AsyncLocalStorage |
| **Threading** | threading.Thread | setInterval |
| **ID Gen** | secrets.token_hex | crypto.randomBytes |
| **HTTP** | urllib + requests | Node.js https |
| **Testing** | pytest | Jest |
| **Type Safety** | typing | TypeScript strict |

## Future Enhancements

### v1.1.0
- OpenAI auto-instrumentation
- Anthropic auto-instrumentation
- Custom sampler interface

### v1.2.0
- LangChain integration
- W3C Trace Context headers
- Distributed tracing header propagation

### v2.0.0
- Browser/Edge support
- Worker thread support
- gRPC exporter
- OpenTelemetry compatibility

## Support and Contribution

- **Issues**: GitHub Issues tracker
- **Discussions**: GitHub Discussions
- **Contributing**: See CONTRIBUTING.md
- **License**: MIT

## Getting Started

1. **Install**: `npm install @traccia/sdk`
2. **Read**: [QUICKSTART.md](./QUICKSTART.md)
3. **Explore**: [examples/](./examples/)
4. **Develop**: [DEVELOPER.md](./DEVELOPER.md)
5. **Contribute**: [CONTRIBUTING.md](./CONTRIBUTING.md)
