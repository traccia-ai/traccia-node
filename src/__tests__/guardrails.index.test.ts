import * as guardrailsIndex from '../guardrails/index';

describe('Guardrails Index', () => {
    it('should export all expected members', () => {
        const expectedExports = [
            'GuardrailCategory',
            'SourceType',
            'Confidence',
            'EnforcementMode',
            'FindingStatus',
            'computeGuardrailFindingId',
            'getGuardrailFindingStatus',
            'createGuardrailFinding',
            'dedupeFindings',
            'ATTR_GUARDRAIL_CATEGORY',
            'ATTR_GUARDRAIL_NAME',
            'ATTR_GUARDRAIL_TRIGGERED',
            'ATTR_GUARDRAIL_ENFORCEMENT_MODE',
            'ATTR_GUARDRAIL_POLICY_ID',
            'ATTR_GUARDRAIL_SOURCE_SDK',
            'ATTR_GUARDRAIL_EVIDENCE_TYPE',
            'ATTR_GUARDRAIL_SUPPRESS_MISSING',
            'ATTR_SPAN_TYPE',
            'ATTR_AGENT_SPAN_TYPE',
            'ATTR_LLM_MODEL',
            'ATTR_LLM_PROMPT',
            'ATTR_LLM_COMPLETION',
            'ATTR_LLM_FINISH_REASON',
            'ATTR_LLM_STOP_REASON',
            'ATTR_LLM_SAFETY_RATINGS',
            'ATTR_LLM_VENDOR',
            'ATTR_ERROR_TYPE',
            'ATTR_ERROR_MESSAGE',
            'detectAll',
            'detectExplicit',
            'detectProviderNative',
            'detectHeuristic',
            'evaluateRun',
            'validateGuardrailAttributes',
            'guardrailSpan',
        ];

        for (const exp of expectedExports) {
            expect((guardrailsIndex as any)[exp]).toBeDefined();
        }
    });
});
