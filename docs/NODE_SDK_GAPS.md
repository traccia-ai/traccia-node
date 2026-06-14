# Node SDK Feature Gaps

This document captures the missing features and architectural gaps in the `traccia-node` SDK when compared directly against the `traccia-python` SDK. Whenever a feature is documented for Python but missing in Node.js, it is logged here.

## 1. Exporters
- **File Exporter**: Python SDK includes a built-in file exporter for local traces. The Node SDK currently only supports `enableConsoleExporter` and OTLP endpoints via `@opentelemetry/exporter-trace-otlp-proto`.

## 2. Distributed Context Propagation
- **Propagators**: Python SDK includes dedicated W3C trace context extraction and injection tools (`context/propagators.py`). The Node SDK relies heavily on a basic `AsyncLocalStorage` wrapper and doesn't expose native explicit propagator interfaces.

## 3. Cost Engine & Resolution
- **Cost Engine**: Python SDK features a thread-safe, process-level singleton (`cost_resolver.py` and `processors/cost_engine.py`) designed to maintain a globally active pricing table. The Node SDK relies on a static, local object `cachedPricing`.

## 4. Agent Identity Model
- **Pydantic Model**: Python SDK has a centralized `AgentIdentity` Pydantic model (`identity.py`) that standardizes and enforces agent attributes. The Node SDK relies on a generic configuration interface (`AgentIdentity`) that gets merged into resource attributes, lacking strict runtime validation.

## 5. Standardized Error Hierarchy
- **Typed Exceptions**: Python defines strongly-typed exceptions (`errors.py` containing `TracciaError`, `ConfigError`, `RateLimitError`). The Node SDK throws raw JS `Error` instances in most places (except for a few places like CLI where it prints to stderr).

## 6. Governance Hooks
- **Hook Framework**: Python SDK exposes specific, hookable interfaces (`governance/hooks.py`) for policy enforcement and enrichment. The Node SDK currently implements governance via the `GovernanceEnrichmentProcessor` acting on Span start/end events, but doesn't expose distinct programmable hooks like `pre_execution` or `post_execution`.

## 7. Metrics Recording
- **Meter Provider Abstraction**: Python SDK decouples metrics definition from recording via `recorder.py` and `Meter`. The Node SDK implements simple `recordCounter` and `recordHistogram` utility functions in `metrics.ts` without a full provider abstraction.

## 8. TracciaContext Context Management
- **Headers Injection**: Python SDK has `TracciaContext.inject_http_headers()` for seamless header propagation. The Node SDK has not yet exposed an equivalent unified interface on its `Traccia` namespace object.

## 9. Multi-Agent Orchestrator Host Service
- **service_role**: Python SDK supports `init(service_role="orchestrator")` to suppress the host service from registering as an agent. The Node SDK lacks a formal `serviceRole` parameter in `SDKConfig` and `AgentIdentity`.

*This document will be continuously updated as the SDK evolves.*
