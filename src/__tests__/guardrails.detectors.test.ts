import { detectAll, detectExplicit, detectProviderNative, detectHeuristic } from '../guardrails/detectors';
import { GuardrailCategory, Confidence, SourceType, EnforcementMode } from '../guardrails/schema';

describe('detectExplicit', () => {
    it('should detect explicit manual guardrail attributes', () => {
        const attrs = {
            'span.type': 'guardrail',
            'guardrail.category': 'moderation',
            'guardrail.name': 'content_filter',
            'guardrail.triggered': true,
        };

        const findings = detectExplicit(attrs, 'test-trace', 'test-span');

        expect(findings.length).toBe(1);
        expect(findings[0].category).toBe(GuardrailCategory.MODERATION);
        expect(findings[0].name).toBe('content_filter');
        expect(findings[0].source_type).toBe(SourceType.EXPLICIT);
        expect(findings[0].confidence).toBe(Confidence.HIGH);
    });

    it('should detect openai_agents guardrail span', () => {
        const attrs = {
            'agent.span.type': 'guardrail',
            'guardrail.category': 'pii',
            'agent.guardrail.name': 'my_guard',
            'agent.guardrail.triggered': true,
        };

        const findings = detectExplicit(attrs, 'test-trace', 'test-span');

        expect(findings.length).toBe(1);
        expect(findings[0].category).toBe(GuardrailCategory.PII);
        expect(findings[0].name).toBe('my_guard');
        expect(findings[0].triggered).toBe(true);
    });

    it('should fallback to UNKNOWN for invalid category', () => {
        const attrs = {
            'span.type': 'guardrail',
            'guardrail.category': 'invalid_cat',
        };

        const findings = detectExplicit(attrs, 'test-trace', 'test-span');
        expect(findings[0].category).toBe(GuardrailCategory.UNKNOWN);
        expect(findings[0].confidence).toBe(Confidence.MEDIUM); // missing name/triggered
    });

    it('should return empty array when no explicit guardrails', () => {
        const findings = detectExplicit({}, 'test-trace', 'test-span');
        expect(findings.length).toBe(0);
    });
});

describe('detectProviderNative', () => {
    it('should detect openai/azure finish_reason content filter', () => {
        const attrs = {
            'llm.finish_reason': 'content_filter',
            'llm.vendor': 'azure'
        };
        const findings = detectProviderNative(attrs);
        expect(findings.length).toBe(1);
        expect(findings[0].name).toBe('provider_content_filter');
        expect(findings[0].enforcement_mode).toBe(EnforcementMode.BLOCK);
    });

    it('should detect anthropic stop_reason content filter', () => {
        const attrs = {
            'llm.stop_reason': 'content_filtered',
            'llm.vendor': 'anthropic'
        };
        const findings = detectProviderNative(attrs);
        expect(findings.length).toBe(1);
        expect(findings[0].name).toBe('anthropic_content_filter');
    });

    it('should detect anthropic error message policy violation', () => {
        const attrs = {
            'llm.vendor': 'anthropic',
            'error.message': 'Usage policy violation detected',
            'span.type': 'llm'
        };
        const findings = detectProviderNative(attrs);
        expect(findings.length).toBe(1);
        expect(findings[0].name).toBe('anthropic_policy_violation');
    });

    it('should detect google safety_ratings blocked or high', () => {
        const attrs = {
            'llm.safety_ratings': JSON.stringify([
                { category: 'HARM_CATEGORY_HATE_SPEECH', probability: 'HIGH' }
            ])
        };
        const findings = detectProviderNative(attrs);
        expect(findings.length).toBe(1);
        expect(findings[0].name).toBe('google_safety_ratings_blocked');
    });

    it('should detect google safety_ratings blocked boolean', () => {
        const attrs = {
            'llm.safety_ratings': JSON.stringify([
                { blocked: true }
            ])
        };
        const findings = detectProviderNative(attrs);
        expect(findings.length).toBe(1);
    });

    it('should skip invalid json in safety ratings', () => {
        const attrs = {
            'llm.safety_ratings': 'invalid json'
        };
        const findings = detectProviderNative(attrs);
        expect(findings.length).toBe(0);
    });

    it('should detect refusal in completion', () => {
        const attrs = {
            'llm.response.status': 'failed',
            'llm.completion': 'I cannot help with that as it violates my usage policies'
        };
        const findings = detectProviderNative(attrs);
        expect(findings.length).toBe(1);
        expect(findings[0].name).toBe('provider_refusal');
    });
});

describe('detectHeuristic', () => {
    it('should detect error-based guardrails', () => {
        const attrs = {
            'span.type': 'tool',
            'error.type': 'PermissionError',
            'error.message': 'access denied',
        };

        const findings = detectHeuristic(attrs, 'test-trace', 'test-span');

        expect(findings.length).toBeGreaterThan(0);
    });

    it('should detect prompt injection keywords in errors', () => {
        const attrs = {
            'span.type': 'tool',
            'error.type': 'ValidationError',
            'error.message': 'Permission denied for prompt injection in input',
        };

        const findings = detectHeuristic(attrs, 'test-trace', 'test-span');

        const toolPermissionFinding = findings.find(f => f.category === GuardrailCategory.TOOL_PERMISSION);
        expect(toolPermissionFinding).toBeDefined();
    });

    it('should return empty array when heuristics disabled', () => {
        const attrs = {
            'error.message': 'Some error',
        };

        const findings = detectHeuristic(attrs, 'test-trace', 'test-span', false);
        expect(findings.length).toBe(0);
    });
});

describe('detectAll', () => {
    it('should combine findings from all detectors', () => {
        const attrs = {
            'span.type': 'guardrail',
            'guardrail.category': 'pii',
            'guardrail.name': 'pii_detector',
            'llm.vendor': 'azure',
            'llm.finish_reason': 'content_filter'
        };

        const findings = detectAll(attrs, 'test-trace', 'test-span', true);

        expect(findings.length).toBe(2);
    });

    it('should respect heuristicsEnabled flag', () => {
        const attrs = {
            'span.type': 'tool',
            'error.type': 'PermissionError',
            'error.message': 'access denied',
        };

        const withHeuristics = detectAll(attrs, 'test-trace', 'test-span', true);
        const withoutHeuristics = detectAll(attrs, 'test-trace', 'test-span', false);

        expect(withHeuristics.length).toBeGreaterThan(withoutHeuristics.length);
    });
});