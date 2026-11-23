/**
 * OpenAI Agents callbacks keep the framework's hierarchy and timing (TRC-294).
 *
 * Uses real Traccia tracers and spans; the Agents SDK callbacks are fed directly with
 * the fields the SDK's Trace/Span objects expose (traceId, spanId, parentId,
 * startedAt, endedAt).
 */

import { TracerProvider } from '../tracer/provider';
import { TracciaAgentsTracingProcessor } from '../integrations/openai-agents/processor';
import { ISpan } from '../types';

type FakeSpan = {
  spanId: string;
  traceId?: string;
  parentId?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  error?: { message?: string } | null;
  spanData: { type: string; name?: string; [k: string]: unknown };
};

const msToNs = (ms: number) => ms * 1_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

function span(
  spanId: string,
  traceId: string | undefined,
  parentId: string | null | undefined,
  type: string,
  name?: string,
  extra: Partial<FakeSpan> = {},
): FakeSpan {
  return { spanId, traceId, parentId, spanData: { type, name }, ...extra };
}

describe('OpenAI Agents processor hierarchy (TRC-294)', () => {
  let provider: TracerProvider;
  let ended: ISpan[];
  let processor: TracciaAgentsTracingProcessor;

  const byName = () => Object.fromEntries(ended.map((s) => [s.name, s])) as Record<string, ISpan>;
  const traceIds = (spans: ISpan[]) => new Set(spans.map((s) => s.context.traceId));

  beforeEach(() => {
    provider = new TracerProvider();
    ended = [];
    provider.addSpanProcessor({
      onEnd: (s: ISpan) => { ended.push(s); },
      shutdown: async () => {},
      forceFlush: async () => {},
    });
    processor = new TracciaAgentsTracingProcessor();
    (processor as any).tracer = provider.getTracer('openai.agents');
  });

  it('ticket repro: with no active Traccia span, root and children share one trace and link to parents', () => {
    processor.onTraceStart({ traceId: 'trace_a', name: 'Agent workflow' });
    processor.onSpanStart(span('span_root', 'trace_a', null, 'agent', 'triage'));
    processor.onSpanStart(span('span_child', 'trace_a', 'span_root', 'function', 'lookup'));
    processor.onSpanStart(span('span_grandchild', 'trace_a', 'span_child', 'custom', 'inner'));
    processor.onSpanEnd(span('span_grandchild', 'trace_a', 'span_child', 'custom', 'inner'));
    processor.onSpanEnd(span('span_child', 'trace_a', 'span_root', 'function', 'lookup'));
    processor.onSpanEnd(span('span_root', 'trace_a', null, 'agent', 'triage'));
    processor.onTraceEnd({ traceId: 'trace_a', name: 'Agent workflow' });

    const s = byName();
    expect(Object.keys(s).sort()).toEqual(['Agent workflow', 'agent.custom.inner', 'agent.tool.lookup', 'agent.triage']);
    expect(s['Agent workflow'].parentSpanId).toBeUndefined();
    expect(traceIds(ended)).toEqual(new Set([s['Agent workflow'].context.traceId]));
    expect(s['agent.triage'].parentSpanId).toBe(s['Agent workflow'].context.spanId);
    expect(s['agent.tool.lookup'].parentSpanId).toBe(s['agent.triage'].context.spanId);
    expect(s['agent.custom.inner'].parentSpanId).toBe(s['agent.tool.lookup'].context.spanId);
  });

  it('keeps the start attributes (they were passed where startSpan expects options)', () => {
    processor.onTraceStart({ traceId: 'trace_attr', name: 'wf', groupId: 'conv-1' });
    processor.onSpanStart(span('a', 'trace_attr', null, 'agent', 'triage'));
    processor.onSpanStart(span('f', 'trace_attr', 'a', 'function', 'lookup'));
    processor.onSpanEnd(span('f', 'trace_attr', 'a', 'function', 'lookup'));
    processor.onSpanEnd(span('a', 'trace_attr', null, 'agent', 'triage'));
    processor.onTraceEnd({ traceId: 'trace_attr' });

    const s = byName();
    expect(s['wf'].attributes).toMatchObject({
      'agents.trace_id': 'trace_attr', 'agents.group_id': 'conv-1', 'agent.span.type': 'trace',
    });
    expect(s['agent.triage'].attributes).toMatchObject({
      'agent.span.type': 'agent', 'agent.name': 'triage', 'agents.trace_id': 'trace_attr', 'agents.span_id': 'a',
    });
    expect(s['agent.triage'].attributes).not.toHaveProperty('agents.parent_id');
    expect(s['agent.tool.lookup'].attributes).toMatchObject({
      'agent.tool.name': 'lookup', 'agents.span_id': 'f', 'agents.parent_id': 'a',
    });
  });

  it('uses the callback timestamps, not the time the callback arrived', () => {
    const t0 = Date.now() - 10_000;
    processor.onTraceStart({ traceId: 'trace_t', name: 'wf' });
    // The real SDK starts the trace before its spans; backdate the root to model that.
    (processor as any).traceMap.get('trace_t').span.startTimeNs = msToNs(t0);
    const agent = { startedAt: iso(t0 + 5), endedAt: iso(t0 + 900) };
    const tool = { startedAt: iso(t0 + 100), endedAt: iso(t0 + 350) };
    processor.onSpanStart(span('a', 'trace_t', null, 'agent', 'triage', agent));
    processor.onSpanStart(span('f', 'trace_t', 'a', 'function', 'lookup', tool));
    processor.onSpanEnd(span('f', 'trace_t', 'a', 'function', 'lookup', tool));
    processor.onSpanEnd(span('a', 'trace_t', null, 'agent', 'triage', agent));
    processor.onTraceEnd({ traceId: 'trace_t' });

    const s = byName();
    expect(s['agent.triage'].startTimeNs).toBe(msToNs(t0 + 5));
    expect(s['agent.triage'].endTimeNs).toBe(msToNs(t0 + 900));
    expect(s['agent.tool.lookup'].startTimeNs).toBe(msToNs(t0 + 100));
    expect(s['agent.tool.lookup'].endTimeNs).toBe(msToNs(t0 + 350));
    // Epoch ns exceed 2^53, so JS numbers keep them to ~256ns.
    expect(Math.abs(s['agent.tool.lookup'].durationNs! - msToNs(250))).toBeLessThan(1_000);
  });

  it('starts the trace root on the same clock the Agents SDK uses (Date)', () => {
    const before = Date.now();
    processor.onTraceStart({ traceId: 'trace_clock', name: 'wf' });
    processor.onTraceEnd({ traceId: 'trace_clock' });
    const after = Date.now();
    const root = byName()['wf'];
    expect(root.startTimeNs).toBeGreaterThanOrEqual(msToNs(before));
    expect(root.startTimeNs).toBeLessThanOrEqual(msToNs(after));
    expect(root.endTimeNs!).toBeGreaterThanOrEqual(root.startTimeNs);
  });

  it('never starts a child before its parent, or ends a span before it starts', () => {
    const early = Date.now() - 5_000;
    processor.onTraceStart({ traceId: 'trace_c', name: 'wf' });
    processor.onSpanStart(span('a', 'trace_c', null, 'agent', 'triage', { startedAt: iso(early) }));
    processor.onSpanEnd(span('a', 'trace_c', null, 'agent', 'triage', { startedAt: iso(early), endedAt: iso(early - 1_000) }));
    processor.onTraceEnd({ traceId: 'trace_c' });
    const s = byName();
    expect(s['agent.triage'].startTimeNs).toBe(s['wf'].startTimeNs);
    expect(s['agent.triage'].endTimeNs).toBe(s['agent.triage'].startTimeNs);
  });

  it('ends the trace root no earlier than a child the framework timestamped past our clock', () => {
    const future = Date.now() + 2_000;
    processor.onTraceStart({ traceId: 'trace_f', name: 'wf' });
    processor.onSpanStart(span('a', 'trace_f', null, 'agent', 'triage'));
    processor.onSpanEnd(span('a', 'trace_f', null, 'agent', 'triage', { endedAt: iso(future) }));
    processor.onTraceEnd({ traceId: 'trace_f' });
    const s = byName();
    expect(s['agent.triage'].endTimeNs).toBe(msToNs(future));
    expect(s['wf'].endTimeNs!).toBeGreaterThanOrEqual(msToNs(future));
  });

  it('falls back to the callback time when timestamps are missing or invalid', () => {
    const before = Date.now();
    processor.onTraceStart({ traceId: 'trace_m', name: 'wf' });
    processor.onSpanStart(span('a', 'trace_m', null, 'agent', 'triage', { startedAt: 'not a date' }));
    processor.onSpanEnd(span('a', 'trace_m', null, 'agent', 'triage', { endedAt: null }));
    processor.onTraceEnd({ traceId: 'trace_m' });
    const after = Date.now();
    const a = byName()['agent.triage'];
    expect(a.startTimeNs).toBeGreaterThanOrEqual(msToNs(before) - 1_000_000);
    expect(a.endTimeNs!).toBeGreaterThanOrEqual(a.startTimeNs);
    expect(a.endTimeNs!).toBeLessThanOrEqual(msToNs(after + 1));
  });

  it('nests the trace inside the caller\'s active span', async () => {
    const appTracer = provider.getTracer('app');
    let outer!: ISpan;
    await appTracer.startActiveSpan('request', async (o) => {
      outer = o;
      processor.onTraceStart({ traceId: 'trace_n', name: 'wf' });
      processor.onSpanStart(span('a', 'trace_n', null, 'agent', 'triage'));
      processor.onSpanEnd(span('a', 'trace_n', null, 'agent', 'triage'));
      processor.onTraceEnd({ traceId: 'trace_n' });
    });
    const s = byName();
    expect(s['wf'].parentSpanId).toBe(outer.context.spanId);
    expect(s['agent.triage'].parentSpanId).toBe(s['wf'].context.spanId);
    expect(traceIds(ended)).toEqual(new Set([outer.context.traceId]));
  });

  it('parents on the callback hierarchy even when an unrelated span is current', async () => {
    processor.onTraceStart({ traceId: 'trace_u', name: 'wf' });
    processor.onSpanStart(span('a', 'trace_u', null, 'agent', 'triage'));
    await provider.getTracer('app').startActiveSpan('unrelated', async () => {
      processor.onSpanStart(span('f', 'trace_u', 'a', 'function', 'lookup'));
      processor.onSpanEnd(span('f', 'trace_u', 'a', 'function', 'lookup'));
    });
    processor.onSpanEnd(span('a', 'trace_u', null, 'agent', 'triage'));
    processor.onTraceEnd({ traceId: 'trace_u' });
    const s = byName();
    expect(s['agent.tool.lookup'].parentSpanId).toBe(s['agent.triage'].context.spanId);
    expect(s['agent.tool.lookup'].context.traceId).toBe(s['agent.triage'].context.traceId);
    expect(s['unrelated'].context.traceId).not.toBe(s['agent.triage'].context.traceId);
  });

  it('keeps interleaved concurrent traces separate', () => {
    processor.onTraceStart({ traceId: 't1', name: 'run-1' });
    processor.onTraceStart({ traceId: 't2', name: 'run-2' });
    processor.onSpanStart(span('a1', 't1', null, 'agent', 'one'));
    processor.onSpanStart(span('a2', 't2', null, 'agent', 'two'));
    processor.onSpanStart(span('f2', 't2', 'a2', 'function', 'tool2'));
    processor.onSpanStart(span('f1', 't1', 'a1', 'function', 'tool1'));
    processor.onSpanEnd(span('f1', 't1', 'a1', 'function', 'tool1'));
    processor.onSpanEnd(span('a2', 't2', null, 'agent', 'two'));
    processor.onSpanEnd(span('f2', 't2', 'a2', 'function', 'tool2'));
    processor.onSpanEnd(span('a1', 't1', null, 'agent', 'one'));
    processor.onTraceEnd({ traceId: 't2' });
    processor.onTraceEnd({ traceId: 't1' });

    const s = byName();
    expect(ended).toHaveLength(6);
    for (const [run, agent, tool] of [['run-1', 'agent.one', 'agent.tool.tool1'], ['run-2', 'agent.two', 'agent.tool.tool2']]) {
      expect(s[run].parentSpanId).toBeUndefined();
      expect(s[agent].parentSpanId).toBe(s[run].context.spanId);
      expect(s[tool].parentSpanId).toBe(s[agent].context.spanId);
      expect(traceIds([s[run], s[agent], s[tool]])).toEqual(new Set([s[run].context.traceId]));
    }
    expect(s['run-1'].context.traceId).not.toBe(s['run-2'].context.traceId);
  });

  it('joins spans whose callbacks arrive after the trace (or their parent) ended', () => {
    // The SDK fires span callbacks without awaiting them, so onTraceEnd can overtake them.
    processor.onTraceStart({ traceId: 'trace_late', name: 'wf' });
    processor.onSpanStart(span('a', 'trace_late', null, 'agent', 'triage'));
    processor.onSpanEnd(span('a', 'trace_late', null, 'agent', 'triage'));
    processor.onTraceEnd({ traceId: 'trace_late' });
    processor.onSpanStart(span('late_child', 'trace_late', 'a', 'custom', 'child'));
    processor.onSpanStart(span('late_top', 'trace_late', null, 'custom', 'top'));
    processor.onSpanEnd(span('late_child', 'trace_late', 'a', 'custom', 'child'));
    processor.onSpanEnd(span('late_top', 'trace_late', null, 'custom', 'top'));

    const s = byName();
    expect(traceIds(ended)).toEqual(new Set([s['wf'].context.traceId]));
    expect(s['agent.custom.child'].parentSpanId).toBe(s['agent.triage'].context.spanId);
    expect(s['agent.custom.top'].parentSpanId).toBe(s['wf'].context.spanId);
  });

  it('holds a child whose parent start callback is delayed, then links it to that parent', () => {
    // An earlier processor delays the parent's start: the child's start and end arrive first.
    processor.onTraceStart({ traceId: 'trace_d', name: 'wf' });
    processor.onSpanStart(span('child', 'trace_d', 'agent', 'function', 'lookup'));
    processor.onSpanStart(span('grandchild', 'trace_d', 'child', 'custom', 'inner'));
    processor.onSpanEnd(span('grandchild', 'trace_d', 'child', 'custom', 'inner'));
    processor.onSpanEnd(span('child', 'trace_d', 'agent', 'function', 'lookup'));
    expect(ended).toHaveLength(0); // nothing placed under the root in the meantime
    processor.onSpanStart(span('agent', 'trace_d', null, 'agent', 'triage'));
    processor.onSpanEnd(span('agent', 'trace_d', null, 'agent', 'triage'));
    processor.onTraceEnd({ traceId: 'trace_d' });

    const s = byName();
    expect(Object.keys(s).sort()).toEqual(['agent.custom.inner', 'agent.tool.lookup', 'agent.triage', 'wf']);
    expect(traceIds(ended)).toEqual(new Set([s['wf'].context.traceId]));
    expect(s['agent.triage'].parentSpanId).toBe(s['wf'].context.spanId);
    expect(s['agent.tool.lookup'].parentSpanId).toBe(s['agent.triage'].context.spanId);
    expect(s['agent.custom.inner'].parentSpanId).toBe(s['agent.tool.lookup'].context.spanId);
    expect((processor as any).pending.size).toBe(0);
    expect((processor as any).waitingOn.size).toBe(0);
  });

  it('ends a span whose end callback arrived before its delayed start', () => {
    const t0 = Date.now();
    const agent = { startedAt: iso(t0 + 10), endedAt: iso(t0 + 90) };
    processor.onTraceStart({ traceId: 'trace_ee', name: 'wf' });
    processor.onSpanStart(span('turn', 'trace_ee', 'agent', 'custom', 'turn'));
    processor.onSpanEnd(span('turn', 'trace_ee', 'agent', 'custom', 'turn'));
    processor.onSpanEnd(span('agent', 'trace_ee', null, 'agent', 'triage', agent)); // before its start
    processor.onSpanStart(span('agent', 'trace_ee', null, 'agent', 'triage', agent));
    processor.onSpanEnd(span('agent', 'trace_ee', null, 'agent', 'triage', agent)); // a duplicate is ignored
    processor.onTraceEnd({ traceId: 'trace_ee' });

    const s = byName();
    expect(ended.map((x) => x.name).sort()).toEqual(['agent.custom.turn', 'agent.triage', 'wf']);
    expect(s['agent.triage'].endTimeNs).toBe(msToNs(t0 + 90));
    expect(s['agent.custom.turn'].parentSpanId).toBe(s['agent.triage'].context.spanId);
    expect((processor as any).earlyEnds.size).toBe(0);
  });

  it('keeps framework timestamps for a held child', () => {
    const t0 = Date.now();
    processor.onTraceStart({ traceId: 'trace_dt', name: 'wf' });
    const times = { startedAt: iso(t0 + 20), endedAt: iso(t0 + 70) };
    processor.onSpanStart(span('child', 'trace_dt', 'agent', 'function', 'lookup', times));
    processor.onSpanEnd(span('child', 'trace_dt', 'agent', 'function', 'lookup', times));
    processor.onSpanStart(span('agent', 'trace_dt', null, 'agent', 'triage', { startedAt: iso(t0 + 10) }));
    processor.onSpanEnd(span('agent', 'trace_dt', null, 'agent', 'triage', { startedAt: iso(t0 + 10), endedAt: iso(t0 + 90) }));
    processor.onTraceEnd({ traceId: 'trace_dt' });
    const c = byName()['agent.tool.lookup'];
    expect(c.startTimeNs).toBe(msToNs(t0 + 20));
    expect(c.endTimeNs).toBe(msToNs(t0 + 70));
  });

  it('places a held child under the trace root when its parent never arrives', async () => {
    processor = new TracciaAgentsTracingProcessor({ parentWaitMs: 10 });
    (processor as any).tracer = provider.getTracer('openai.agents');
    processor.onTraceStart({ traceId: 'trace_o', name: 'wf' });
    processor.onSpanStart(span('child', 'trace_o', 'missing', 'function', 'lookup'));
    processor.onSpanEnd(span('child', 'trace_o', 'missing', 'function', 'lookup'));
    processor.onTraceEnd({ traceId: 'trace_o' });
    expect(byName()['agent.tool.lookup']).toBeUndefined();
    await new Promise((r) => setTimeout(r, 40));
    const s = byName();
    expect(s['agent.tool.lookup'].parentSpanId).toBe(s['wf'].context.spanId);
    expect(s['agent.tool.lookup'].context.traceId).toBe(s['wf'].context.traceId);
    expect((processor as any).pending.size).toBe(0);
  });

  it('forceFlush() and shutdown() place spans still waiting for a parent', () => {
    processor.onTraceStart({ traceId: 'trace_ff', name: 'wf' });
    processor.onSpanStart(span('child', 'trace_ff', 'missing', 'function', 'lookup'));
    processor.onSpanEnd(span('child', 'trace_ff', 'missing', 'function', 'lookup'));
    processor.forceFlush();
    expect(byName()['agent.tool.lookup']).toBeDefined();
    processor.onSpanStart(span('child2', 'trace_ff', 'missing2', 'custom', 'two'));
    processor.shutdown();
    expect((processor as any).pending.size).toBe(0);
  });

  it('bounds how many spans wait for a parent', () => {
    processor.onTraceStart({ traceId: 'trace_b', name: 'wf' });
    for (let i = 0; i < 1030; i++) {
      processor.onSpanStart(span(`c${i}`, 'trace_b', `missing${i}`, 'custom', `c${i}`));
    }
    expect((processor as any).pending.size).toBe(1024);
    expect((processor as any).pending.has('c0')).toBe(false); // oldest released to the root
    expect((processor as any).spanMap.has('c0')).toBe(true);
    processor.shutdown();
  });

  it('bounds how many ended traces and spans it remembers', () => {
    for (let i = 0; i < 1100; i++) {
      processor.onTraceStart({ traceId: `t${i}`, name: 'wf' });
      processor.onSpanStart(span(`s${i}`, `t${i}`, null, 'agent', 'a'));
      processor.onSpanEnd(span(`s${i}`, `t${i}`, null, 'agent', 'a'));
      processor.onTraceEnd({ traceId: `t${i}` });
    }
    expect((processor as any).endedTraces.size).toBe(1024);
    expect((processor as any).endedSpans.size).toBe(1024);
    expect((processor as any).endedTraces.has('t0')).toBe(false);
    expect((processor as any).endedTraces.has('t1099')).toBe(true);
    expect((processor as any).traceMap.size).toBe(0);
    expect((processor as any).spanMap.size).toBe(0);
  });

  it('handles an unknown trace (processor registered mid-run) without throwing', () => {
    processor.onSpanStart(span('a', 'trace_x', 'never_seen', 'agent', 'triage'));
    processor.onSpanStart(span('f', 'trace_x', 'a', 'function', 'lookup'));
    processor.onSpanEnd(span('f', 'trace_x', 'a', 'function', 'lookup'));
    processor.onSpanEnd(span('a', 'trace_x', 'never_seen', 'agent', 'triage'));
    expect(() => processor.onTraceEnd({ traceId: 'trace_x' })).not.toThrow();
    expect(() => processor.onSpanEnd(span('nope', 'trace_x', null, 'agent', 'x'))).not.toThrow();
    processor.forceFlush(); // stop waiting for the parent that will never start
    const s = byName();
    expect(Object.keys(s).sort()).toEqual(['agent.tool.lookup', 'agent.triage']);
    expect(s['agent.triage'].parentSpanId).toBeUndefined();
    expect(s['agent.tool.lookup'].parentSpanId).toBe(s['agent.triage'].context.spanId);
  });

  it('never throws into the Agents SDK when the tracer fails', () => {
    (processor as any).tracer = { startSpan: () => { throw new Error('tracer down'); } };
    expect(() => processor.onTraceStart({ traceId: 'boom', name: 'wf' })).not.toThrow();
    expect(() => processor.onSpanStart(span('a', 'boom', null, 'agent', 'x'))).not.toThrow();
    expect(() => processor.onSpanEnd(span('a', 'boom', null, 'agent', 'x'))).not.toThrow();
    expect(() => processor.onTraceEnd({ traceId: 'boom' })).not.toThrow();
  });

  it('still ends the span when recording its end attributes fails', () => {
    processor.onTraceStart({ traceId: 'trace_bad', name: 'wf' });
    processor.onSpanStart(span('g', 'trace_bad', null, 'generation'));
    const bad = span('g', 'trace_bad', null, 'generation');
    Object.defineProperty(bad.spanData, 'usage', { get() { throw new Error('bad usage'); } });
    expect(() => processor.onSpanEnd(bad)).not.toThrow();
    expect(byName()['llm.agents.generation']).toBeDefined();
  });
});

