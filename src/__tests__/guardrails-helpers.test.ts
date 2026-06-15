import { validateGuardrailAttributes, guardrailSpan } from '../guardrails/helpers';
import { getTracer } from '../auto';
import {
  ATTR_GUARDRAIL_CATEGORY,
  ATTR_GUARDRAIL_ENFORCEMENT_MODE,
  ATTR_GUARDRAIL_NAME,
  ATTR_GUARDRAIL_SOURCE_SDK,
  ATTR_GUARDRAIL_TRIGGERED,
  ATTR_GUARDRAIL_SUPPRESS_MISSING,
  ATTR_GUARDRAIL_EVIDENCE_TYPE
} from '../guardrails/constants';

jest.mock('../auto', () => ({
  getTracer: jest.fn()
}));

describe('guardrails helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('validateGuardrailAttributes', () => {
    it('should return empty warnings when all required attributes are present', () => {
      const attrs = {
        [ATTR_GUARDRAIL_NAME]: 'pii_check',
        [ATTR_GUARDRAIL_CATEGORY]: 'pii',
        [ATTR_GUARDRAIL_TRIGGERED]: true
      };
      
      const warnings = validateGuardrailAttributes(attrs);
      expect(warnings).toHaveLength(0);
    });

    it('should return warnings when attributes are missing', () => {
      const attrs = {
        [ATTR_GUARDRAIL_NAME]: 'pii_check',
      };
      
      const warnings = validateGuardrailAttributes(attrs);
      expect(warnings).toHaveLength(2);
      expect(warnings).toContain(`Missing recommended guardrail attribute: ${ATTR_GUARDRAIL_CATEGORY}`);
      expect(warnings).toContain(`Missing recommended guardrail attribute: ${ATTR_GUARDRAIL_TRIGGERED}`);
    });

    it('should not require triggered if requireTriggered is false', () => {
      const attrs = {
        [ATTR_GUARDRAIL_NAME]: 'pii_check',
        [ATTR_GUARDRAIL_CATEGORY]: 'pii'
      };
      
      const warnings = validateGuardrailAttributes(attrs, { requireTriggered: false });
      expect(warnings).toHaveLength(0);
    });
  });

  describe('guardrailSpan', () => {
    let mockStartSpan: jest.Mock;

    beforeEach(() => {
      mockStartSpan = jest.fn().mockReturnValue({
        setAttribute: jest.fn(),
        end: jest.fn()
      });

      (getTracer as jest.Mock).mockReturnValue({
        startSpan: mockStartSpan
      });
    });

    it('should create a span with default attributes', async () => {
      const span = await guardrailSpan('pii_check');
      
      expect(getTracer).toHaveBeenCalledWith('traccia.guardrails');
      expect(mockStartSpan).toHaveBeenCalledWith('guardrail.pii_check', {
        attributes: {
          'span.type': 'guardrail',
          [ATTR_GUARDRAIL_NAME]: 'pii_check',
          [ATTR_GUARDRAIL_CATEGORY]: 'unknown',
          [ATTR_GUARDRAIL_ENFORCEMENT_MODE]: 'unknown',
          [ATTR_GUARDRAIL_SOURCE_SDK]: 'manual_observe',
          [ATTR_GUARDRAIL_EVIDENCE_TYPE]: 'span_attribute'
        }
      });
      expect(span).toBeDefined();
    });

    it('should pass options into span attributes', async () => {
      await guardrailSpan('toxicity', {
        category: 'moderation',
        enforcementMode: 'warn',
        policyId: 'policy-123',
        suppressMissing: ['pii']
      });
      
      expect(mockStartSpan).toHaveBeenCalledWith('guardrail.toxicity', {
        attributes: expect.objectContaining({
          [ATTR_GUARDRAIL_CATEGORY]: 'moderation',
          [ATTR_GUARDRAIL_ENFORCEMENT_MODE]: 'warn',
          'guardrail.policy_id': 'policy-123',
          [ATTR_GUARDRAIL_SUPPRESS_MISSING]: ['pii']
        })
      });
    });
  });
});
