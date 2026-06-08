/**
 * Guardrail detectors that extract findings from span attributes.
 * 
 * Each detector examines a dict of span attributes and produces zero or more
 * GuardrailFinding instances. Detectors are stateless functions; aggregation
 * and deduplication happen in the processor layer.
 */

import {
  GuardrailCategory,
  SourceType,
  Confidence,
  EnforcementMode,
  GuardrailFindingWithMeta,
  createGuardrailFinding,
} from "./schema";
import {
  ATTR_GUARDRAIL_CATEGORY,
  ATTR_GUARDRAIL_NAME,
  ATTR_GUARDRAIL_TRIGGERED,
  ATTR_GUARDRAIL_ENFORCEMENT_MODE,
  ATTR_SPAN_TYPE,
  ATTR_AGENT_SPAN_TYPE,
  ATTR_AGENT_GUARDRAIL_NAME,
  ATTR_AGENT_GUARDRAIL_TRIGGERED,
  ATTR_LLM_FINISH_REASON,
  ATTR_LLM_STOP_REASON,
  ATTR_LLM_SAFETY_RATINGS,
  ATTR_LLM_VENDOR,
  ATTR_ERROR_TYPE,
  ATTR_ERROR_MESSAGE,
  ATTR_LLM_RESPONSE_STATUS,
  ATTR_LLM_COMPLETION,
} from "./constants";

// Finish reason values that indicate provider-enforced content blocking
const REFUSAL_FINISH_REASONS = new Set(["content_filter", "content_filtered", "SAFETY"]);

// Anthropic stop_reason values that indicate content-policy blocking
const ANTHROPIC_BLOCK_STOP_REASONS = new Set(["content_filtered", "content_filter"]);

// Anthropic error message substrings that indicate a policy violation
const ANTHROPIC_POLICY_PHRASES = [
  "content policy",
  "violates anthropic's usage policy",
  "usage policy violation",
];

// Non-denial error types (timeout, network, etc.)
const NON_DENIAL_ERROR_TYPES = new Set([
  "TimeoutError",
  "ConnectionError",
  "ConnectionRefusedError",
  "ConnectionResetError",
  "OSError",
  "socket.timeout",
  "requests.exceptions.Timeout",
  "requests.exceptions.ConnectionError",
  "httpx.TimeoutException",
  "httpx.ConnectError",
]);

// Refusal phrases in LLM responses
const REFUSAL_PHRASES = [
  "i can't help with",
  "i cannot help with",
  "i'm not able to",
  "i am not able to",
  "i can't assist",
  "i cannot assist",
  "i'm unable to",
  "against my guidelines",
  "violates my usage policies",
  "content policy",
  "i must decline",
];

/**
 * Detect guardrails from explicit typed spans (OpenAI Agents or manual observe).
 */