describe('Span explicit start/end times', () => {
  it('uses startTimeNs and end(endTimeNs), and never ends before the start', () => {
    const provider = new TracerProvider();
    const tracer = provider.getTracer('t');
    const a = tracer.startSpan('a', { startTimeNs: 1_700_000_000_000_000_000 });
    a.end(1_700_000_000_250_000_000);
    expect(a.startTimeNs).toBe(1_700_000_000_000_000_000);
    expect(a.endTimeNs).toBe(1_700_000_000_250_000_000);
    expect(Math.abs(a.durationNs! - 250_000_000)).toBeLessThan(1_000); // epoch ns exceed 2^53

    const b = tracer.startSpan('b', { startTimeNs: 1_700_000_000_000_000_000 });
    b.end(1_600_000_000_000_000_000);
    expect(b.endTimeNs).toBe(b.startTimeNs);
  });

  it('ignores invalid explicit times', () => {
    const tracer = new TracerProvider().getTracer('t');
    const before = Math.floor((performance.timeOrigin + performance.now()) * 1_000_000);
    const s = tracer.startSpan('s', { startTimeNs: Number.NaN });
    s.end(-5);
    expect(s.startTimeNs).toBeGreaterThanOrEqual(before);
    expect(s.endTimeNs!).toBeGreaterThanOrEqual(s.startTimeNs);
  });
});

