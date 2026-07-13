# Changelog

All notable changes to the Traccia SDK for TypeScript will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.6] - 2026-07-13

### Added
- HIPAA governance attributes (`hipaa.*`) and PHI soft-warning / redaction support for healthcare workloads
- Soft PHI warnings only — does not block spans; no signed BAA claim

### Fixed
- Redaction order: MRN / NPI / DOB patterns run before phone / SSN so NPI digits are not misclassified as phone numbers

## [0.1.5] - 2026-07-10

### Added
- `govern()` — observability plus runtime policy enforcement via Traccia platform agent-status API
- `AgentBlockedError`, `checkAgentStatus()`, `disclosure()`, `enrichGovernanceAttributes()`
- Exported `governanceHooks` / `GovernanceManager` for lifecycle hook registration
- `runIdentity()` for run-scoped agent attribution (Python SDK parity)
- Default policy URLs derived from tracing endpoint; advanced endpoint overrides via init or `[governance]` in `traccia.toml`

### Changed
- Documented that `govern()` requires Traccia platform; use `observe()` for tracing-only setups

## [0.1.4] - 2026-06-20

### Added
- `spanScope`, `runWithSpan`, `runWithSpanAsync` APIs for explicit span lifecycle control (Python SDK parity)
- `resolveServiceName()` helper with `OTEL_SERVICE_NAME` / `TRACCIA_SERVICE_NAME` / cwd fallback
- OTLP export now includes resource attributes: `service.name`, `tenant.id`, `agent.id`, `session.id`, `env`, `service_role`, `trace.debug`
- Cost processor: writes `llm.cost.usd`, `llm.pricing.*` metadata, staleness warnings at 7d (info) and 30d (warn)
- Cost resolver: prefix model matching via `lookupPrice` / `matchPricingModelKey`
- Token counter: `llm.usage.prompt_tokens` / `llm.usage.completion_tokens` / `llm.usage.total_tokens` attributes with `llm.usage.source`
- OpenAI instrumentation: `llm.completion`, `llm.openai.messages`, usage attribute aliases, response model backfill

### Changed
- OpenAI span renamed from `llm.openai.chat` to `llm.openai.chat.completions` for schema alignment with Python SDK
- Cost processor: skips cost annotation when `span.type` is present and not `"llm"` (case-insensitive)
- Governance enrichment: no longer uses `span.type` as `governance.event_type` (uses inference heuristic instead)
- Agent enricher: prefers `TRACCIA_AGENT_ID` / `TRACCIA_ENV` / `TRACCIA_AGENT_NAME` over legacy `AGENT_DASHBOARD_*` env vars
- OTLP exporter: includes `parentSpanContext` for correct trace hierarchy

### Fixed
- Removed debug `console.log` from tracer continuation logic

## [1.0.0] - 2024-01-15

### Added
- Core tracing SDK with Tracer and Span implementation
- Span context propagation using AsyncLocalStorage
- Automatic parent-child span relationships with active spans
- Batch span processor with configurable queue and export settings
- HTTP exporter with automatic retry and exponential backoff
- Console exporter for debugging
- Token counting processor for LLM spans
- Cost calculation processor for token-based pricing
- Logging span processor for span inspection
- Sampler for probabilistic trace sampling
- Environment variable configuration support
- .env file loading support
- Pricing configuration with JSON override support
- Runtime configuration management
- Comprehensive test suite with >75% coverage
- Full TypeScript type definitions
- Production-grade error handling and resilience
- Graceful shutdown with signal handling
- Complete API documentation
- Developer guide with architecture details
- Contributing guidelines
- Examples for common use cases

### Features
- **Distributed Tracing**: Create and propagate spans across services
- **Flexible Processors**: Built-in and extensible span processors
- **Automatic Context**: Implicit parent-child relationships
- **Cost Tracking**: Automatic token counting and cost calculation
- **Multiple Exporters**: HTTP, console, and custom exporters
- **Configuration**: Environment-based and programmatic configuration
- **Error Resilience**: Graceful handling of processor/exporter failures
- **Performance**: Efficient batching and background export
- **Type Safety**: Full TypeScript support with strict typing

### Documentation
- Comprehensive README with quick start and API reference
- DEVELOPER.md with architecture and contribution guide
- CONTRIBUTING.md with guidelines for contributors
- Examples folder with common usage patterns
- Inline code documentation with JSDoc

### Quality
- Jest test suite with >75% code coverage
- ESLint configuration for code quality
- Prettier configuration for consistent formatting
- TypeScript strict mode enabled
- Pre-publish verification steps

## Future Plans

### v1.1.0 (Planned)
- Automatic instrumentation for OpenAI
- Automatic instrumentation for Anthropic
- Custom sampler interface
- Metrics collection
- W3C Trace Context header support

### v1.2.0 (Planned)
- LangChain integration
- Enhanced error diagnostics
- Performance metrics
- Distributed tracing header propagation

### v2.0.0 (Planned)
- Browser/Edge runtime support
- Worker thread support
- gRPC exporter
- OpenTelemetry compatibility layer