export function detectExplicit(
  attrs: Record<string, unknown>,
  traceId?: string | null,
  spanId?: string | null,
): GuardrailFindingWithMeta[] {
  const findings: GuardrailFindingWithMeta[] = [];
  
  // OpenAI Agents SDK guardrail spans
  const agentSpanType = attrs[ATTR_AGENT_SPAN_TYPE];
  if (agentSpanType === "guardrail") {
    const name = (attrs[ATTR_AGENT_GUARDRAIL_NAME] || attrs[ATTR_GUARDRAIL_NAME] || "unnamed_guardrail") as string;
    const triggeredRaw = attrs[ATTR_AGENT_GUARDRAIL_TRIGGERED] || attrs[ATTR_GUARDRAIL_TRIGGERED];
    const triggered = triggeredRaw !== undefined ? Boolean(triggeredRaw) : undefined;
    
    const categoryRaw = (attrs[ATTR_GUARDRAIL_CATEGORY] || "unknown") as string;
    const category = Object.values(GuardrailCategory).includes(categoryRaw as GuardrailCategory)
      ? (categoryRaw as GuardrailCategory)
      : GuardrailCategory.UNKNOWN;
    
    findings.push(createGuardrailFinding({
      category,
      name,
      source_type: SourceType.EXPLICIT,
      confidence: Confidence.HIGH,
      triggered,
      detection_reason: "openai_agents_guardrail_span",
      evidence_ref: {
        trace_id: traceId,
        span_id: spanId,
        integration: "openai_agents",
        attribute_keys: [ATTR_AGENT_SPAN_TYPE, ATTR_AGENT_GUARDRAIL_NAME, ATTR_AGENT_GUARDRAIL_TRIGGERED],
      },
    }));
  }
  
  // Manual observe(as_type="guardrail") spans
  const spanType = attrs[ATTR_SPAN_TYPE];
  if (spanType === "guardrail" && agentSpanType !== "guardrail") {
    const name = (attrs[ATTR_GUARDRAIL_NAME] || "unnamed_guardrail") as string;
    const triggeredRaw = attrs[ATTR_GUARDRAIL_TRIGGERED];
    const triggered = triggeredRaw !== undefined ? Boolean(triggeredRaw) : undefined;
    
    const categoryRaw = (attrs[ATTR_GUARDRAIL_CATEGORY] || "unknown") as string;
    const category = Object.values(GuardrailCategory).includes(categoryRaw as GuardrailCategory)
      ? (categoryRaw as GuardrailCategory)
      : GuardrailCategory.UNKNOWN;
    
const enforcementRaw = (attrs[ATTR_GUARDRAIL_ENFORCEMENT_MODE] || "unknown") as string;
    const enforcement = Object.values(EnforcementMode).includes(enforcementRaw as EnforcementMode)
      ? (enforcementRaw as EnforcementMode)
      : EnforcementMode.UNKNOWN;
    
    const hasRequired = [
      ATTR_GUARDRAIL_NAME,
      ATTR_GUARDRAIL_CATEGORY,
      ATTR_GUARDRAIL_TRIGGERED,
    ].every((k) => attrs[k] !== undefined && attrs[k] !== null);
    
    findings.push(createGuardrailFinding({
      category,
      name,
      source_type: SourceType.EXPLICIT,
      confidence: hasRequired ? Confidence.HIGH : Confidence.MEDIUM,
      triggered,
      enforcement_mode: enforcement,
      detection_reason: "manual_observe_guardrail_span",
      evidence_ref: {
        trace_id: traceId,
        span_id: spanId,
        integration: "manual_observe",
        attribute_keys: [ATTR_SPAN_TYPE, ATTR_GUARDRAIL_NAME, ATTR_GUARDRAIL_CATEGORY],
      },
    }));
  }
  
  return findings;
}

/**
 * Check if vendor is Anthropic/Claude.
 */
function anthropicVendor(attrs: Record<string, unknown>): boolean {
  const vendor = String(attrs[ATTR_LLM_VENDOR] || "").toLowerCase();
  return vendor === "anthropic" || vendor === "claude";
}

/**
 * Check if span looks like an LLM call.
 */
function looksLikeLlmSpan(attrs: Record<string, unknown>): boolean {
  if (attrs[ATTR_SPAN_TYPE] === "llm") {
    return true;
  }
  return [
    "llm.model",
    "llm.prompt",
    "llm.completion",
    ATTR_LLM_FINISH_REASON,
    ATTR_LLM_STOP_REASON,
  ].some((k) => attrs[k] !== undefined && attrs[k] !== null);
}

/**
 * Detect guardrails from provider-native structured fields.
 */
