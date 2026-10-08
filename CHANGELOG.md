# Changelog

All notable changes to the Traccia SDK for TypeScript (`npm install @traccia/sdk`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/). Dates are the npm publish date (UTC). Only versions published to npm are listed.

## [Unreleased]

## [0.1.18] - 2026-10-08

### Added
- `ApprovalPending` is raised when Refund Guard or Purchase Guard holds a tool for a person. It is not `AgentBlockedError`. Catch it, do not run the tool, and do not retry the check. `pendingToolResult()` is a normal tool result for frameworks that retry raised errors

## [0.1.17] - 2026-10-03

Includes the changes tagged `v0.1.15` and `v0.1.16` on GitHub, which were never published to npm.

### Added
- `govern()` tool checks send the last read timestamp (`as_of` or `updated_at`) remembered from an earlier tool result, for Freshness Guard
- `govern()` tool checks send `context.customer_id` when tool arguments include a customer id, for Unique Customer Cap
- `govern()` LLM checks send retrieval evidence only from real `traccia.retrieval.*` span attributes (presence, and chunk count when recorded)
- Prompt name, label, and version id stamped at `LoadedPrompt.compile` are attached to the following LLM policy check, for Prompt Pin
- `evaluate()` keeps per-question scores and the `unsure` flag from the Jev Decision scorer on each experiment cell
- Local cost estimates price `llm.usage.cache_read_tokens` and `llm.usage.cache_write_tokens` at the model's cache read and cache write rates. `llm.usage.prompt_tokens` is treated as uncached input
- `llm.pricing.cache_fallback` is set to `true` when a model has no cache rate and those tokens were priced at the input rate
- `CostResolver.computeDetailed()` returns the cost and whether a cache fallback was used. Pricing tables accept `cacheReadCost` and `cacheWriteCost`, read from LiteLLM `cache_read_input_token_cost` and `cache_creation_input_token_cost`

### Fixed
- Model names without a provider prefix match provider-prefixed catalog keys (`grok-4.7` matches `xai/grok-4.7`) before prefix matching, so a shorter key such as `grok-4` no longer wins
- Agent enricher matches Python: `agent.span.type` of `generation` is an LLM span, and `agent.tool.name` or `function` is a tool. `http.url` alone does not make a tool span

## [0.1.14] - 2026-09-07

### Added
- Per-call policy check under `govern()` (`src/governance/pep.ts`): `POST /api/v1/policy/check` on instrumented LLM and tool spans (Spend Cap, Model Boundary, Loop Cap). Optional `checkPolicy()` for custom tools
- `init({ agentId, agentName, env })` matching Python `init(agent_id=...)`
- `observe({ asType: 'tool' })` alias of `type: 'tool'` (Python `as_type="tool"`)
- `govern()` inherits `agentId` from `init` / `TRACCIA_AGENT_ID`; pass `agentId` only to override
- README example: instrumented OpenAI + tool observe under `govern()`
- Redaction allowlist for `traccia.policy.*` span attributes (same pattern as `traccia.prompt.*`)
- HTTP client skip for `govern()` status and block calls, policy check and settle, and prompt-runtime fetches on axios and fetch, matching the Python SDK

### Fixed
- Policy settle now sends `trace_id` (Spend Cap per-run counters)
- Policy check HTTP errors return `check_http_error`, matching Python
- Integer OTel trace/span ids are padded hex, matching Python

## [0.1.13] - 2026-08-19

Includes the changes tagged as `v0.1.12`, which was not published to npm.

### Fixed
- The `loadPrompt` HTTP fetch is traced once, as a TOOL span, instead of twice
- `init()` auto-patches Gemini and Axios when patching is enabled
- Gemini usage totals are preserved when enrichers run before the span ends
- `evaluate()` falls back to a default agent name when none is set

## [0.1.11] - 2026-08-18

### Added
- Gemini (`@google/genai`) auto-instrumentation: `patchGemini()` / `wrapGeminiInteractionsCreate()` for `client.interactions.create` (Interactions API only, `@google/genai` `>=2.9.0`, tested against `2.17.1`)
- Usage read directly from provider `usage.total_*` fields (`total_input_tokens`, `total_output_tokens`, `total_thought_tokens`, `total_cached_tokens`, `total_tool_use_tokens`, `total_tokens`), never synthesized from input plus output, so thinking, cache, and tool-use tokens are not dropped. `total_tokens` falls back to input plus output only when the provider omits it
- `llm.previous_interaction_id` captured for multi-turn calls; `llm.model` falls back to the response's `model` when the request omits it
- Streaming (`stream: true`) calls create a span tagged `llm.streaming: true`. Usage and completion are not recorded, because `create()` resolves with a `Stream` before the model has produced output
- Soft-fails (no crash) when `@google/genai` is not installed

