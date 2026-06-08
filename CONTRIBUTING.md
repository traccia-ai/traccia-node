# Contributing to Traccia SDK

We welcome contributions! This document provides guidelines for contributing to the Traccia SDK for TypeScript.

## Code of Conduct

- Be respectful and inclusive
- Focus on the code, not the person
- Help others learn and grow
- Report issues responsibly

## Getting Started

### Prerequisites

- Node.js 16+
- npm 7+
- Git

### Setup Development Environment

```bash
# Clone the repository
git clone https://github.com/traccia/sdk-ts.git
cd sdk-ts

# Install dependencies
npm install

# Create a branch for your changes
git checkout -b feature/your-feature-name
```

## Making Changes

### Code Style

The project uses:
- **ESLint** for linting
- **Prettier** for code formatting
- **TypeScript** with strict mode enabled

```bash
# Format code
npm run format

# Fix linting issues
npm run lint:fix
```

### Commit Messages

Use descriptive commit messages:

```
feat: Add new feature
fix: Fix bug
docs: Update documentation
refactor: Refactor code
test: Add tests
chore: Update dependencies
```

### Pull Request Process

1. **Create a feature branch**
   ```bash
   git checkout -b feature/descriptive-name
   ```

2. **Make your changes**
   - Keep commits atomic and focused
   - Write clear commit messages
   - Update documentation if needed

3. **Add tests**
   - All features must have tests
   - Maintain >75% code coverage
   - Test both happy and error paths

4. **Verify quality**
   ```bash
   npm run lint:fix    # Fix style issues
   npm run format      # Format code
   npm test            # Run tests
   npm test:cov        # Check coverage
   ```

5. **Push and create PR**
   ```bash
   git push origin feature/descriptive-name
   ```

6. **Respond to review feedback**
   - Address all comments
   - Explain reasoning if disagreeing
   - Request re-review when updated

## Testing Requirements

### Unit Tests

- Test individual functions/classes in isolation
- Mock external dependencies
- Cover success and error cases
- File: `src/__tests__/[module].test.ts`

### Integration Tests

- Test components working together
- Use real implementations
- Verify end-to-end flows
- Include in same test file or separate integration suite

### Test Example

```typescript
import { TracerProvider } from '../tracer/provider';

describe('SpanProcessor', () => {
  let provider: TracerProvider;

  beforeEach(() => {
    provider = new TracerProvider();
  });

  afterEach(async () => {
    await provider.shutdown();
  });

  it('should process spans correctly', () => {
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test-span', {
      attributes: { userId: '123' },
    });

    span.setAttribute('status', 'success');
    span.end();

    expect(span.durationNs).toBeGreaterThan(0);
    expect(span.attributes.status).toBe('success');
  });
});
```

## Documentation

### Update README.md

- For new features: Add to the appropriate section
- Update table of contents if adding major sections
- Include code examples

### Update DEVELOPER.md

- Document new modules/patterns
- Update architecture if changed
- Add troubleshooting tips

### Code Comments

Use JSDoc for public APIs:

```typescript
/**
 * Create a new span with the given name.
 *
 * @param name - The span name
 * @param options - Optional span configuration
 * @returns A new span instance
 *
 * @example
 * ```typescript
 * const span = tracer.startSpan('request', {
 *   attributes: { method: 'GET' },
 * });
 * ```
 */
export function startSpan(name: string, options?: SpanOptions): ISpan {
  // ...
}
```

## Bug Reports

### Template

```markdown
**Describe the bug**
A clear description of the bug.

**To reproduce**
Steps to reproduce:
1. ...
2. ...

**Expected behavior**
What should happen.

**Actual behavior**
What actually happens.

**Environment**
- Node version: ...
- npm version: ...
- SDK version: ...

**Additional context**
Any other context.
```

### Security Issues

For security vulnerabilities, **do not** create a public issue. Instead:

1. Email security@traccia.io with details
2. Include a description of the vulnerability
3. Provide steps to reproduce if applicable
4. Allow time for us to address before public disclosure

## Feature Requests

### Template

```markdown
**Is your feature request related to a problem?**
Description of the problem.

**Describe the solution you'd like**
Clear description of the desired feature.

**Describe alternatives you've considered**
Any alternative approaches.

**Additional context**
Any other context or examples.
```

## Releases

Releases are managed by maintainers. The process:

1. Update version in package.json (semantic versioning)
2. Update CHANGELOG.md
3. Create git tag
4. Publish to npm
5. Create GitHub release

For version numbering:
- **MAJOR.MINOR.PATCH**
- MAJOR: Breaking changes
- MINOR: New features
- PATCH: Bug fixes

## Areas for Contribution

### High Priority

- [ ] Automatic instrumentation for popular libraries
  - OpenAI client
  - Anthropic client
  - LangChain integration
- [ ] Custom exporters for other backends
- [ ] Performance optimizations
- [ ] Documentation and examples

### Medium Priority

- [ ] Additional span processors
- [ ] Metrics collection
- [ ] Trace visualization helpers
- [ ] More comprehensive error handling

### Low Priority

- [ ] Additional logging formats
- [ ] CLI tools
- [ ] Dashboard integration helpers

## Development Tips

### Debugging

```typescript
// Enable debug logging
import { getConfig } from './config/runtime-config';

// Enable at runtime
process.env.DEBUG = '*';

// Check current config
console.log(getConfig());
```

### Testing with Console Exporter

```typescript
const provider = new TracerProvider();
const tracer = provider.getTracer('test');

// Add console exporter for debugging
provider.addSpanProcessor(
  new BatchSpanProcessor({
    exporter: new ConsoleExporter(),
  })
);

const span = tracer.startSpan('test');
span.end();
```

### Running Specific Tests

```bash
# Run single file
npm test -- span.test.ts

# Run specific test
npm test -- -t "should create spans"

# Run with coverage
npm test:cov
```

### Build and Test Locally

```bash
# Clean build
npm run clean && npm run build

# Run all checks
npm run lint && npm test && npm run format
```

## Getting Help

- **GitHub Issues**: For bugs and features
- **Discussions**: For questions and discussions
- **Documentation**: See README.md and DEVELOPER.md
- **Email**: support@traccia.io

## Recognition

Contributors will be:
- Added to CONTRIBUTORS.md
- Mentioned in release notes
- Recognized in the community

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

Thank you for contributing to Traccia SDK! 🎉
