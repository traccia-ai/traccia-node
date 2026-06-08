/**
 * GovernanceEvent attribute keys (OpenTelemetry span attributes).
 */

export const GOVERNANCE_PREFIX = "governance.";
export const EU_AI_ACT_PREFIX = "eu_ai_act.";

export const EVENT_TYPE = `${GOVERNANCE_PREFIX}event_type`;
export const AI_SYSTEM_ID = `${GOVERNANCE_PREFIX}ai_system_id`;
export const SESSION_ID = `${GOVERNANCE_PREFIX}session_id`;
export const MODEL_ID = `${GOVERNANCE_PREFIX}model.id`;
export const MODEL_VERSION = `${GOVERNANCE_PREFIX}model.version`;
export const INPUT_HASH = `${GOVERNANCE_PREFIX}input_hash`;
export const OUTPUT_HASH = `${GOVERNANCE_PREFIX}output_hash`;
export const TIMESTAMP_SOURCE = `${GOVERNANCE_PREFIX}timestamp_source`;
export const REDACTION_APPLIED = `${GOVERNANCE_PREFIX}redaction_applied`;
export const INTEGRITY_HASH = `${GOVERNANCE_PREFIX}integrity_hash`;

export const RISK_TIER = `${EU_AI_ACT_PREFIX}risk_tier`;
export const ANNEX_III_CATEGORY = `${EU_AI_ACT_PREFIX}annex_iii_category`;

export const TRANSPARENCY_DISCLOSED = `${GOVERNANCE_PREFIX}transparency.disclosed`;
export const CONTENT_SYNTHETIC = `${GOVERNANCE_PREFIX}content.synthetic`;