import { GuardrailDetectorProcessor } from '../processor/guardrail-detector';

describe('Guardrail aggregation on trace roots (TRC-295)', () => {
  it('retains child aggregation until root ends and exports summary on root only', () => {
    const processor = new GuardrailDetectorProcessor({ heuristicsEnabled: true });
    const traceId = 'trc-295-trace';

    const childSpan: any = {
      attributes: {
        'llm.model': 'gpt-4o',
        'llm.finish_reason': 'content_filter',
      },
      setAttribute(key: string, value: any) {
        this.attributes[key] = value;
      },
      context: {
        traceId,
        spanId: 'child-span-456',
        traceState: undefined,
      },
      parentSpanId: 'root-span-123',
    };

    const rootSpan: any = {
      attributes: {
        'agent.name': 'support-agent',
      },
      setAttribute(key: string, value: any) {
        this.attributes[key] = value;
      },
      context: {
        traceId,
        spanId: 'root-span-123',
        traceState: undefined,
      },
      parentSpanId: undefined,
    };

    processor.onEnd(childSpan);

    expect(childSpan.attributes['guardrail.summary']).toBeUndefined();
    expect(childSpan.attributes['guardrail.summary.detected_categories']).toBeUndefined();
    expect(childSpan.attributes['guardrail.finding.count']).toBe(1);
    expect(childSpan.attributes['guardrail.findings']).toBeDefined();
    const childFindings = JSON.parse(childSpan.attributes['guardrail.findings']);
    expect(childFindings).toHaveLength(1);
    expect(childFindings[0].category).toBe('moderation');
    expect(childFindings[0].status).toBe('triggered');

    processor.onEnd(rootSpan);

    expect(rootSpan.attributes['guardrail.summary']).toBeDefined();
    const rootSummary = JSON.parse(rootSpan.attributes['guardrail.summary']);
    expect(rootSummary.detected_categories).toContain('moderation');
    expect(rootSummary.triggered_categories).toContain('moderation');
    expect(rootSpan.attributes['guardrail.summary.detected_categories']).toContain('moderation');

    expect(rootSpan.attributes['guardrail.finding.count']).toBe(1);
    expect(rootSpan.attributes['guardrail.findings']).toBeDefined();
    const rootFindings = JSON.parse(rootSpan.attributes['guardrail.findings']);
    expect(rootFindings).toHaveLength(1);
    expect(rootFindings[0].category).toBe('moderation');
  });

  it('accommodates late children arriving after root ended', () => {
    const processor = new GuardrailDetectorProcessor({ heuristicsEnabled: true });
    const traceId = 'trace-late-child';

    const rootSpan: any = {
      attributes: {
        'agent.name': 'root-agent',
      },
      setAttribute(key: string, value: any) {
        this.attributes[key] = value;
      },
      context: {
        traceId,
        spanId: 'root-span-999',
        traceState: undefined,
      },
      parentSpanId: undefined,
    };

    const lateChildSpan: any = {
      attributes: {
        'llm.model': 'gpt-4o',
        'llm.finish_reason': 'content_filter',
      },
      setAttribute(key: string, value: any) {
        this.attributes[key] = value;
      },
      context: {
        traceId,
        spanId: 'child-span-late',
        traceState: undefined,
      },
      parentSpanId: 'root-span-999',
    };

    processor.onEnd(rootSpan);

    const initialSummary = JSON.parse(rootSpan.attributes['guardrail.summary']);
    expect(initialSummary.detected_categories).not.toContain('moderation');

    processor.onEnd(lateChildSpan);

    expect(lateChildSpan.attributes['guardrail.summary']).toBeUndefined();
    expect(lateChildSpan.attributes['guardrail.finding.count']).toBe(1);

    const updatedSummary = JSON.parse(rootSpan.attributes['guardrail.summary']);
    expect(updatedSummary.detected_categories).toContain('moderation');
    expect(rootSpan.attributes['guardrail.summary.detected_categories']).toContain('moderation');
    expect(rootSpan.attributes['guardrail.finding.count']).toBe(1);
  });

  it('aggregates findings from multiple children without tracestate', () => {
    const processor = new GuardrailDetectorProcessor({ heuristicsEnabled: true });
    const traceId = 'trace-multi-children';

    const child1: any = {
      attributes: {
        'llm.model': 'gpt-4o',
        'llm.finish_reason': 'content_filter',
      },
      setAttribute(key: string, value: any) {
        this.attributes[key] = value;
      },
      context: { traceId, spanId: 'c1' },
      parentSpanId: 'root-multi',
    };

    const child2: any = {
      attributes: {
        'agent.span.type': 'guardrail',
        'guardrail.category': 'input_validation',
        'agent.guardrail.name': 'input_checker',
        'agent.guardrail.triggered': false,
      },
      setAttribute(key: string, value: any) {
        this.attributes[key] = value;
      },
      context: { traceId, spanId: 'c2' },
      parentSpanId: 'root-multi',
    };

    const root: any = {
      attributes: {},
      setAttribute(key: string, value: any) {
        this.attributes[key] = value;
      },
      context: { traceId, spanId: 'root-multi' },
      parentSpanId: undefined,
    };

    processor.onEnd(child1);
    processor.onEnd(child2);
    processor.onEnd(root);

    expect(child1.attributes['guardrail.summary']).toBeUndefined();
    expect(child2.attributes['guardrail.summary']).toBeUndefined();

    const rootSummary = JSON.parse(root.attributes['guardrail.summary']);
    expect(rootSummary.detected_categories).toContain('moderation');
    expect(rootSummary.detected_categories).toContain('input_validation');
    expect(root.attributes['guardrail.finding.count']).toBe(2);
  });
});
