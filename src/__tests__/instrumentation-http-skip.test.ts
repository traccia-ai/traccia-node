import { shouldSkipHttp } from '../instrumentation/http-skip';

describe('shouldSkipHttp', () => {
  it('skips govern status and block URLs', () => {
    expect(
      shouldSkipHttp('http://localhost:8000/api/v1/agents/policy-tool-storm-smoke/status'),
    ).toBe(true);
    expect(
      shouldSkipHttp('http://localhost:8000/api/v1/agents/policy-tool-storm-smoke/blocks'),
    ).toBe(true);
    expect(shouldSkipHttp('https://custom.example/agents/agent-x/status')).toBe(true);
    expect(shouldSkipHttp('https://custom.example/agents/agent-x/blocks')).toBe(true);
  });

  it('skips traces, metrics, eval-runtime, prompt-runtime, and policy check/settle', () => {
    expect(shouldSkipHttp('https://api.traccia.ai/v2/traces')).toBe(true);
    expect(shouldSkipHttp('https://api.traccia.ai/api/v1/eval-runtime/score')).toBe(true);
    expect(
      shouldSkipHttp('http://localhost:8001/api/v1/prompt-runtime/prompts/support-reply'),
    ).toBe(true);
    expect(shouldSkipHttp('https://app.traccia.ai/api/v1/policy/check')).toBe(true);
    expect(shouldSkipHttp('http://localhost:8001/api/v1/policy/settle')).toBe(true);
  });

  it('does not skip ordinary HTTP', () => {
    expect(shouldSkipHttp('https://api.github.com/repos/traccia/x')).toBe(false);
    expect(shouldSkipHttp('http://localhost:8000/health')).toBe(false);
  });
});
