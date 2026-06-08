/**
 * Missing-guardrail evaluator: infer agent capabilities from trace spans,
 * apply a required-guardrail matrix, and report missing categories.
 */

import {
  GuardrailFindingWithMeta,
  GuardrailCategory,
  Confidence,
  MissingGuardrail,
  GuardrailSummary,
  dedupeFindings,
} from "./schema";
import {
  ATTR_SPAN_TYPE,
  ATTR_AGENT_SPAN_TYPE,
  ATTR_AGENT_TOOL_NAME,
  ATTR_LLM_MODEL,
  ATTR_LLM_PROMPT,
  ATTR_LLM_COMPLETION,
  ATTR_GUARDRAIL_SUPPRESS_MISSING,
} from "./constants";

/**
 * Capabilities observed across all spans of a run.
 */
class Capabilities {
  callsLlm = false;
  handlesUserText = false;
  producesUserText = false;
  usesTools = false;
  hasExternalActions = false;
  private evidence: Record<string, string[]> = {
    calls_llm: [],
    handles_user_text: [],
    produces_user_text: [],
    uses_tools: [],
    has_external_actions: [],
  };

  observeSpan(attrs: Record<string, unknown>, spanId?: string | null): void {
    const sid = spanId || "";
    
    if (attrs[ATTR_LLM_MODEL] !== undefined && attrs[ATTR_LLM_MODEL] !== null) {
      this.callsLlm = true;
      this.evidence.calls_llm.push(sid);
    }
    
    if (attrs[ATTR_LLM_PROMPT] !== undefined && attrs[ATTR_LLM_PROMPT] !== null) {
      this.handlesUserText = true;
      this.evidence.handles_user_text.push(sid);
    }
    
    if (attrs[ATTR_LLM_COMPLETION] !== undefined && attrs[ATTR_LLM_COMPLETION] !== null) {
      this.producesUserText = true;
      this.evidence.produces_user_text.push(sid);
    }
    
    const spanType = String(attrs[ATTR_SPAN_TYPE] || attrs[ATTR_AGENT_SPAN_TYPE] || "");
    if (spanType === "tool" || spanType === "function" || attrs[ATTR_AGENT_TOOL_NAME] !== undefined) {
      this.usesTools = true;
      this.evidence.uses_tools.push(sid);
      this.hasExternalActions = true;
      this.evidence.has_external_actions.push(sid);
    }
    
    if (spanType === "handoff") {
      this.hasExternalActions = true;
      this.evidence.has_external_actions.push(sid);
    }
  }

  toList(): string[] {
    const out: string[] = [];
    if (this.callsLlm) out.push("calls_llm");
    if (this.handlesUserText) out.push("handles_user_text");
    if (this.producesUserText) out.push("produces_user_text");
    if (this.usesTools) out.push("uses_tools");
    if (this.hasExternalActions) out.push("has_external_actions");
    return out;
  }

  evidenceFor(cap: string): string[] {
    return this.evidence[cap] || [];
  }
}

/**
 * Return all guardrail categories that should exist given capabilities.
 */
function requiredCategories(caps: Capabilities): MissingGuardrail[] {
  const required: MissingGuardrail[] = [];
  
  if (caps.callsLlm && caps.handlesUserText) {
    required.push({
      category: GuardrailCategory.INPUT_VALIDATION,
      why_required: "Agent makes LLM calls with prompt data (may be user-provided)",
      missing_confidence: Confidence.MEDIUM,
      evidence_ref: { attribute_keys: ["calls_llm", "handles_user_text"] },
    });
    required.push({
      category: GuardrailCategory.PROMPT_INJECTION,
      why_required: "Agent makes LLM calls with prompt data (may be user-provided)",
      missing_confidence: Confidence.MEDIUM,
      evidence_ref: { attribute_keys: ["calls_llm", "handles_user_text"] },
    });
  }
  
  if (caps.producesUserText) {
    required.push({
      category: GuardrailCategory.OUTPUT_VALIDATION,
      why_required: "Agent produces text output visible to users",
      missing_confidence: Confidence.MEDIUM,
      evidence_ref: { attribute_keys: ["produces_user_text"] },
    });
    required.push({
      category: GuardrailCategory.MODERATION,
      why_required: "Agent produces text output visible to users",
      missing_confidence: Confidence.MEDIUM,
      evidence_ref: { attribute_keys: ["produces_user_text"] },
    });
  }
  
  if (caps.usesTools) {
    required.push({
      category: GuardrailCategory.TOOL_PERMISSION,
      why_required: "Agent uses tool/function calls",
      missing_confidence: Confidence.HIGH,
      evidence_ref: { attribute_keys: ["uses_tools"] },
    });
  }
  
  return required;
}