### Fixed
- `BatchSpanProcessor` no longer drops queued spans during `forceFlush()` or `shutdown()`. Overlapping flushes now wait for the in-flight export and fully drain the queue

## [0.1.10] - 2026-08-13

### Added
- `evaluate()` for offline experiments (platform dataset, local+persist, local-only)
- Eval-runtime client; local built-in scorers (`exact_match`, `contains`, `json_valid`); platform judge/code via server score
- Eval span attrs (`traccia.experiment.*`, `traccia.eval.source`, `traccia.dataset.*`) with redaction allowlist
- `result.summary()`, `result.url`, progress `N/M`, per-item error isolation, default persist and maxConcurrency 10

## [0.1.9] - 2026-08-09

### Fixed
- `LoadedPrompt.compile` stamps `traccia.prompt.id` on the active span, so Prompt Metrics joins on the id instead of the name alone

## [0.1.8] - 2026-07-16

### Added
- `loadPrompt` / `prefetchPrompts` with TTL cache (~60s), stale-while-revalidate, and explicit fallback
- `{{var}}` compile helpers (`LoadedPrompt.compile`) with shared golden fixtures
- Auto span attributes `traccia.prompt.*` on compile (name, version, version_id, label, is_fallback)
- `init({ promptCacheTtlS })` / `TRACCIA_PROMPT_CACHE_TTL_S` for cache TTL
- `init({ promptApiBase })` / `TRACCIA_PROMPT_API_BASE` when prompt-runtime host differs from the traces host (advanced deployments only)
- Redaction allowlist so `traccia.prompt.*` identity keys are not wiped by `"prompt"` substring matching

## [0.1.6] - 2026-07-13

First npm release with runtime policy enforcement and HIPAA support. Versions 0.1.5 and 0.1.7 were never published.

### Added
- `govern()`: observability plus runtime policy enforcement via the Traccia platform agent-status API
- `AgentBlockedError`, `checkAgentStatus()`, `disclosure()`, `enrichGovernanceAttributes()`
- Exported `governanceHooks` / `GovernanceManager` for lifecycle hook registration
- `runIdentity()` for run-scoped agent attribution (Python SDK parity)
- Default policy URLs derived from the tracing endpoint; advanced endpoint overrides via init or `[governance]` in `traccia.toml`
- HIPAA governance attributes (`hipaa.*`) and PHI soft warnings and redaction for healthcare workloads. Warnings never block spans. Traccia does not sign a BAA

### Changed
- `govern()` requires the Traccia platform; use `observe()` for tracing-only setups

### Fixed
- Redaction order: MRN, NPI, and DOB patterns run before phone and SSN, so NPI digits are not misclassified as phone numbers

## [0.1.4] - 2026-06-22

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

## [0.1.3] - 2026-06-16

### Fixed
- OpenAI Agents SDK integration loads the `@openai/agents` package instead of `agents`
- Dependency audit fixes

## [0.1.2] - 2026-06-15

### Fixed
- Metrics recording and export
- Security: patched dependency overrides for `protobufjs` (CVE-2026-41242), `esbuild`, and `minimatch`

## [0.1.1] - 2026-06-14

### Added
- `init()` as the primary entry point. `startTracing()` remains as an alias
- `Traccia` namespace object with `init`, `getTracer`, `observe`, `getCurrentSpan`, and the session, user, tenant, and project setters

## [0.1.0] - 2026-06-14

### Added
- First public release on npm, for Node.js 16 and later
- Tracer, spans, and context propagation with `AsyncLocalStorage`
- `observe()` decorator and wrapper
- Auto-instrumentation for OpenAI (chat completions and Responses), Anthropic, axios, and fetch
- Express and Fastify tracing middleware
- OpenAI Agents SDK and CrewAI integrations
- OTLP, HTTP, console, and file exporters, with batching, sampling, and rate limiting
- Token counting and local cost estimation, with a pricing config and JSON override
- Metrics recorder for token usage, cost, and duration
- Guardrail detection and governance enrichment processors
- PII redaction processor and helpers
- CLI: `check`, `config init`, `doctor`, and `pricing:status`, `pricing:refresh`, `pricing:clear`
