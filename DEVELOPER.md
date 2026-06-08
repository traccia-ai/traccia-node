# Developer Guide

This guide is for developers working on the Traccia SDK for TypeScript.

## Project Structure

```
src/
├── types.ts                 # Core type definitions and interfaces
├── index.ts                # Main SDK exports
├── auto.ts                 # SDK initialization and global tracer setup
├── tracer/
│   ├── index.ts           # Tracer module exports
│   ├── span.ts            # Span implementation
│   ├── span-context.ts    # SpanContext implementation
│   ├── tracer.ts          # Tracer implementation
│   └── provider.ts        # TracerProvider implementation
├── context/
│   └── context.ts         # AsyncLocalStorage-based context management
├── config/
│   ├── runtime-config.ts  # Runtime configuration state
│   ├── env-config.ts      # Environment variable loading
│   └── pricing-config.ts  # Pricing table management
├── exporter/
│   ├── http-exporter.ts   # HTTP span exporter
│   ├── console-exporter.ts # Console debugging exporter
│   └── index.ts           # Exporter module exports
├── processor/
│   ├── sampler.ts         # Probability-based sampler
│   ├── batch-processor.ts # Batching and export processor
│   ├── token-counter.ts   # Token counting processor
│   ├── cost-processor.ts  # Cost calculation processor
│   ├── logging-processor.ts # Console logging processor
│   └── index.ts           # Processor module exports
└── __tests__/
    ├── span.test.ts       # Span tests
    ├── tracer.test.ts     # Tracer tests
    ├── processor.test.ts  # Processor tests
    └── exporter.test.ts   # Exporter tests
```

## Architecture

### Core Concepts

1. **Tracer Provider**: Manages tracers and processors
2. **Tracer**: Creates and manages spans
3. **Span**: Represents a unit of work
4. **Span Context**: Carries trace/span IDs across boundaries
5. **Span Processor**: Processes spans at lifecycle events
6. **Span Exporter**: Sends spans to backends

### Flow

```
Span Created
    ↓
Span Updated (attributes, events)
    ↓
Span Ended
    ↓
Processors Notified (onEnd)
    ├→ Token Counting
    ├→ Cost Calculation
    └→ Batch Processor
        ↓
    Queue Management
        ↓
    HTTP Export (with retry)
```

### Context Management

The SDK uses Node.js `AsyncLocalStorage` for automatic context propagation:

```typescript
// Parent span context is automatically available
await tracer.startActiveSpan('parent', async () => {
  // Child spans automatically inherit parent context
  const child = tracer.startSpan('child');
  // child.parentSpanId === parent.context.spanId
});
```

## Development Workflow

### Setup

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Watch mode
npm run build:watch
```

### Testing

```bash
# Run all tests
npm test

# Watch mode
npm test:watch

# Coverage report
npm test:cov
```

### Code Quality

```bash
# Lint code
npm run lint

# Fix linting issues
npm run lint:fix

# Format code
npm run format
```

## Key Design Patterns

### 1. Provider Pattern

```typescript
// Singleton pattern for global state
const provider = getTracerProvider();
const tracer = provider.getTracer('scope');
```

### 2. Processor Chain

```typescript
// Chain of responsibility for span processing
provider.addSpanProcessor(new TokenCountingProcessor());
provider.addSpanProcessor(new CostAnnotatingProcessor(pricing));
provider.addSpanProcessor(new BatchSpanProcessor({ exporter }));
```

### 3. Graceful Degradation

```typescript
// Processors are resilient to errors
for (const processor of processors) {
  try {
    processor.onEnd(span);
  } catch {
    // Swallow errors; processors shouldn't crash tracing
  }
}
```

### 4. Async Context Propagation

```typescript
// Automatic parent-child relationships
await runWithSpanAsync(parentSpan, async () => {
  // Current span is available implicitly
  const current = getCurrentSpan();
});
```

## Adding a New Processor

1. Create a new file in `src/processor/`:

```typescript
// src/processor/custom-processor.ts
import { ISpanProcessor, ISpan } from '../types';

export class CustomProcessor implements ISpanProcessor {
  onEnd(span: ISpan): void {
    // Process span
  }

  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}
