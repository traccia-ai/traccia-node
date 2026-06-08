/**
 * Canonical guardrail detection schema for Traccia traces.
 * 
 * Defines the normalized data contract for guardrail findings, missing-guardrail
 * evaluations, and per-run summaries.
 */

export enum GuardrailCategory {
  INPUT_VALIDATION = "input_validation",
  PROMPT_INJECTION = "prompt_injection",
  PII = "pii",
  MODERATION = "moderation",
  TOOL_PERMISSION = "tool_permission",
  OUTPUT_VALIDATION = "output_validation",
  RATE_LIMIT = "rate_limit",
  UNKNOWN = "unknown",
}

export enum SourceType {
  EXPLICIT = "explicit",
  PROVIDER_NATIVE = "provider_native",
  HEURISTIC = "heuristic",
}

export enum Confidence {
  HIGH = "high",
  MEDIUM = "medium",
  LOW = "low",
}

export enum EnforcementMode {
  BLOCK = "block",
  WARN = "warn",
  LOG_ONLY = "log_only",
  UNKNOWN = "unknown",
}

export enum FindingStatus {
  PRESENT = "present",
  TRIGGERED = "triggered",
  NOT_TRIGGERED = "not_triggered",
}

export interface EvidenceRef {
  trace_id?: string | null;
  span_id?: string | null;
  integration?: string | null;
  attribute_keys: string[];
}

export interface GuardrailFinding {
  category: GuardrailCategory;
  name: string;
  source_type: SourceType;
  confidence: Confidence;
  triggered?: boolean | null;
  enforcement_mode: EnforcementMode;
  detection_reason: string;
  evidence_ref: EvidenceRef;
  raw_excerpt?: string | null;
}

/** Guardrail finding with computed id and status properties */
export type GuardrailFindingWithMeta = GuardrailFinding & {
  /** Stable fingerprint for deduplication (computed from evidence) */
  readonly id: string;
  /** Status derived from triggered value */
  readonly status: FindingStatus;
};

export interface MissingGuardrail {
  category: GuardrailCategory;
  why_required: string;
  missing_confidence: Confidence;
  evidence_ref: EvidenceRef;
}

export interface GuardrailSummary {
  detected_categories: string[];
  triggered_categories: string[];
  missing_categories: MissingGuardrail[];
  coverage_confidence: Confidence;
  capabilities_observed: string[];
  limitations: string[];
}

/**
 * EvidenceRef to dictionary conversion.
 */
export function evidenceRefToDict(evidence: EvidenceRef): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (evidence.trace_id !== undefined && evidence.trace_id !== null) {
    result.trace_id = evidence.trace_id;
  }
  if (evidence.span_id !== undefined && evidence.span_id !== null) {
    result.span_id = evidence.span_id;
  }
  if (evidence.integration !== undefined && evidence.integration !== null) {
    result.integration = evidence.integration;
  }
  if (evidence.attribute_keys.length > 0) {
    result.attribute_keys = evidence.attribute_keys;
  }
  return result;
}

/**
 * Compute guardrail finding ID (stable fingerprint for deduplication).
 */
export function computeGuardrailFindingId(finding: GuardrailFinding): string {
  const key = [
    finding.evidence_ref.trace_id || "",
    finding.source_type.toString(),
    finding.category,
    finding.name,
    finding.evidence_ref.span_id || "",
  ].join("|");
  
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/**
 * Get status derived from triggered value.
 */
export function getGuardrailFindingStatus(finding: GuardrailFinding): FindingStatus {
  if (finding.triggered === true) {
    return FindingStatus.TRIGGERED;
  }
  if (finding.triggered === false) {
    return FindingStatus.NOT_TRIGGERED;
  }
  return FindingStatus.PRESENT;
}

/**
 * Create a guardrail finding with computed id and status.
 */
export function createGuardrailFinding(params: {
  category: GuardrailCategory;
  name: string;
  source_type: SourceType;
  confidence: Confidence;
  triggered?: boolean | null;
  enforcement_mode?: EnforcementMode;
  detection_reason?: string;
  evidence_ref?: EvidenceRef;
  raw_excerpt?: string | null;
}): GuardrailFindingWithMeta {
  const finding: GuardrailFinding = {
    category: params.category,
    name: params.name,
    source_type: params.source_type,
    confidence: params.confidence,
    triggered: params.triggered ?? null,
    enforcement_mode: params.enforcement_mode ?? EnforcementMode.UNKNOWN,
    detection_reason: params.detection_reason ?? "",
    evidence_ref: params.evidence_ref ?? { attribute_keys: [] },
    raw_excerpt: params.raw_excerpt ?? null,
  };
  
  const id = computeGuardrailFindingId(finding);
  const status = getGuardrailFindingStatus(finding);
  
  return { ...finding, id, status };
}

/**
 * GuardrailSummary to dictionary conversion.
 */
export function guardrailSummaryToDict(summary: GuardrailSummary): Record<string, unknown> {
  return {
    detected_categories: summary.detected_categories,
    triggered_categories: summary.triggered_categories,
    missing_categories: summary.missing_categories.map((m) => ({
      category: m.category,
      why_required: m.why_required,
      missing_confidence: m.missing_confidence,
      evidence_ref: evidenceRefToDict(m.evidence_ref),
    })),
    coverage_confidence: summary.coverage_confidence,
    capabilities_observed: summary.capabilities_observed,
    limitations: summary.limitations,
  };
}

/**
 * Deduplicate findings by stable id, keeping highest-confidence version.
 */
export function dedupeFindings(findings: GuardrailFinding[]): GuardrailFinding[] {
  const priority: Record<Confidence, number> = {
    [Confidence.HIGH]: 0,
    [Confidence.MEDIUM]: 1,
    [Confidence.LOW]: 2,
  };
  
  const byId = new Map<string, GuardrailFinding>();
  
  for (const f of findings) {
    const fid = computeGuardrailFindingId(f);
    const existing = byId.get(fid);
    if (!existing || (priority[f.confidence] ?? 3) < (priority[existing.confidence] ?? 3)) {
      byId.set(fid, f);
    }
  }
  
  return Array.from(byId.values());
}