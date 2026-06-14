/**
 * Tests for guardrail detection.
 */

import {
  GuardrailCategory,
  SourceType,
  Confidence,
  EnforcementMode,
  FindingStatus,
  createGuardrailFinding,
  getGuardrailFindingStatus,
  dedupeFindings,
} from '../guardrails/schema';

describe('GuardrailCategory', () => {
  it('should have expected enum values', () => {
    expect(GuardrailCategory.INPUT_VALIDATION).toBe('input_validation');
    expect(GuardrailCategory.PROMPT_INJECTION).toBe('prompt_injection');
    expect(GuardrailCategory.PII).toBe('pii');
    expect(GuardrailCategory.MODERATION).toBe('moderation');
    expect(GuardrailCategory.TOOL_PERMISSION).toBe('tool_permission');
    expect(GuardrailCategory.OUTPUT_VALIDATION).toBe('output_validation');
    expect(GuardrailCategory.RATE_LIMIT).toBe('rate_limit');
    expect(GuardrailCategory.UNKNOWN).toBe('unknown');
  });
});

describe('SourceType', () => {
  it('should have expected enum values', () => {
    expect(SourceType.EXPLICIT).toBe('explicit');
    expect(SourceType.PROVIDER_NATIVE).toBe('provider_native');
    expect(SourceType.HEURISTIC).toBe('heuristic');
  });
});

describe('createGuardrailFinding', () => {
  it('should create a finding with id and status', () => {
    const finding = createGuardrailFinding({
      category: GuardrailCategory.MODERATION,
      name: 'content_moderation',
      source_type: SourceType.PROVIDER_NATIVE,
      confidence: Confidence.HIGH,
      triggered: true,
    });

    expect(finding.category).toBe(GuardrailCategory.MODERATION);
    expect(finding.name).toBe('content_moderation');
    expect(finding.source_type).toBe(SourceType.PROVIDER_NATIVE);
    expect(finding.confidence).toBe(Confidence.HIGH);
    expect(finding.triggered).toBe(true);
    expect(finding.id).toBeDefined();
    expect(finding.id.length).toBe(16);
    expect(finding.status).toBe(FindingStatus.TRIGGERED);
  });

  it('should set default values for optional fields', () => {
    const finding = createGuardrailFinding({
      category: GuardrailCategory.PII,
      name: 'pii_detector',
      source_type: SourceType.HEURISTIC,
      confidence: Confidence.MEDIUM,
    });

    expect(finding.triggered).toBeNull();
    expect(finding.enforcement_mode).toBe(EnforcementMode.UNKNOWN);
    expect(finding.detection_reason).toBe('');
    expect(finding.evidence_ref.attribute_keys).toEqual([]);
    expect(finding.status).toBe(FindingStatus.PRESENT);
  });
});

describe('getGuardrailFindingStatus', () => {
  it('should return TRIGGERED for true triggered', () => {
    const finding = { 
      category: GuardrailCategory.MODERATION, 
      name: 'test', 
      source_type: SourceType.EXPLICIT, 
      confidence: Confidence.HIGH, 
      enforcement_mode: EnforcementMode.WARN, 
      detection_reason: '', 
      evidence_ref: { attribute_keys: [] },
      triggered: true, 
    } as Parameters<typeof getGuardrailFindingStatus>[0];
    expect(getGuardrailFindingStatus(finding)).toBe(FindingStatus.TRIGGERED);
  });

  it('should return NOT_TRIGGERED for false triggered', () => {
    const finding = { 
      category: GuardrailCategory.MODERATION, 
      name: 'test', 
      source_type: SourceType.EXPLICIT, 
      confidence: Confidence.HIGH, 
      enforcement_mode: EnforcementMode.WARN, 
      detection_reason: '', 
      evidence_ref: { attribute_keys: [] },
      triggered: false, 
    } as Parameters<typeof getGuardrailFindingStatus>[0];
    expect(getGuardrailFindingStatus(finding)).toBe(FindingStatus.NOT_TRIGGERED);
  });

  it('should return PRESENT for null/undefined triggered', () => {
    const finding = { 
      category: GuardrailCategory.MODERATION, 
      name: 'test', 
      source_type: SourceType.EXPLICIT, 
      confidence: Confidence.HIGH, 
      enforcement_mode: EnforcementMode.WARN, 
      detection_reason: '', 
      evidence_ref: { attribute_keys: [] },
      triggered: null, 
    } as Parameters<typeof getGuardrailFindingStatus>[0];
    expect(getGuardrailFindingStatus(finding)).toBe(FindingStatus.PRESENT);
  });
});

describe('dedupeFindings', () => {
  it('should remove duplicates keeping highest confidence', () => {
    const findings = [
      createGuardrailFinding({
        category: GuardrailCategory.MODERATION,
        name: 'test',
        source_type: SourceType.EXPLICIT,
        confidence: Confidence.LOW,
      }),
      createGuardrailFinding({
        category: GuardrailCategory.MODERATION,
        name: 'test',
        source_type: SourceType.EXPLICIT,
        confidence: Confidence.HIGH,
      }),
    ];

    const deduped = dedupeFindings(findings);
    expect(deduped.length).toBe(1);
    expect(deduped[0].confidence).toBe(Confidence.HIGH);
  });
});