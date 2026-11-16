/**
 * Traccia processor for OpenAI Agents SDK tracing.
 */

import { GuardrailCategory, SourceType, Confidence, EnforcementMode, createGuardrailFinding } from "../../guardrails/schema";
import { ATTR_GUARDRAIL_SOURCE_SDK, ATTR_GUARDRAIL_EVIDENCE_TYPE } from "../../guardrails/constants";

interface AgentsSpan {
  spanData: {
    type: string;
    name?: string;
    model?: string;
    modelConfig?: Record<string, unknown>;
    tools?: string[];
    handoffs?: string[];
    outputType?: string;
    input?: unknown;
    output?: unknown;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
    };
    triggered?: boolean;
    response?: { id?: string };
  };
  spanId: string;
  /** Agents trace the span belongs to. */
  traceId?: string;
  /** Agents span this span was started under; null/undefined for a top-level span. */
  parentId?: string | null;
  /** ISO-8601 time the framework started the span. */
  startedAt?: string | null;
  /** ISO-8601 time the framework ended the span. */
  endedAt?: string | null;
  error?: { message?: string } | null;
}

interface AgentsTrace {
  traceId: string;
  name?: string;
  groupId?: string | null;
}

/** The part of a Traccia span this processor uses. */
interface TracciaSpanLike {
  startTimeNs?: number;
  setAttribute: (k: string, v: unknown) => void;
  end: (endTimeNs?: number) => void;
}

interface TracciaTracerLike {
  startSpan: (
    name: string,
    options?: { attributes?: Record<string, unknown>; parent?: unknown; startTimeNs?: number },
  ) => TracciaSpanLike;
}

/** Agents SDK ISO-8601 timestamp -> epoch nanoseconds, or undefined. */
function isoToNs(value: unknown): number | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms * 1_000_000 : undefined;
}

/**
 * Now, on the clock the Agents SDK stamps spans with (`new Date().toISOString()`), so
 * the trace root and its spans compare on one clock. Traccia's default
 * (`performance.timeOrigin + performance.now()`) can drift from `Date` in a
 * long-running process.
 */
function nowNs(): number {
  return Date.now() * 1_000_000;
}

/** How many ended traces and spans stay resolvable as parents for late callbacks. */
const RECENTLY_ENDED_LIMIT = 1024;

function rememberEnded(map: Map<string, TracciaSpanLike>, key: string, span: TracciaSpanLike): void {
  map.delete(key);
  map.set(key, span);
  if (map.size > RECENTLY_ENDED_LIMIT) {
    for (const oldest of map.keys()) {
      map.delete(oldest); // Maps iterate in insertion order: this is the oldest entry
      break;
    }
  }
}

/**
 * Traccia processor for OpenAI Agents SDK.
 *
 * The callbacks carry the run's hierarchy (`traceId`, `parentId`) and timing
 * (`startedAt`, `endedAt`). Each Agents trace becomes one Traccia trace under a root
 * span (nested in the caller's span when one is active), and each Agents span is
 * parented explicitly on the Traccia span of its Agents parent.
 *
 * The Agents SDK delivers span callbacks without awaiting them, after earlier
 * processors, so they can arrive late and after the trace's end callback. Spans
 * therefore use the framework's timestamps, and recently ended traces and spans stay
 * resolvable as parents so a late callback still joins its trace.
 */
export class TracciaAgentsTracingProcessor {
  /** Agents traceId -> root Traccia span and the latest end time of its spans. */
  private traceMap: Map<string, { span: TracciaSpanLike; lastEndNs?: number }> = new Map();
  /** Agents spanId -> Traccia span and its Agents traceId. */
  private spanMap: Map<string, { span: TracciaSpanLike; traceId?: string }> = new Map();
  /** Bounded: Agents traceId / spanId -> ended Traccia span, for late child callbacks. */
  private endedTraces: Map<string, TracciaSpanLike> = new Map();
  private endedSpans: Map<string, TracciaSpanLike> = new Map();
  private tracer: unknown = null;

