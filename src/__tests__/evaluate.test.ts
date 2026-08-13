/**
 * Unit tests for evaluate builtins + local-only runner.
 */

import { runBuiltinScorer } from '../eval/builtins';
import { evaluate } from '../eval/evaluate';
import { EvaluateError } from '../eval/errors';

jest.mock('../auto', () => {
  const span = {
    setAttribute: jest.fn(),
    recordException: jest.fn(),
    context: { traceId: 'trace-abc' },
  };
  return {
    getTracer: () => ({
      startActiveSpan: async (_name: string, fn: any, _opts?: any) => fn(span),
    }),
    getTracerProvider: () => ({
      forceFlush: async () => undefined,
    }),
    init: async () => undefined,
    isTracingStarted: () => true,
  };
});

describe('runBuiltinScorer', () => {
  it('exact_match', () => {
    expect(runBuiltinScorer('exact_match', { output: ' Hi ', expected: 'hi' }).passed).toBe(true);
    expect(runBuiltinScorer('exact_match', { output: 'a', expected: 'b' }).passed).toBe(false);
  });

  it('contains and json_valid', () => {
    expect(runBuiltinScorer('contains', { output: 'hello world', expected: 'world' }).passed).toBe(
      true,
    );
    expect(runBuiltinScorer('json_valid', { output: '{"a":1}' }).passed).toBe(true);
    expect(runBuiltinScorer('json_valid', { output: 'nope' }).passed).toBe(false);
  });
});

describe('evaluate local-only', () => {
  it('rejects empty data', async () => {
    await expect(
      evaluate({ name: 'x', data: [], task: () => 'y', persist: false, progress: false }),
    ).rejects.toBeInstanceOf(EvaluateError);
  });

  it('runs task + builtin scorer', async () => {
    const result = await evaluate({
      name: 'local-smoke',
      data: [{ input: { q: 'hi' }, expected: 'hi' }],
      task: (inp) => inp.q,
      scorers: ['exact_match'],
      persist: false,
      progress: false,
    });
    expect(result.aggregates.item_count).toBe(1);
    expect(result.aggregates.pass_count).toBe(1);
    expect(result.url).toBeFalsy();
    expect(result.summary()).toContain('local-smoke');
  });

  it('isolates task errors', async () => {
    const result = await evaluate({
      name: 'iso',
      data: [
        { input: { q: 'ok' }, expected: 'ok' },
        { input: { q: 'boom' }, expected: 'x' },
      ],
      task: (inp) => {
        if (inp.q === 'boom') throw new Error('task failed');
        return inp.q;
      },
      scorers: ['exact_match'],
      persist: false,
      progress: false,
    });
    expect(result.rows).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect((result.rows[0].panels as any[])[0].passed).toBe(true);
    expect((result.rows[0].panels as any[])[0].label).toBe('Task');
    expect((result.rows[0].panels as any[])[0].scores[0].type).toBe('exact_match');
    expect(result.aggregates.source).toBe('evaluate');
    expect((result.rows[1].panels as any[])[0].error).toBeTruthy();
  });

  it('labels the cell with prompt name when prompt is set', async () => {
    const result = await evaluate({
      name: 'labeled',
      data: [{ input: { q: 'hi' }, expected: 'hi' }],
      task: (inp) => inp.q,
      scorers: ['exact_match'],
      prompt: 'support-reply',
      persist: false,
      progress: false,
    });
    expect((result.rows[0].panels as any[])[0].label).toBe('support-reply');
  });

  it('accepts expected_output as an alias of expected', async () => {
    const result = await evaluate({
      name: 'alias',
      data: [{ input: { q: 'hi' }, expected_output: 'hi' }],
      task: (inp) => inp.q,
      scorers: ['exact_match'],
      persist: false,
      progress: false,
    });
    expect(result.aggregates.pass_count).toBe(1);
  });
});
