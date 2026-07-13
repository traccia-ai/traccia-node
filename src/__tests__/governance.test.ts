/**
 * Tests for governance enrichment processor.
 */

import {
  GovernanceEnrichmentProcessor,
  _resetHipaaWarnForTests,
} from '../processor/governance-enrichment';
import { TracerProvider } from '../tracer/provider';

describe('GovernanceEnrichmentProcessor', () => {
  beforeEach(() => {
    _resetHipaaWarnForTests();
  });

  it('should add governance attributes to span', () => {
    const processor = new GovernanceEnrichmentProcessor();
    const provider = new TracerProvider();
    const tracer = provider.getTracer('test');

    const span = tracer.startSpan('test-span', {
      attributes: { 'llm.model': 'gpt-4' },
    });

    processor.onEnd(span);
    span.end();

    expect(span.attributes['governance.event_type']).toBeDefined();
    expect(span.attributes['governance.timestamp_source']).toBe('sdk');
    expect(span.attributes['governance.integrity_hash']).toBeDefined();
  });

  it('should infer tool_call event type from span name', () => {
    const processor = new GovernanceEnrichmentProcessor();
    const provider = new TracerProvider();
    const tracer = provider.getTracer('test');

    const span = tracer.startSpan('tool.my_function');

    processor.onEnd(span);
    span.end();

    expect(span.attributes['governance.event_type']).toBe('tool_call');
  });

  it('should set risk tier when configured', () => {
    const processor = new GovernanceEnrichmentProcessor({ euRiskTier: 'high' });
    const provider = new TracerProvider();
    const tracer = provider.getTracer('test');

    const span = tracer.startSpan('test-span');

    processor.onEnd(span);
    span.end();

    expect(span.attributes['eu_ai_act.risk_tier']).toBe('high');
  });

  it('should not overwrite existing event type', () => {
    const processor = new GovernanceEnrichmentProcessor();
    const provider = new TracerProvider();
    const tracer = provider.getTracer('test');

    const span = tracer.startSpan('test-span', {
      attributes: { 'governance.event_type': 'custom_type' },
    });

    processor.onEnd(span);
    span.end();

    expect(span.attributes['governance.event_type']).toBe('custom_type');
  });

  it('ignores span.type and defaults event_type to inference', () => {
    const processor = new GovernanceEnrichmentProcessor();
    const provider = new TracerProvider();
    const tracer = provider.getTracer('test');

    const span = tracer.startSpan('chat.streamText', {
      attributes: { 'span.type': 'LLM' },
    });

    processor.onEnd(span);
    span.end();

    expect(span.attributes['governance.event_type']).toBe('inference');
  });

  it('sets hipaa attrs and warns once when hipaaEnabled', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const processor = new GovernanceEnrichmentProcessor({ hipaaEnabled: true });
    const provider = new TracerProvider();
    const tracer = provider.getTracer('test');

    const span1 = tracer.startSpan('s1', {
      attributes: { 'governance.redaction_applied': true },
    });
    processor.onEnd(span1);
    const span2 = tracer.startSpan('s2');
    processor.onEnd(span2);

    expect(span1.attributes['hipaa.framework_enabled']).toBe(true);
    expect(span1.attributes['hipaa.phi_redaction_applied']).toBe(true);
    expect(span2.attributes['hipaa.framework_enabled']).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('skips hipaa attrs when framework disabled', () => {
    const processor = new GovernanceEnrichmentProcessor({ hipaaEnabled: false });
    const provider = new TracerProvider();
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('s');
    processor.onEnd(span);
    expect(span.attributes['hipaa.framework_enabled']).toBeUndefined();
  });

  it('forceFlush and shutdown are no-ops', () => {
    const processor = new GovernanceEnrichmentProcessor();
    expect(() => processor.shutdown()).not.toThrow();
    expect(() => processor.forceFlush()).not.toThrow();
  });

  it('returns early when setAttribute is missing', () => {
    const processor = new GovernanceEnrichmentProcessor();
    expect(() => processor.onEnd({ name: 'x', attributes: {} } as never)).not.toThrow();
  });

  it('triggers before-execute hooks on start', () => {
    const processor = new GovernanceEnrichmentProcessor();
    const provider = new TracerProvider();
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('hooked');
    expect(() => processor.onStart(span)).not.toThrow();
  });
});