  private getTracer(): TracciaTracerLike {
    if (!this.tracer) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const traccia = require("../../index");
      this.tracer = traccia.getTracer("openai.agents");
    }
    return this.tracer as TracciaTracerLike;
  }

  /** Traccia span for an Agents span's parent: its parent span, else its trace's root. */
  private resolveParent(span: AgentsSpan): TracciaSpanLike | undefined {
    if (span.parentId) {
      const parent = this.spanMap.get(span.parentId)?.span ?? this.endedSpans.get(span.parentId);
      if (parent) return parent;
    }
    if (span.traceId) {
      const root = this.traceMap.get(span.traceId)?.span ?? this.endedTraces.get(span.traceId);
      if (root) return root;
    }
    // Unknown trace (processor registered mid-run): the caller's current span, if any.
    return undefined;
  }

  onTraceStart(trace: AgentsTrace): void {
    try {
      const attributes: Record<string, unknown> = {
        "agents.trace_id": trace.traceId,
        "agent.span.type": "trace",
      };
      if (trace.groupId) attributes["agents.group_id"] = String(trace.groupId);
      // One Traccia root span per Agents trace, so the run's spans form one trace
      // (inside the caller's span when there is one).
      const root = this.getTracer().startSpan(trace.name || "agents.trace", { attributes, startTimeNs: nowNs() });
      this.traceMap.set(trace.traceId, { span: root });
    } catch {
      // Don't break agent execution on tracing errors
    }
  }

  onTraceEnd(trace: AgentsTrace): void {
    try {
      const entry = this.traceMap.get(trace.traceId);
      this.traceMap.delete(trace.traceId);
      if (!entry) return;
      rememberEnded(this.endedTraces, trace.traceId, entry.span);
      // Never end before a child whose framework end time is past our clock.
      entry.span.end(Math.max(nowNs(), entry.lastEndNs ?? 0));
    } catch {
      // Don't break agent execution on tracing errors
    }
  }

  onSpanStart(span: AgentsSpan): void {
    try {
      const spanData = span.spanData;
      const spanName = this.getSpanName(spanData);
      const attributes = this.extractAttributes(spanData);
      if (span.traceId) attributes["agents.trace_id"] = span.traceId;
      attributes["agents.span_id"] = span.spanId;
      if (span.parentId) attributes["agents.parent_id"] = span.parentId;

      const parent = this.resolveParent(span);
      let startTimeNs = isoToNs(span.startedAt);
      if (startTimeNs !== undefined && typeof parent?.startTimeNs === "number") {
        // ISO timestamps carry milliseconds; keep children inside their parent.
        startTimeNs = Math.max(startTimeNs, parent.startTimeNs);
      }

      const tracciaSpan = this.getTracer().startSpan(spanName, { attributes, parent, startTimeNs });
      this.spanMap.set(span.spanId, { span: tracciaSpan, traceId: span.traceId });
    } catch {
      // Don't break agent execution on tracing errors
    }
  }

  onSpanEnd(span: AgentsSpan): void {
    const entry = this.spanMap.get(span.spanId);
    if (!entry) return;
    this.spanMap.delete(span.spanId);
    const tracciaSpan = entry.span;
    rememberEnded(this.endedSpans, span.spanId, tracciaSpan);

    // The framework's end time, never before the span's start.
    const endTimeNs = Math.max(isoToNs(span.endedAt) ?? nowNs(), tracciaSpan.startTimeNs ?? 0);
    const traceEntry = entry.traceId ? this.traceMap.get(entry.traceId) : undefined;
    if (traceEntry) {
      traceEntry.lastEndNs = Math.max(traceEntry.lastEndNs ?? 0, endTimeNs);
    }

    try {
      this.finishSpan(tracciaSpan, span);
    } catch {
      // Don't break agent execution on tracing errors; the span is still ended below.
    }
    try {
      tracciaSpan.end(endTimeNs);
    } catch {
      // ignore
    }
  }

  private finishSpan(tracciaSpan: TracciaSpanLike, span: AgentsSpan): void {
    const spanData = span.spanData;

    // Update attributes with final data
    this.updateSpanAttributes(tracciaSpan, spanData);

    // Record error if present
    if (span.error) {
      const errorMsg = span.error.message || "Unknown error";
      tracciaSpan.setAttribute("error", true);
      tracciaSpan.setAttribute("error.message", errorMsg);
    }

    // Record guardrail finding for guardrail spans
    if (spanData.type === "guardrail") {
      const guardrailName = spanData.name || "unknown";
      const triggered = spanData.triggered ?? false;
      const finding = createGuardrailFinding({
        category: GuardrailCategory.MODERATION,
        name: guardrailName,
        source_type: SourceType.PROVIDER_NATIVE,
        confidence: Confidence.HIGH,
        triggered,
        enforcement_mode: EnforcementMode.WARN,
        detection_reason: "Detected via OpenAI Agents SDK guardrail span",
        evidence_ref: {
          trace_id: undefined,
          span_id: span.spanId,
          integration: "openai_agents",
          attribute_keys: ["agent.guardrail.triggered", "guardrail.triggered"],
        },
      });
      tracciaSpan.setAttribute("guardrail.findings", JSON.stringify([finding]));
    }
  }

  private getSpanName(spanData: AgentsSpan["spanData"]): string {
    const spanType = spanData.type;
    if (spanType === "agent") {
      return `agent.${spanData.name || "unknown"}`;
    }
    if (spanType === "generation") {
      return "llm.agents.generation";
    }
    if (spanType === "function") {
      return `agent.tool.${spanData.name || "unknown"}`;
    }
    if (spanType === "handoff") {
      return "agent.handoff";
    }
    if (spanType === "guardrail") {
      return `agent.guardrail.${spanData.name || "unknown"}`;
    }
    if (spanType === "response") {
      return "agent.response";
    }
    if (spanType === "custom") {
      return `agent.custom.${spanData.name || "unknown"}`;
    }
    return `agent.${spanType}`;
  }

  private extractAttributes(spanData: AgentsSpan["spanData"]): Record<string, unknown> {
    const attrs: Record<string, unknown> = {
      "agent.span.type": spanData.type,
    };

    const spanType = spanData.type;

    if (spanType === "agent") {
      if (spanData.name) attrs["agent.name"] = spanData.name;
      if (spanData.tools) attrs["agent.tools"] = JSON.stringify(spanData.tools).slice(0, 500);
      if (spanData.handoffs) attrs["agent.handoffs"] = JSON.stringify(spanData.handoffs).slice(0, 500);
      if (spanData.outputType) attrs["agent.output_type"] = String(spanData.outputType);
    } else if (spanType === "generation") {
      if (spanData.model) attrs["llm.model"] = String(spanData.model);
      if (spanData.modelConfig) attrs["llm.model_config"] = JSON.stringify(spanData.modelConfig).slice(0, 500);
    } else if (spanType === "function") {
      if (spanData.name) attrs["agent.tool.name"] = spanData.name;
    } else if (spanType === "handoff") {
      // handoffs have from_agent and to_agent in span_data
    } else if (spanType === "guardrail") {
      const guardrailName = spanData.name || "unknown";
      if (guardrailName) attrs["agent.guardrail.name"] = guardrailName;
      if (guardrailName) attrs["guardrail.name"] = guardrailName;
      attrs["guardrail.source_sdk"] = ATTR_GUARDRAIL_SOURCE_SDK;
      attrs["guardrail.evidence_type"] = ATTR_GUARDRAIL_EVIDENCE_TYPE;
    }

    return attrs;
  }

  private updateSpanAttributes(tracciaSpan: { setAttribute: (k: string, v: unknown) => void }, spanData: AgentsSpan["spanData"]): void {
    const spanType = spanData.type;

    if (spanType === "generation") {
      const usage = spanData.usage;
      if (usage) {
        const inputTokens = usage.input_tokens || usage.prompt_tokens;
        const outputTokens = usage.output_tokens || usage.completion_tokens;
        if (inputTokens !== undefined) {
          tracciaSpan.setAttribute("llm.usage.input_tokens", inputTokens);
          tracciaSpan.setAttribute("llm.usage.prompt_tokens", inputTokens);
        }
        if (outputTokens !== undefined) {
          tracciaSpan.setAttribute("llm.usage.output_tokens", outputTokens);
          tracciaSpan.setAttribute("llm.usage.completion_tokens", outputTokens);
        }
        if (inputTokens !== undefined && outputTokens !== undefined) {
          tracciaSpan.setAttribute("llm.usage.total_tokens", inputTokens + outputTokens);
        }
      }
      if (spanData.input) {
        try {
          tracciaSpan.setAttribute("llm.input", JSON.stringify(spanData.input).slice(0, 1000));
        } catch {
          tracciaSpan.setAttribute("llm.input", String(spanData.input).slice(0, 1000));
        }
      }
      if (spanData.output) {
        try {
          tracciaSpan.setAttribute("llm.output", JSON.stringify(spanData.output).slice(0, 1000));
        } catch {
          tracciaSpan.setAttribute("llm.output", String(spanData.output).slice(0, 1000));
        }
      }
    } else if (spanType === "function") {
      if (spanData.input) tracciaSpan.setAttribute("agent.tool.input", String(spanData.input).slice(0, 500));
      if (spanData.output) tracciaSpan.setAttribute("agent.tool.output", String(spanData.output).slice(0, 500));
    } else if (spanType === "guardrail") {
      const triggered = spanData.triggered ?? false;
      tracciaSpan.setAttribute("agent.guardrail.triggered", triggered);
      tracciaSpan.setAttribute("guardrail.triggered", triggered);
    } else if (spanType === "response") {
      if (spanData.response?.id) {
        tracciaSpan.setAttribute("agent.response.id", spanData.response.id);
      }
    }
  }

  shutdown(): void {
    this.traceMap.clear();
    this.spanMap.clear();
    this.endedTraces.clear();
    this.endedSpans.clear();
  }

  forceFlush(): void {
    // Traccia handles flushing at the provider level
  }
}