/**
 * Tests for guardrail detectors.
 */

import { detectAll, detectExplicit, detectHeuristic } from '../guardrails/detectors';
import { GuardrailCategory, Confidence, SourceType } from '../guardrails/schema';

describe('detectExplicit', () => {
  it('should detect explicit guardrail attributes', () => {
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

  it('should return empty array when no explicit guardrails', () => {
    const findings = detectExplicit({}, 'test-trace', 'test-span');
    expect(findings.length).toBe(0);
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
    };

    const findings = detectAll(attrs, 'test-trace', 'test-span', true);

    expect(findings.length).toBeGreaterThan(0);
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