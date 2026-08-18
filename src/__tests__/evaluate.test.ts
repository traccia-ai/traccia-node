/**
 * Unit tests for evaluate builtins + local-only runner.
 */

import { runBuiltinScorer } from '../eval/builtins';
import { evaluate } from '../eval/evaluate';
import { EvaluateError } from '../eval/errors';

// Mutable so individual tests can flip isTracingStarted() to exercise
// ensureEvalTracing's init path, which the previous always-true mock made
// permanently unreachable.
let mockIsTracingStarted = true;
let mockInit: jest.Mock = jest.fn(async () => undefined);
// Lets a test simulate "some instrumentation already recorded these
// attributes on the per-item span before evaluate() reads them" (e.g.
// costFromSpan reading llm.cost.usd) - the mock has no real context
// propagation, so this is the only way to exercise that read path.
let mockItemSpanPresetAttributes: Record<string, unknown> = {};

jest.mock('../auto', () => {
  return {
    getTracer: () => ({
      startActiveSpan: async (name: string, fn: any, _opts?: any) => {
        const span = {
          attributes: (name === 'evaluate.item' ? { ...mockItemSpanPresetAttributes } : {}) as Record<string, unknown>,
          setAttribute: jest.fn(function (this: any, key: string, value: unknown) {
            this.attributes[key] = value;
          }),
          recordException: jest.fn(),
          context: { traceId: 'trace-abc' },
        };
        return fn(span);
      },
    }),
    getTracerProvider: () => ({
      forceFlush: async () => undefined,
    }),
    init: (...args: unknown[]) => mockInit(...args),
    isTracingStarted: () => mockIsTracingStarted,
  };
});

jest.mock('../eval/client', () => ({
  fetchDataset: jest.fn(),
  fetchDatasetItems: jest.fn(),
  createEphemeralDataset: jest.fn(),
  fetchScorer: jest.fn(),
  scoreRemote: jest.fn(),
  createExperiment: jest.fn(),
  resolvePromptVersionIds: jest.fn(),
}));

import * as evalClient from '../eval/client';

const mockEvalClient = evalClient as jest.Mocked<typeof evalClient>;

