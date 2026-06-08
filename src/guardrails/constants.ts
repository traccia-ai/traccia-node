/**
 * Guardrail detection attribute constants.
 */

// Guardrail attribute keys
export const ATTR_GUARDRAIL_CATEGORY = "guardrail.category";
export const ATTR_GUARDRAIL_NAME = "guardrail.name";
export const ATTR_GUARDRAIL_TRIGGERED = "guardrail.triggered";
export const ATTR_GUARDRAIL_ENFORCEMENT_MODE = "guardrail.enforcement_mode";
export const ATTR_GUARDRAIL_POLICY_ID = "guardrail.policy_id";
export const ATTR_GUARDRAIL_SOURCE_SDK = "guardrail.source_sdk";
export const ATTR_GUARDRAIL_EVIDENCE_TYPE = "guardrail.evidence_type";

// Llm response status (for refusal detection)
export const ATTR_LLM_RESPONSE_STATUS = "llm.response.status";

// Existing span attributes consumed by detectors
export const ATTR_SPAN_TYPE = "span.type";
export const ATTR_AGENT_SPAN_TYPE = "agent.span.type";
export const ATTR_AGENT_GUARDRAIL_NAME = "agent.guardrail.name";
export const ATTR_AGENT_GUARDRAIL_TRIGGERED = "agent.guardrail.triggered";
export const ATTR_AGENT_TOOL_NAME = "agent.tool.name";
export const ATTR_LLM_MODEL = "llm.model";
export const ATTR_LLM_PROMPT = "llm.prompt";
export const ATTR_LLM_COMPLETION = "llm.completion";
export const ATTR_LLM_FINISH_REASON = "llm.finish_reason";
export const ATTR_LLM_VENDOR = "llm.vendor";
export const ATTR_LLM_STOP_REASON = "llm.stop_reason";
export const ATTR_LLM_SAFETY_RATINGS = "llm.safety_ratings";
export const ATTR_ERROR_TYPE = "error.type";
export const ATTR_ERROR_MESSAGE = "error.message";

// Suppression attribute
export const ATTR_GUARDRAIL_SUPPRESS_MISSING = "traccia.guardrail.suppress_missing";