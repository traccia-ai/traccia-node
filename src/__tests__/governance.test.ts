/**
 * Tests for governance enrichment processor.
 */

import { GovernanceEnrichmentProcessor } from '../processor/governance-enrichment';
import { TracerProvider } from '../tracer/provider';

describe('GovernanceEnrichmentProcessor', () => {
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
});