export function detectProviderNative(
  attrs: Record<string, unknown>,
  traceId?: string | null,
  spanId?: string | null,
): GuardrailFindingWithMeta[] {
  const findings: GuardrailFindingWithMeta[] = [];
  
  // OpenAI / Azure / Google: llm.finish_reason
  const finishReason = attrs[ATTR_LLM_FINISH_REASON];
  if (finishReason && REFUSAL_FINISH_REASONS.has(String(finishReason))) {
    const vendor = String(attrs[ATTR_LLM_VENDOR] || "").toLowerCase();
    let integration = "openai";
    if (vendor === "azure") {
      integration = "azure_openai";
    } else if (vendor === "google" || vendor === "gemini") {
      integration = "google";
    }
    
    findings.push(createGuardrailFinding({
      category: GuardrailCategory.MODERATION,
      name: "provider_content_filter",
      source_type: SourceType.PROVIDER_NATIVE,
      confidence: Confidence.HIGH,
      triggered: true,
      enforcement_mode: EnforcementMode.BLOCK,
      detection_reason: "llm_finish_reason_content_filter",
      evidence_ref: {
        trace_id: traceId,
        span_id: spanId,
        integration,
        attribute_keys: [ATTR_LLM_FINISH_REASON],
      },
      raw_excerpt: String(finishReason),
    }));
  }
  
  // Anthropic: llm.stop_reason
  const stopReason = attrs[ATTR_LLM_STOP_REASON];
  if (
    stopReason &&
    ANTHROPIC_BLOCK_STOP_REASONS.has(String(stopReason)) &&
    anthropicVendor(attrs)
  ) {
    findings.push(createGuardrailFinding({
      category: GuardrailCategory.MODERATION,
      name: "anthropic_content_filter",
      source_type: SourceType.PROVIDER_NATIVE,
      confidence: Confidence.HIGH,
      triggered: true,
      enforcement_mode: EnforcementMode.BLOCK,
      detection_reason: "llm_stop_reason_content_filter",
      evidence_ref: {
        trace_id: traceId,
        span_id: spanId,
        integration: "anthropic",
        attribute_keys: [ATTR_LLM_STOP_REASON],
      },
      raw_excerpt: String(stopReason),
    }));
  }
  
  // Anthropic: error.message with policy violation text
  const errorMsg = String(attrs[ATTR_ERROR_MESSAGE] || "").toLowerCase();
  if (anthropicVendor(attrs) && errorMsg && looksLikeLlmSpan(attrs)) {
    if (ANTHROPIC_POLICY_PHRASES.some((phrase) => errorMsg.includes(phrase))) {
      findings.push(createGuardrailFinding({
        category: GuardrailCategory.MODERATION,
        name: "anthropic_policy_violation",
        source_type: SourceType.PROVIDER_NATIVE,
        confidence: Confidence.MEDIUM,
        triggered: true,
        enforcement_mode: EnforcementMode.BLOCK,
        detection_reason: "anthropic_error_message_policy_phrase",
        evidence_ref: {
          trace_id: traceId,
          span_id: spanId,
          integration: "anthropic",
          attribute_keys: [ATTR_ERROR_MESSAGE, ATTR_LLM_VENDOR],
        },
        raw_excerpt: errorMsg.slice(0, 200),
      }));
    }
  }
  
  // Google / LangChain: llm.safety_ratings
  const safetyRatingsRaw = attrs[ATTR_LLM_SAFETY_RATINGS];
  if (safetyRatingsRaw) {
    const blocked = parseSafetyRatingsBlocked(String(safetyRatingsRaw));
    if (blocked) {
      findings.push(createGuardrailFinding({
        category: GuardrailCategory.MODERATION,
        name: "google_safety_ratings_blocked",
        source_type: SourceType.PROVIDER_NATIVE,
        confidence: Confidence.MEDIUM,
        triggered: true,
        enforcement_mode: EnforcementMode.BLOCK,
        detection_reason: "llm_safety_ratings_high_or_blocked",
        evidence_ref: {
          trace_id: traceId,
          span_id: spanId,
          integration: "google_langchain",
          attribute_keys: [ATTR_LLM_SAFETY_RATINGS],
        },
        raw_excerpt: String(safetyRatingsRaw).slice(0, 200),
      }));
    }
  }
  
  // Refusal signal from response status + refusal text
  const responseStatus = attrs[ATTR_LLM_RESPONSE_STATUS];
  if (responseStatus && ["incomplete", "failed"].includes(String(responseStatus).toLowerCase())) {
    const completion = String(attrs[ATTR_LLM_COMPLETION] || "");
    if (looksLikeRefusal(completion)) {
      findings.push(createGuardrailFinding({
        category: GuardrailCategory.MODERATION,
        name: "provider_refusal",
        source_type: SourceType.PROVIDER_NATIVE,
        confidence: Confidence.MEDIUM,
        triggered: true,
        enforcement_mode: EnforcementMode.BLOCK,
        detection_reason: "llm_response_status_with_refusal_text",
        evidence_ref: {
          trace_id: traceId,
          span_id: spanId,
          integration: "openai",
          attribute_keys: [ATTR_LLM_RESPONSE_STATUS, ATTR_LLM_COMPLETION],
        },
        raw_excerpt: completion.slice(0, 200),
      }));
    }
  }
  
  return findings;
}

