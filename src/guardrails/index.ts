/**
 * Guardrail detection module.
 */

export {
  GuardrailCategory,
  SourceType,
  Confidence,
  EnforcementMode,
  FindingStatus,
} from "./schema";
export type { EvidenceRef, GuardrailFinding, GuardrailFindingWithMeta, MissingGuardrail, GuardrailSummary } from "./schema";

export {
  computeGuardrailFindingId,
  getGuardrailFindingStatus,
  createGuardrailFinding,
  dedupeFindings,
} from "./schema";

export {
  ATTR_GUARDRAIL_CATEGORY,
  ATTR_GUARDRAIL_NAME,
  ATTR_GUARDRAIL_TRIGGERED,
  ATTR_GUARDRAIL_ENFORCEMENT_MODE,
  ATTR_GUARDRAIL_POLICY_ID,
  ATTR_GUARDRAIL_SOURCE_SDK,
  ATTR_GUARDRAIL_EVIDENCE_TYPE,
  ATTR_GUARDRAIL_SUPPRESS_MISSING,
  ATTR_SPAN_TYPE,
  ATTR_AGENT_SPAN_TYPE,
  ATTR_LLM_MODEL,
  ATTR_LLM_PROMPT,
  ATTR_LLM_COMPLETION,
  ATTR_LLM_FINISH_REASON,
  ATTR_LLM_STOP_REASON,
  ATTR_LLM_SAFETY_RATINGS,
  ATTR_LLM_VENDOR,
  ATTR_ERROR_TYPE,
  ATTR_ERROR_MESSAGE,
} from "./constants";

export {
  detectAll,
  detectExplicit,
  detectProviderNative,
  detectHeuristic,
} from "./detectors";

export { evaluateRun } from "./evaluator";

export {
  validateGuardrailAttributes,
  guardrailSpan,
  GuardrailSpanOptions,
} from "./helpers";