```

2. Export from module:

```typescript
// src/processor/index.ts
export { CustomProcessor } from './custom-processor';
```

3. Add tests:

```typescript
// src/__tests__/processor.test.ts
describe('CustomProcessor', () => {
  it('should process spans', () => {
    // Test implementation
  });
});
```

## Adding a New Exporter

1. Create a new file in `src/exporter/`:

```typescript
// src/exporter/custom-exporter.ts
import { ISpanExporter, ISpan } from '../types';

export class CustomExporter implements ISpanExporter {
  async export(spans: ISpan[]): Promise<boolean> {
    // Send spans
    return true;
  }

  async shutdown(): Promise<void> {}
}
```

2. Register with SDK:

```typescript
const exporter = new CustomExporter();
const processor = new BatchSpanProcessor({ exporter });
provider.addSpanProcessor(processor);
```

## Performance Optimization

### Span Creation

- Spans are lightweight objects
- Context is resolved lazily
- No allocation overhead for unsampled traces (once sampling is implemented)

### Batch Export

- Spans are queued and exported in batches
- Configurable batch size and flush interval
- Background thread prevents blocking

### Memory Management

- Span processor removes processed spans from queue
- Timer is unref'd to not prevent process shutdown
- Resources are properly cleaned up on shutdown

## Testing Guidelines

### Unit Tests

- Test individual components in isolation
- Mock dependencies
- Verify behavior without side effects

```typescript
it('should set attributes', () => {
  const span = tracer.startSpan('test');
  span.setAttribute('key', 'value');
  expect(span.attributes.key).toBe('value');
});
```

### Integration Tests

- Test component interactions
- Verify end-to-end flows
- Use real implementations where possible

```typescript
it('should export spans', async () => {
  const exporter = new TestExporter();
  const processor = new BatchSpanProcessor({ exporter });
  // ...
});
```

### Async Tests

```typescript
it('should handle async operations', async () => {
  const result = await tracer.startActiveSpan('async-op', async () => {
    return await someAsyncFunction();
  });
  expect(result).toBeDefined();
});
```

## Debugging

### Enable Console Exporter

```typescript
await startTracing({
  enableConsoleExporter: true,
  enableSpanLogging: true,
});
```

### Enable Debug Mode

```typescript
await startTracing({
  debug: true, // Forces sampling of all traces
});
```

### View Runtime Config

```typescript
import { getConfig } from './config/runtime-config';
console.log(getConfig());
```

## Publishing

### Pre-publish Checks

```bash
# Build and test
npm run build
npm test
npm run lint

# Check types
npx tsc --noEmit

# Create tarball to verify contents
npm pack
```

### Publish to npm

```bash
# Update version
npm version patch|minor|major

# Publish
npm publish --access public

# Tag release
git tag v1.0.0
git push origin v1.0.0
```

## Version Management

Follow [Semantic Versioning](https://semver.org/):

- **MAJOR**: Breaking API changes
- **MINOR**: New features, backward compatible
- **PATCH**: Bug fixes, backward compatible

## Release Notes Template

```markdown
# v1.0.0 (YYYY-MM-DD)

## Features
- Feature description

## Bug Fixes
- Bug fix description

## Breaking Changes
- Breaking change description

## Deprecations
- Deprecation notice

## Migration Guide
- Migration steps if needed
```

## Documentation

### Code Comments

- Document public APIs with JSDoc
- Include usage examples
- Document parameters and return types

```typescript
/**
 * Start a new span.
 * @param name - Span name
 * @param options - Optional configuration
 * @returns New span instance
 */
export function startSpan(
  name: string,
  options?: SpanOptions
): ISpan {
  // ...
}
```

### README

- Keep updated with features
- Include quick start examples
- Document configuration options

### API Documentation

- Generate from TypeScript types
- Include examples
- Document all public APIs

## Troubleshooting

### Common Issues

1. **Spans not exporting**
   - Check endpoint configuration
   - Verify API key
   - Check network connectivity
   - Review error logs

2. **High memory usage**
   - Reduce maxQueueSize
   - Increase scheduleDelayMs
   - Enable sampling

3. **Missing parent spans**
   - Use startActiveSpan for automatic context
   - Verify parent span wasn't ended before child

## Contributing

1. Follow the code style (prettier, eslint)
2. Add tests for new features
3. Update documentation
4. Create clear commit messages
5. Submit PR with description

## License

MIT