/**
 * Parse safety ratings to check if any are blocked or HIGH probability.
 */
function parseSafetyRatingsBlocked(ratingsJson: string): boolean {
  try {
    const ratings = JSON.parse(ratingsJson);
    const entries = Array.isArray(ratings) ? ratings : [ratings];
    
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      if (entry.blocked === true) {
        return true;
      }
      if (String(entry.probability || "").toUpperCase() === "HIGH") {
        return true;
      }
    }
  } catch {
    // Invalid JSON, skip
  }
  return false;
}

/**
 * Check if text looks like an LLM refusal.
 */
function looksLikeRefusal(text: string): boolean {
  const lower = text.toLowerCase();
  return REFUSAL_PHRASES.some((phrase) => lower.includes(phrase));
}

/**
 * Detect guardrails from heuristic signals (always marked low confidence).
 */
export function detectHeuristic(
  attrs: Record<string, unknown>,
  traceId?: string | null,
  spanId?: string | null,
  enabled: boolean = true,
): GuardrailFindingWithMeta[] {
  if (!enabled) {
    return [];
  }
  
  const findings: GuardrailFindingWithMeta[] = [];
  
  const spanType = attrs[ATTR_SPAN_TYPE] || attrs[ATTR_AGENT_SPAN_TYPE] || "";
  const errorType = String(attrs[ATTR_ERROR_TYPE] || "");
  const errorMsg = String(attrs[ATTR_ERROR_MESSAGE] || "").toLowerCase();
  
  if (["tool", "function"].includes(String(spanType)) && errorType) {
    // Skip non-denial errors
    if (!NON_DENIAL_ERROR_TYPES.has(errorType)) {
      const denialKeywords = ["permission", "denied", "unauthorized", "forbidden", "not allowed"];
      if (denialKeywords.some((kw) => errorMsg.includes(kw))) {
        findings.push(createGuardrailFinding({
          category: GuardrailCategory.TOOL_PERMISSION,
          name: "inferred_tool_denial",
          source_type: SourceType.HEURISTIC,
          confidence: Confidence.LOW,
          triggered: true,
          detection_reason: "tool_span_error_with_denial_keywords",
          evidence_ref: {
            trace_id: traceId,
            span_id: spanId,
            integration: "heuristic",
            attribute_keys: [ATTR_ERROR_TYPE, ATTR_ERROR_MESSAGE],
          },
          raw_excerpt: errorMsg.slice(0, 200),
        }));
      }
    }
  }
  
  return findings;
}

/**
 * Run all detection tiers on a span's attributes and return findings.
 */
export function detectAll(
  attrs: Record<string, unknown>,
  traceId?: string | null,
  spanId?: string | null,
  heuristicsEnabled: boolean = true,
): GuardrailFindingWithMeta[] {
  const results: GuardrailFindingWithMeta[] = [];
  results.push(...detectExplicit(attrs, traceId, spanId));
  results.push(...detectProviderNative(attrs, traceId, spanId));
  results.push(...detectHeuristic(attrs, traceId, spanId, heuristicsEnabled));
  return results;
}