describe('OpenAI Agents processor through the global tracer', () => {
  it('exports one linked trace via startTracing()', async () => {
    const { startTracing, stopTracing } = require('../auto');
    const exported: ISpan[] = [];
    await startTracing({
      useOtlp: false,
      enableConsoleExporter: false,
      exporter: { export: async (spans: ISpan[]) => { exported.push(...spans); return true; }, shutdown: async () => {} },
    });
    try {
      const p = new TracciaAgentsTracingProcessor();
      p.onTraceStart({ traceId: 'trace_g', name: 'wf' });
      p.onSpanStart(span('a', 'trace_g', null, 'agent', 'triage'));
      p.onSpanStart(span('f', 'trace_g', 'a', 'function', 'lookup'));
      p.onSpanEnd(span('f', 'trace_g', 'a', 'function', 'lookup'));
      p.onSpanEnd(span('a', 'trace_g', null, 'agent', 'triage'));
      p.onTraceEnd({ traceId: 'trace_g' });
    } finally {
      await stopTracing();
    }
    const s = Object.fromEntries(exported.map((x) => [x.name, x]));
    expect(Object.keys(s).sort()).toEqual(['agent.tool.lookup', 'agent.triage', 'wf']);
    expect(new Set(exported.map((x) => x.context.traceId)).size).toBe(1);
    expect(s['agent.triage'].parentSpanId).toBe(s['wf'].context.spanId);
    expect(s['agent.tool.lookup'].parentSpanId).toBe(s['agent.triage'].context.spanId);
  });
});