/**
 * Produce a full GuardrailSummary for a single agent run.
 */
export function evaluateRun(params: {
  allSpanAttrs: Record<string, unknown>[];
  spanIds: (string | null)[];
  findings: GuardrailFindingWithMeta[];
  heuristicsEnabled?: boolean;
}): GuardrailSummary {
  const { allSpanAttrs, spanIds, findings } = params;
  
  // 1. Infer capabilities and collect suppression requests
  const caps = new Capabilities();
  const suppressedCats = new Set<string>();
  
  for (let i = 0; i < allSpanAttrs.length; i++) {
    const attrs = allSpanAttrs[i];
    const sid = spanIds[i];
    caps.observeSpan(attrs, sid);
    
    const suppressVal = attrs[ATTR_GUARDRAIL_SUPPRESS_MISSING];
    if (suppressVal) {
      if (Array.isArray(suppressVal)) {
        suppressVal.forEach((v) => suppressedCats.add(String(v)));
      } else {
        String(suppressVal).split(",").forEach((s) => {
          const trimmed = s.trim();
          if (trimmed) {
            suppressedCats.add(trimmed);
          }
        });
      }
    }
  }
  
  // 2. Dedupe findings
  const deduped = dedupeFindings(findings);
  
  // 3. Compute detected and triggered categories
  const detectedCats = new Set<string>();
  const confidentDetectedCats = new Set<string>();
  const triggeredCats = new Set<string>();
  
  for (const f of deduped) {
    detectedCats.add(f.category);
    if (f.triggered === true) {
      triggeredCats.add(f.category);
    }
    if (f.confidence !== Confidence.LOW) {
      confidentDetectedCats.add(f.category);
    }
  }
  
  // 4. Compute missing categories
  const required = requiredCategories(caps);
  const missing: MissingGuardrail[] = [];
  
  for (const req of required) {
    const cat = req.category.toString();
    if (!suppressedCats.has(cat) && !confidentDetectedCats.has(cat)) {
      missing.push(req);
    }
  }
  
  // 5. Compute coverage confidence
  let cov = Confidence.LOW;
  if (deduped.length > 0) {
    if (deduped.every((f) => f.confidence === Confidence.HIGH)) {
      cov = Confidence.HIGH;
    } else if (deduped.some((f) => f.confidence === Confidence.HIGH)) {
      cov = Confidence.MEDIUM;
    }
  }
  
  // 6. Build limitations
  const limitations: string[] = [];
  if (!caps.callsLlm && !caps.usesTools) {
    limitations.push(
      "No LLM or tool spans observed; capability inference may be incomplete.",
    );
  }
  if (deduped.length === 0) {
    limitations.push(
      "No guardrail signals detected in trace; agent may have out-of-band guardrails not visible to tracing.",
    );
  }
  if (deduped.some((f) => f.confidence === Confidence.LOW)) {
    limitations.push(
      "Some findings are heuristic-only (low confidence); verify independently.",
    );
  }
  if (missing.length > 0) {
    limitations.push(
      `${missing.length} expected guardrail categor${missing.length === 1 ? "y" : "ies"} not detected in trace.`,
    );
  }
  
  return {
    detected_categories: Array.from(detectedCats).sort(),
    triggered_categories: Array.from(triggeredCats).sort(),
    missing_categories: missing,
    coverage_confidence: cov,
    capabilities_observed: caps.toList(),
    limitations,
  };
}