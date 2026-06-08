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
  error?: { message?: string };
}

interface AgentsTrace {
  traceId: string;
}

/**
 * Traccia processor for OpenAI Agents SDK.
 */
export class TracciaAgentsTracingProcessor {
  private traceMap: Map<string, AgentsTrace> = new Map();
  private spanMap: Map<string, { span: unknown; startTime: number }> = new Map();
  private tracer: unknown = null;

  private getTracer(): unknown {
    if (!this.tracer) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const traccia = require("../../index");
      this.tracer = traccia.getTracer("openai.agents");
    }
    return this.tracer;
  }

  onTraceStart(trace: AgentsTrace): void {
    this.traceMap.set(trace.traceId, trace);
  }

  onTraceEnd(trace: AgentsTrace): void {
    this.traceMap.delete(trace.traceId);
  }

  onSpanStart(span: AgentsSpan): void {
    const tracer = this.getTracer();
    const spanData = span.spanData;
    const spanName = this.getSpanName(spanData);

    // Extract attributes
    const attributes = this.extractAttributes(spanData);

    // Start Traccia span
    // Using any to avoid tight coupling with types
    const tracciaSpan = (tracer as { startSpan: (name: string, attrs?: Record<string, unknown>) => { setAttribute: (k: string, v: unknown) => void; end: () => void } }).startSpan(spanName, attributes);
    this.spanMap.set(span.spanId, { span: tracciaSpan, startTime: Date.now() });
  }

  onSpanEnd(span: AgentsSpan): void {
    const entry = this.spanMap.get(span.spanId);
    if (!entry) return;

    const tracciaSpan = entry.span as { setAttribute: (k: string, v: unknown) => void; end: () => void };
    this.spanMap.delete(span.spanId);

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

    tracciaSpan.end();
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
  }

  forceFlush(): void {
    // Traccia handles flushing at the provider level
  }
}