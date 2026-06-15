import { evaluateRun } from '../guardrails/evaluator';
import {
    GuardrailCategory,
    Confidence,
    GuardrailFindingWithMeta,
    FindingStatus,
    SourceType,
    EnforcementMode
} from '../guardrails/schema';
import {
    ATTR_LLM_MODEL,
    ATTR_LLM_PROMPT,
    ATTR_LLM_COMPLETION,
    ATTR_SPAN_TYPE,
    ATTR_AGENT_SPAN_TYPE,
    ATTR_AGENT_TOOL_NAME,
    ATTR_GUARDRAIL_SUPPRESS_MISSING
} from '../guardrails/constants';

describe('evaluateRun', () => {
    it('should infer no capabilities if no spans match', () => {
        const summary = evaluateRun({
            allSpanAttrs: [{}],
            spanIds: ['span-1'],
            findings: []
        });

        expect(summary.capabilities_observed).toEqual([]);
        expect(summary.missing_categories).toEqual([]);
        expect(summary.limitations).toContain("No LLM or tool spans observed; capability inference may be incomplete.");
        expect(summary.limitations).toContain("No guardrail signals detected in trace; agent may have out-of-band guardrails not visible to tracing.");
    });

    it('should infer LLM and text capabilities', () => {
        const summary = evaluateRun({
            allSpanAttrs: [{
                [ATTR_LLM_MODEL]: 'gpt-4',
                [ATTR_LLM_PROMPT]: 'hello',
                [ATTR_LLM_COMPLETION]: 'hi'
            }],
            spanIds: ['span-1'],
            findings: []
        });

        expect(summary.capabilities_observed).toEqual(expect.arrayContaining([
            'calls_llm', 'handles_user_text', 'produces_user_text'
        ]));

        expect(summary.missing_categories.length).toBeGreaterThan(0);
        const categories = summary.missing_categories.map(m => m.category);
        expect(categories).toContain(GuardrailCategory.INPUT_VALIDATION);
        expect(categories).toContain(GuardrailCategory.PROMPT_INJECTION);
        expect(categories).toContain(GuardrailCategory.OUTPUT_VALIDATION);
        expect(categories).toContain(GuardrailCategory.MODERATION);
    });

    it('should infer tool usage', () => {
        const summary = evaluateRun({
            allSpanAttrs: [{
                [ATTR_SPAN_TYPE]: 'tool'
            }, {
                [ATTR_AGENT_TOOL_NAME]: 'search'
            }, {
                [ATTR_AGENT_SPAN_TYPE]: 'handoff'
            }],
            spanIds: ['1', '2', '3'],
            findings: []
        });

        expect(summary.capabilities_observed).toContain('uses_tools');
        expect(summary.capabilities_observed).toContain('has_external_actions');

        const categories = summary.missing_categories.map(m => m.category);
        expect(categories).toContain(GuardrailCategory.TOOL_PERMISSION);
    });

    it('should respect suppressions (string or array)', () => {
        const summary = evaluateRun({
            allSpanAttrs: [{
                [ATTR_LLM_MODEL]: 'gpt-4',
                [ATTR_LLM_PROMPT]: 'hello',
                [ATTR_GUARDRAIL_SUPPRESS_MISSING]: `${GuardrailCategory.INPUT_VALIDATION}, ${GuardrailCategory.PROMPT_INJECTION}`
            }, {
                [ATTR_SPAN_TYPE]: 'tool',
                [ATTR_GUARDRAIL_SUPPRESS_MISSING]: [GuardrailCategory.TOOL_PERMISSION]
            }],
            spanIds: ['1', '2'],
            findings: []
        });

        // Everything suppressed
        expect(summary.missing_categories).toEqual([]);
    });

    it('should process detected findings', () => {
        const findings: GuardrailFindingWithMeta[] = [{
            id: 'f1',
            status: FindingStatus.TRIGGERED,
            category: GuardrailCategory.PII,
            name: 'test_rule',
            source_type: SourceType.EXPLICIT,
            confidence: Confidence.HIGH,
            enforcement_mode: EnforcementMode.LOG_ONLY,
            detection_reason: 'test',
            evidence_ref: { attribute_keys: [] },
            triggered: true
        }, {
            id: 'f2',
            status: FindingStatus.NOT_TRIGGERED,
            category: GuardrailCategory.INPUT_VALIDATION,
            name: 'test_rule2',
            source_type: SourceType.EXPLICIT,
            confidence: Confidence.LOW,
            enforcement_mode: EnforcementMode.LOG_ONLY,
            detection_reason: 'test',
            evidence_ref: { attribute_keys: [] },
            triggered: false
        }];

        const summary = evaluateRun({
            allSpanAttrs: [{
                [ATTR_LLM_MODEL]: 'gpt-4',
                [ATTR_LLM_PROMPT]: 'hello',
            }],
            spanIds: ['1'],
            findings
        });

        expect(summary.detected_categories).toEqual(expect.arrayContaining([GuardrailCategory.PII, GuardrailCategory.INPUT_VALIDATION]));
        expect(summary.triggered_categories).toEqual([GuardrailCategory.PII]);
        expect(summary.coverage_confidence).toBe(Confidence.MEDIUM); // High + Low = Medium
        
        // Input validation is missing because confidence is LOW, so it's not "confidentDetectedCats"
        const missingCats = summary.missing_categories.map(m => m.category);
        expect(missingCats).toContain(GuardrailCategory.INPUT_VALIDATION);
        
        expect(summary.limitations).toContain("Some findings are heuristic-only (low confidence); verify independently.");
    });
});
