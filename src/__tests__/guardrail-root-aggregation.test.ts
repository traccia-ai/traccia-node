import { GuardrailDetectorProcessor } from '../processor/guardrail-detector';
import { TracerProvider } from '../tracer/provider';
import { REDACTION_APPLIED } from '../redaction';

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

  it('does not reinsert raw PII when late child arrives after root has been redacted', () => {
    const processor = new GuardrailDetectorProcessor({ heuristicsEnabled: true });
    const traceId = 'trace-late-child-pii';

    const rootSpan: any = {
      attributes: {
        'agent.name': 'root-agent',
      },
      setAttribute(key: string, value: any) {
        this.attributes[key] = value;
      },
      context: {
        traceId,
        spanId: 'root-pii-1',
      },
      parentSpanId: undefined,
    };

    processor.onEnd(rootSpan);

    // Simulate redaction processor running on rootSpan
    rootSpan.attributes[REDACTION_APPLIED] = true;
    rootSpan.attributes['guardrail.summary'] = JSON.stringify({
      detected_categories: [],
      triggered_categories: [],
      missing_categories: [],
    });

    const lateChildSpan: any = {
      attributes: {
        'agent.span.type': 'guardrail',
        'guardrail.category': 'input_validation',
        'guardrail.name': 'check_user_john.doe@example.com',
        'guardrail.triggered': true,
        'llm.model': 'gpt-4o',
      },
      setAttribute(key: string, value: any) {
        this.attributes[key] = value;
      },
      context: {
        traceId,
        spanId: 'child-pii-late',
      },
      parentSpanId: 'root-pii-1',
    };

    processor.onEnd(lateChildSpan);

    expect(rootSpan.attributes['guardrail.findings']).toBeDefined();
    const findingsJson = rootSpan.attributes['guardrail.findings'];
    expect(findingsJson).not.toContain('john.doe@example.com');
    expect(findingsJson).toContain('[REDACTED_EMAIL]');
    expect(rootSpan.attributes[REDACTION_APPLIED]).toBe(true);
  });

  it('aggregates guardrails onto local root spans with remote parents', () => {
    const processor = new GuardrailDetectorProcessor({ heuristicsEnabled: true });
    const traceId = 'trace-remote-parent';

    const localRootSpan: any = {
      attributes: {
        'service.name': 'order-service',
      },
      setAttribute(key: string, value: any) {
        this.attributes[key] = value;
      },
      context: {
        traceId,
        spanId: 'local-root-span',
        isRemote: false,
      },
      parentSpanId: 'remote-parent-span-999',
      isRemoteParent: true,
      parentSpanContext: {
        traceId,
        spanId: 'remote-parent-span-999',
        isRemote: true,
      },
    };

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
        spanId: 'local-child-span',
      },
      parentSpanId: 'local-root-span',
    };

    processor.onEnd(childSpan);
    processor.onEnd(localRootSpan);

    expect(childSpan.attributes['guardrail.summary']).toBeUndefined();
    expect(localRootSpan.attributes['guardrail.summary']).toBeDefined();
    const summary = JSON.parse(localRootSpan.attributes['guardrail.summary']);
    expect(summary.detected_categories).toContain('moderation');
    expect(localRootSpan.attributes['guardrail.summary.detected_categories']).toContain('moderation');
    expect(localRootSpan.attributes['guardrail.finding.count']).toBe(1);
  });

  it('correctly aggregates guardrail summaries when using Tracer with remote parentContext', () => {
    const provider = new TracerProvider();
    const processor = new GuardrailDetectorProcessor({ heuristicsEnabled: true });
    provider.addSpanProcessor(processor);

    const tracer = provider.getTracer('test-remote');
    const remoteContext = {
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      traceFlags: 1,
      isRemote: true,
    };

    const rootSpan = tracer.startSpan('entrypoint', { parentContext: remoteContext });
    expect(rootSpan.isRemoteParent).toBe(true);
    expect(rootSpan.parentSpanId).toBe('00f067aa0ba902b7');

    const childSpan = tracer.startSpan('llm-call', { parent: rootSpan });
    childSpan.setAttribute('llm.model', 'gpt-4o');
    childSpan.setAttribute('llm.finish_reason', 'content_filter');

    childSpan.end();
    rootSpan.end();

    expect(childSpan.attributes['guardrail.summary']).toBeUndefined();
    expect(rootSpan.attributes['guardrail.summary']).toBeDefined();
    const summary = JSON.parse(rootSpan.attributes['guardrail.summary'] as string);
    expect(summary.detected_categories).toContain('moderation');
  });
});