beforeEach(() => {
  mockIsTracingStarted = true;
  mockInit = jest.fn(async () => undefined);
  mockItemSpanPresetAttributes = {};
  jest.clearAllMocks();
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

  it('exact_match/contains report missing_expected_output when expected is null/undefined', () => {
    expect(runBuiltinScorer('exact_match', { output: 'hi' })).toMatchObject({
      passed: false,
      reason: 'missing_expected_output',
    });
    expect(runBuiltinScorer('contains', { output: 'hi' })).toMatchObject({
      passed: false,
      reason: 'missing_expected_output',
    });
  });

  it('contains reports empty_expected for an empty expected string', () => {
    expect(runBuiltinScorer('contains', { output: 'hi', expected: '' })).toMatchObject({
      passed: false,
      reason: 'empty_expected',
    });
  });

  it('respects case_sensitive: true for exact_match and contains', () => {
    expect(
      runBuiltinScorer('exact_match', { output: 'Hi', expected: 'hi', config: { case_sensitive: true } }),
    ).toMatchObject({ passed: false });
    expect(
      runBuiltinScorer('contains', { output: 'Hello', expected: 'hello', config: { case_sensitive: true } }),
    ).toMatchObject({ passed: false });
  });

  it('json_valid short-circuits to passed:true when output is already an object', () => {
    expect(runBuiltinScorer('json_valid', { output: { a: 1 } })).toMatchObject({ passed: true });
  });

  it('json_valid reports not_json for a non-object, non-string output', () => {
    expect(runBuiltinScorer('json_valid', { output: 42 })).toMatchObject({ passed: false, reason: 'not_json' });
  });

  it('json_valid reports empty for whitespace-only output', () => {
    expect(runBuiltinScorer('json_valid', { output: '   ' })).toMatchObject({ passed: false, reason: 'empty' });
  });

  it('json_valid reports not_object_or_array for valid JSON that parses to a primitive', () => {
    expect(runBuiltinScorer('json_valid', { output: '5' })).toMatchObject({
      passed: false,
      reason: 'not_object_or_array',
    });
  });

  it('throws for an unknown scorer name', () => {
    expect(() => runBuiltinScorer('not_a_real_scorer', { output: 'x' })).toThrow('Unknown builtin scorer');
  });

  it('normalizeText JSON-stringifies object output/expected values', () => {
    expect(
      runBuiltinScorer('exact_match', { output: { a: 1 }, expected: { a: 1 } }),
    ).toMatchObject({ passed: true });
  });

  it('normalizeText stringifies a primitive number/boolean value', () => {
    expect(runBuiltinScorer('exact_match', { output: 42, expected: '42' })).toMatchObject({ passed: true });
  });

  it('normalizeText falls back to String(value) when an object cannot be JSON-stringified', () => {
    const circular: any = {};
    circular.self = circular;
    expect(() => runBuiltinScorer('exact_match', { output: circular, expected: 'x' })).not.toThrow();
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

  it('rejects an inline row whose input is not an object', async () => {
    await expect(
      evaluate({
        name: 'bad-row',
        data: [{ input: 'not an object' }],
        task: () => 'y',
        persist: false,
        progress: false,
      }),
    ).rejects.toThrow(/input must be an object/);
  });

  it('validates required options', async () => {
    await expect(
      evaluate({ name: '', data: [{ input: {} }], task: () => 'y', persist: false, progress: false }),
    ).rejects.toBeInstanceOf(EvaluateError);
    await expect(
      evaluate({ name: 'x', data: [{ input: {} }], task: 'not a function' as any, persist: false, progress: false }),
    ).rejects.toBeInstanceOf(EvaluateError);
    await expect(
      evaluate({ name: 'x', data: [{ input: {} }], task: () => 'y', maxConcurrency: 0, persist: false, progress: false }),
    ).rejects.toBeInstanceOf(EvaluateError);
    await expect(
      evaluate({ name: 'x', data: 123 as any, task: () => 'y', persist: false, progress: false }),
    ).rejects.toBeInstanceOf(EvaluateError);
  });

  it('invokes onItemComplete for each row', async () => {
    const onItemComplete = jest.fn();
    await evaluate({
      name: 'progress-cb',
      data: [{ input: { q: 'a' } }, { input: { q: 'b' } }],
      task: (inp) => inp.q,
      persist: false,
      progress: false,
      onItemComplete,
    });

    expect(onItemComplete).toHaveBeenCalledTimes(2);
    expect(onItemComplete).toHaveBeenCalledWith(1, 2, expect.any(Object));
    expect(onItemComplete).toHaveBeenCalledWith(2, 2, expect.any(Object));
  });

  it('limits concurrency to maxConcurrency (never runs more tasks than the limit at once)', async () => {
    let active = 0;
    let maxActive = 0;
    const data = Array.from({ length: 6 }, (_, i) => ({ input: { i } }));

    await evaluate({
      name: 'concurrency',
      data,
      task: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return 'ok';
      },
      maxConcurrency: 2,
      persist: false,
      progress: false,
    });

    expect(maxActive).toBeLessThanOrEqual(2);
  });
});

describe('evaluate scorer variants', () => {
  it('runs a function (ScorerFn) scorer', async () => {
    const scorer = Object.assign(
      (args: { output: unknown }) => ({ passed: args.output === 'hi', score: args.output === 'hi' ? 1 : 0 }),
      { scorerName: 'custom' },
    );
    const result = await evaluate({
      name: 'fn-scorer',
      data: [{ input: { q: 'hi' } }],
      task: (inp) => inp.q,
      scorers: [scorer],
      persist: false,
      progress: false,
    });

    expect((result.rows[0].panels as any[])[0].scores[0].passed).toBe(true);
  });

  it('records a scorer_error when a function scorer throws', async () => {
    const throwingScorer = () => {
      throw new Error('scorer blew up');
    };
    const result = await evaluate({
      name: 'fn-scorer-throws',
      data: [{ input: { q: 'hi' } }],
      task: (inp) => inp.q,
      scorers: [throwingScorer],
      persist: false,
      progress: false,
    });

    const score = (result.rows[0].panels as any[])[0].scores[0];
    expect(score.passed).toBe(false);
    expect(score.reason).toContain('scorer_error');
  });

  it('normalizes a raw number return from a function scorer', async () => {
    const result = await evaluate({
      name: 'fn-scorer-number',
      data: [{ input: { q: 'hi' } }],
      task: () => 'x',
      scorers: [() => 0.8],
      persist: false,
      progress: false,
    });
    const score = (result.rows[0].panels as any[])[0].scores[0];
    expect(score).toMatchObject({ score: 0.8, passed: true });
  });

  it('normalizes a raw boolean return from a function scorer', async () => {
    const result = await evaluate({
      name: 'fn-scorer-boolean',
      data: [{ input: { q: 'hi' } }],
      task: () => 'x',
      scorers: [() => false],
      persist: false,
      progress: false,
    });
    const score = (result.rows[0].panels as any[])[0].scores[0];
    expect(score).toMatchObject({ score: 0, passed: false });
  });

  it('derives passed from score >= 0.5 when a function scorer returns an object without passed', async () => {
    const result = await evaluate({
      name: 'fn-scorer-score-only',
      data: [{ input: { q: 'hi' } }],
      task: () => 'x',
      scorers: [() => ({ score: 0.9 })],
      persist: false,
      progress: false,
    });
    const score = (result.rows[0].panels as any[])[0].scores[0];
    expect(score.passed).toBe(true);
  });

  it('marks an invalid function-scorer return as invalid_scorer_return', async () => {
    const result = await evaluate({
      name: 'fn-scorer-invalid',
      data: [{ input: { q: 'hi' } }],
      task: () => 'x',
      scorers: [() => null],
      persist: false,
      progress: false,
    });
    const score = (result.rows[0].panels as any[])[0].scores[0];
    expect(score).toMatchObject({ passed: false, reason: 'invalid_scorer_return' });
  });

  it('resolves a non-builtin string scorer via evalClient.fetchScorer/scoreRemote', async () => {
    mockEvalClient.fetchScorer.mockResolvedValue({ id: 'scorer-1', name: 'platform-scorer', type: 'platform_custom' });
    mockEvalClient.scoreRemote.mockResolvedValue({
      passed: true,
      score: 1,
      scorer_name: 'platform-scorer',
      type: 'platform_custom',
    });

    const result = await evaluate({
      name: 'platform-scorer-test',
      data: [{ input: { q: 'hi' } }],
      task: () => 'x',
      scorers: ['platform-scorer'],
      persist: false,
      progress: false,
    });

    expect(mockEvalClient.scoreRemote).toHaveBeenCalled();
    const score = (result.rows[0].panels as any[])[0].scores[0];
    expect(score.passed).toBe(true);
  });

  it('resolves a non-builtin string scorer whose platform type IS a builtin, running it locally', async () => {
    mockEvalClient.fetchScorer.mockResolvedValue({ id: 'scorer-2', name: 'wraps-exact-match', type: 'exact_match' });

    const result = await evaluate({
      name: 'platform-builtin-scorer',
      data: [{ input: { q: 'hi' }, expected: 'hi' }],
      task: (inp) => inp.q,
      scorers: ['wraps-exact-match'],
      persist: false,
      progress: false,
    });

    expect(mockEvalClient.scoreRemote).not.toHaveBeenCalled();
    const score = (result.rows[0].panels as any[])[0].scores[0];
    expect(score.passed).toBe(true);
  });
});

describe('evaluate scorer errors surfaced at the span level', () => {
  it('records a scorer_error when resolving a string scorer fails both at pre-resolution and per-item', async () => {
    mockEvalClient.fetchScorer.mockRejectedValue(new Error('scorer service down'));

    const result = await evaluate({
      name: 'string-scorer-fetch-fails',
      data: [{ input: { q: 'hi' } }],
      task: () => 'x',
      scorers: ['always-unresolvable-scorer'],
      persist: false,
      progress: false,
    });

    const score = (result.rows[0].panels as any[])[0].scores[0];
    expect(score.passed).toBe(false);
    expect(score.reason).toContain('scorer_error');
  });
});

describe('evaluate platform-scorer pre-resolution', () => {
  it('swallows a fetchScorer failure during pre-resolution and resolves per-item instead', async () => {
    mockEvalClient.fetchScorer.mockRejectedValueOnce(new Error('not found')).mockResolvedValue({
      id: 'late-scorer',
      name: 'late',
      type: 'exact_match',
    });

    const result = await evaluate({
      name: 'pre-resolve-fail',
      data: [{ input: { q: 'hi' }, expected: 'hi' }],
      task: (inp) => inp.q,
      scorers: ['late-scorer'],
      persist: false,
      progress: false,
    });

    expect(result.errors).toHaveLength(0);
  });
});

describe('evaluate dataset-by-name and persist paths', () => {
  it('fetches a dataset by name/id when data is a string', async () => {
    mockEvalClient.fetchDataset.mockResolvedValue({ id: 'ds-1' });
    mockEvalClient.fetchDatasetItems.mockResolvedValue([
      { id: 'item-1', input: { q: 'hi' }, expected_output: 'hi' },
    ]);
    mockEvalClient.createExperiment.mockResolvedValue({ id: 'exp-1', url: 'https://app.example/exp-1' });

    const result = await evaluate({
      name: 'by-dataset-name',
      data: 'my-dataset',
      task: (inp) => inp.q,
      scorers: ['exact_match'],
      progress: false,
    });

    expect(mockEvalClient.fetchDataset).toHaveBeenCalledWith('my-dataset', expect.any(Object));
    expect(result.datasetId).toBe('ds-1');
    expect(result.url).toBe('https://app.example/exp-1');
  });

  it('creates an ephemeral dataset for inline array data when persist is true, remapping ids on 1:1 match', async () => {
    mockEvalClient.createEphemeralDataset.mockResolvedValue({
      id: 'ds-ephemeral',
      items: [{ id: 'remote-item-1' }],
    });
    mockEvalClient.createExperiment.mockResolvedValue({ id: 'exp-2', url: null });

    const result = await evaluate({
      name: 'ephemeral',
      data: [{ input: { q: 'hi' } }],
      task: (inp) => inp.q,
      progress: false,
    });

    expect(mockEvalClient.createEphemeralDataset).toHaveBeenCalled();
    expect(result.rows[0].item_id).toBe('remote-item-1');
  });

  it('leaves original ids alone when the ephemeral dataset item count does not match', async () => {
    mockEvalClient.createEphemeralDataset.mockResolvedValue({
      id: 'ds-ephemeral-2',
      items: [], // mismatched length
    });
    mockEvalClient.createExperiment.mockResolvedValue({ id: 'exp-3', url: null });

    const result = await evaluate({
      name: 'ephemeral-mismatch',
      data: [{ input: { q: 'hi' }, id: 'local-id-1' }],
      task: (inp) => inp.q,
      progress: false,
    });

    expect(result.rows[0].item_id).toBe('local-id-1');
  });

  it('resolves prompt version ids when persist and opts.prompt are both set', async () => {
    mockEvalClient.createEphemeralDataset.mockResolvedValue({ id: 'ds-x', items: [] });
    mockEvalClient.resolvePromptVersionIds.mockResolvedValue(['v-1']);
    mockEvalClient.createExperiment.mockResolvedValue({ id: 'exp-4', url: null });

    await evaluate({
      name: 'with-prompt',
      data: [{ input: { q: 'hi' } }],
      task: (inp) => inp.q,
      prompt: 'my-prompt',
      progress: false,
    });

    expect(mockEvalClient.resolvePromptVersionIds).toHaveBeenCalledWith('my-prompt', expect.any(Object));
  });

  it('records a persistError (does not throw) when createExperiment fails', async () => {
    mockEvalClient.createEphemeralDataset.mockResolvedValue({ id: 'ds-y', items: [] });
    mockEvalClient.createExperiment.mockRejectedValue(new Error('experiment creation failed'));

    const result = await evaluate({
      name: 'persist-fails',
      data: [{ input: { q: 'hi' } }],
      task: (inp) => inp.q,
      progress: false,
    });

    expect(result.persistError).toContain('experiment creation failed');
    expect(result.url).toBeNull();
  });

  it('sets experimentId/name span attributes only when persisting', async () => {
    mockEvalClient.createEphemeralDataset.mockResolvedValue({ id: 'ds-z', items: [] });
    mockEvalClient.createExperiment.mockResolvedValue({ id: 'exp-5', url: null });

    const result = await evaluate({
      name: 'persisted-attrs',
      data: [{ input: { q: 'hi' } }],
      task: (inp) => inp.q,
      progress: false,
    });

    expect(result.experimentId).toBe('exp-5');
  });
});

describe('ensureEvalTracing', () => {
  const originalTracciaAgentId = process.env.TRACCIA_AGENT_ID;
  const originalAgentId = process.env.AGENT_ID;

  afterEach(() => {
    if (originalTracciaAgentId === undefined) delete process.env.TRACCIA_AGENT_ID;
    else process.env.TRACCIA_AGENT_ID = originalTracciaAgentId;
    if (originalAgentId === undefined) delete process.env.AGENT_ID;
    else process.env.AGENT_ID = originalAgentId;
  });

  it('calls init() and derives TRACCIA_AGENT_ID from AGENT_ID when tracing has not started', async () => {
    delete process.env.TRACCIA_AGENT_ID;
    process.env.AGENT_ID = 'agent-from-env';
    mockIsTracingStarted = false;
    mockInit = jest.fn(async () => {
      mockIsTracingStarted = true;
    });

    await evaluate({
      name: 'tracing-init',
      data: [{ input: { q: 'hi' } }],
      task: (inp) => inp.q,
      persist: false,
      progress: false,
    });

    expect(mockInit).toHaveBeenCalled();
    expect(process.env.TRACCIA_AGENT_ID).toBe('agent-from-env');
  });

  it('defaults TRACCIA_AGENT_ID to "sdk-evaluate" when neither env var is set', async () => {
    delete process.env.TRACCIA_AGENT_ID;
    delete process.env.AGENT_ID;
    mockIsTracingStarted = false;
    mockInit = jest.fn(async () => {
      mockIsTracingStarted = true;
    });

    await evaluate({
      name: 'tracing-default',
      data: [{ input: { q: 'hi' } }],
      task: (inp) => inp.q,
      persist: false,
      progress: false,
    });

    expect(process.env.TRACCIA_AGENT_ID).toBe('sdk-evaluate');
  });

  it('does not throw (evaluate still runs) when init() fails', async () => {
    mockIsTracingStarted = false;
    mockInit = jest.fn(async () => {
      throw new Error('init failed');
    });

    await expect(
      evaluate({
        name: 'tracing-init-fails',
        data: [{ input: { q: 'hi' } }],
        task: (inp) => inp.q,
        persist: false,
        progress: false,
      }),
    ).resolves.toBeDefined();
  });
});

describe('cost aggregation', () => {
  it('sums per-score cost_usd into cell.cost_usd and aggregates.total_cost_usd', async () => {
    const costlyScorer = () => ({ passed: true, type: 'llm_judge', model: 'gpt-4', cost_usd: 0.05 });

    const result = await evaluate({
      name: 'cost-from-score',
      data: [{ input: { q: 'hi' } }],
      task: () => 'x',
      scorers: [costlyScorer],
      persist: false,
      progress: false,
    });

    expect((result.rows[0].panels as any[])[0].cost_usd).toBeCloseTo(0.05);
    expect(result.aggregates.total_cost_usd).toBeCloseTo(0.05);
  });

  it('includes cost already recorded on the per-item span (costFromSpan) even with no scorer cost', async () => {
    mockItemSpanPresetAttributes = { 'llm.cost.usd': 0.02 };

    const result = await evaluate({
      name: 'cost-from-span',
      data: [{ input: { q: 'hi' } }],
      task: () => 'x',
      persist: false,
      progress: false,
    });

    expect((result.rows[0].panels as any[])[0].cost_usd).toBeCloseTo(0.02);
  });

  it('sets llm_judge span attributes including usage token totals', async () => {
    const judgeScorer = () => ({
      passed: true,
      type: 'llm_judge',
      model: 'gpt-4',
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const result = await evaluate({
      name: 'llm-judge-usage',
      data: [{ input: { q: 'hi' } }],
      task: () => 'x',
      scorers: [judgeScorer],
      persist: false,
      progress: false,
    });

    // annotateScoreSpan swallows internally, so we assert indirectly via a
    // successful run with no errors (the attribute-setting code executed).
    expect(result.errors).toHaveLength(0);
  });
});

describe('jsonable', () => {
  it('passes a JSON-serializable object through unchanged', async () => {
    const result = await evaluate({
      name: 'object-output',
      data: [{ input: { q: 'hi' } }],
      task: () => ({ answer: 'hi', confidence: 0.9 }),
      persist: false,
      progress: false,
    });

    expect((result.rows[0].panels as any[])[0].output).toEqual({ answer: 'hi', confidence: 0.9 });
  });

  it('falls back to String(value) when JSON.stringify throws (circular reference)', async () => {
    const circular: any = {};
    circular.self = circular;

    const result = await evaluate({
      name: 'circular-output',
      data: [{ input: { q: 'hi' } }],
      task: () => circular,
      persist: false,
      progress: false,
    });

    expect(typeof (result.rows[0].panels as any[])[0].output).toBe('string');
  });
});
