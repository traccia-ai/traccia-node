/**
 * Tests for runtime governance policy checks.
 */

import axios from 'axios';
import {
  AgentBlockedError,
  checkAgentStatus,
  _resetPolicyStateForTests,
  _setHttpClientForTests,
} from '../governance/policy';
import { govConfig } from '../governance/config';

jest.mock('../config/config', () => ({
  loadConfig: jest.fn(() => ({
    tracing: {
      api_key: 'test-key',
      endpoint: 'https://api.traccia.ai/v2/traces',
    },
  })),
  findConfigFile: jest.fn(),
}));

describe('governance policy', () => {
  beforeEach(() => {
    _resetPolicyStateForTests();
    jest.clearAllMocks();
  });

  it('derives default status URL from tracing endpoint', async () => {
    const client = axios.create();
    const get = jest.spyOn(client, 'get').mockResolvedValue({
      status: 200,
      data: { status: 'allowed' },
    });
    _setHttpClientForTests(client);

    await checkAgentStatus('agent-1', { failOpen: true });

    expect(get).toHaveBeenCalledWith(
      'https://api.traccia.ai/api/v1/agents/agent-1/status',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-key' },
      }),
    );
  });

  it('raises AgentBlockedError on hard_block', async () => {
    const client = axios.create();
    jest.spyOn(client, 'get').mockResolvedValue({
      status: 200,
      data: { status: 'hard_block', policy_id: 'pol-1' },
    });
    jest.spyOn(client, 'post').mockResolvedValue({ status: 200, data: {} });
    _setHttpClientForTests(client);

    await expect(checkAgentStatus('agent-1', { failOpen: false })).rejects.toBeInstanceOf(
      AgentBlockedError,
    );
  });

  it('allows execution on HTTP error when failOpen is true', async () => {
    const client = axios.create();
    jest.spyOn(client, 'get').mockRejectedValue(new Error('timeout'));
    _setHttpClientForTests(client);

    await expect(checkAgentStatus('agent-1', { failOpen: true })).resolves.toBeUndefined();
  });

  it('blocks on HTTP error when failOpen is false', async () => {
    const client = axios.create();
    jest.spyOn(client, 'get').mockRejectedValue(new Error('timeout'));
    _setHttpClientForTests(client);

    await expect(checkAgentStatus('agent-1', { failOpen: false })).rejects.toBeInstanceOf(
      AgentBlockedError,
    );
  });

  it('uses cache on second call', async () => {
    const client = axios.create();
    const get = jest.spyOn(client, 'get').mockResolvedValue({
      status: 200,
      data: { status: 'allowed' },
    });
    _setHttpClientForTests(client);

    await checkAgentStatus('agent-cache', { failOpen: true });
    await checkAgentStatus('agent-cache', { failOpen: true });

    expect(get).toHaveBeenCalledTimes(1);
  });

  it('respects advanced status endpoint override', async () => {
    govConfig.statusCheckEndpoint = 'https://custom.example/agents/{agent_id}/status';
    const client = axios.create();
    const get = jest.spyOn(client, 'get').mockResolvedValue({
      status: 200,
      data: { status: 'allowed' },
    });
    _setHttpClientForTests(client);

    await checkAgentStatus('agent-x', { failOpen: true });

    expect(get).toHaveBeenCalledWith(
      'https://custom.example/agents/agent-x/status',
      expect.any(Object),
    );
  });

  it('re-fetches once the cache TTL has expired', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    govConfig.statusCacheTtlSeconds = 1;
    const client = axios.create();
    const get = jest.spyOn(client, 'get').mockResolvedValue({
      status: 200,
      data: { status: 'allowed' },
    });
    _setHttpClientForTests(client);

    await checkAgentStatus('agent-ttl', { failOpen: true });
    jest.advanceTimersByTime(1500);
    await checkAgentStatus('agent-ttl', { failOpen: true });

    expect(get).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('posts a block record to the postBlockEndpoint override on hard_block', async () => {
    govConfig.postBlockEndpoint = 'https://custom.example/agents/{agent_id}/blocks';
    const client = axios.create();
    jest.spyOn(client, 'get').mockResolvedValue({
      status: 200,
      data: { status: 'hard_block', policy_id: 'pol-42' },
    });
    const post = jest.spyOn(client, 'post').mockResolvedValue({ status: 200, data: {} });
    _setHttpClientForTests(client);

    await expect(checkAgentStatus('agent-block', { failOpen: false })).rejects.toBeInstanceOf(
      AgentBlockedError,
    );

    // recordBlockAsync is fire-and-forget; flush microtasks.
    await Promise.resolve();
    await Promise.resolve();

    expect(post).toHaveBeenCalledWith(
      'https://custom.example/agents/agent-block/blocks',
      { policy_id: 'pol-42', block_type: 'hard_block' },
      expect.objectContaining({ headers: { Authorization: 'Bearer test-key' } }),
    );
  });

  it('warns and continues on soft_block', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const client = axios.create();
    jest.spyOn(client, 'get').mockResolvedValue({
      status: 200,
      data: { status: 'soft_block' },
    });
    _setHttpClientForTests(client);

    await expect(checkAgentStatus('agent-soft', { failOpen: true })).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('SOFT BLOCKED'));

    warnSpy.mockRestore();
  });

  it('warns and treats an unrecognized status as allowed', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const client = axios.create();
    jest.spyOn(client, 'get').mockResolvedValue({
      status: 200,
      data: { status: 'something_weird' },
    });
    _setHttpClientForTests(client);

    await expect(checkAgentStatus('agent-unknown', { failOpen: true })).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown agent status received'));

    warnSpy.mockRestore();
  });

  it('warns (does not throw) when recording a block fails', async () => {
    govConfig.postBlockEndpoint = undefined;
    const client = axios.create();
    jest.spyOn(client, 'get').mockResolvedValue({
      status: 200,
      data: { status: 'hard_block', policy_id: 'pol-fail' },
    });
    jest.spyOn(client, 'post').mockRejectedValue(new Error('post failed'));
    _setHttpClientForTests(client);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(checkAgentStatus('agent-block-fail', { failOpen: false })).rejects.toBeInstanceOf(
      AgentBlockedError,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(warnSpy).toHaveBeenCalledWith(
      '[traccia.governance] Failed to record agent block to Traccia API:',
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it('warns and skips the check when the config has no api_key', async () => {
    const { loadConfig } = jest.requireMock('../config/config') as { loadConfig: jest.Mock };
    loadConfig.mockReturnValueOnce({ tracing: { endpoint: 'https://api.traccia.ai/v2/traces' } });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const client = axios.create();
    const get = jest.spyOn(client, 'get');
    _setHttpClientForTests(client);

    await expect(checkAgentStatus('agent-no-key', { failOpen: true })).resolves.toBeUndefined();

    expect(get).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('API key not found'));
    warnSpy.mockRestore();
  });

  it('warns and skips the check when the config has no tracesEndpoint', async () => {
    const { loadConfig } = jest.requireMock('../config/config') as { loadConfig: jest.Mock };
    loadConfig.mockReturnValueOnce({ tracing: { api_key: 'test-key' } });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const client = axios.create();
    const get = jest.spyOn(client, 'get');
    _setHttpClientForTests(client);

    await expect(checkAgentStatus('agent-no-endpoint', { failOpen: true })).resolves.toBeUndefined();

    expect(get).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('endpoint not found'));
    warnSpy.mockRestore();
  });

  it('allows execution on a resolved non-200 response when failOpen is true', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const client = axios.create();
    jest.spyOn(client, 'get').mockResolvedValue({ status: 500, data: {} });
    _setHttpClientForTests(client);

    await expect(checkAgentStatus('agent-500-open', { failOpen: true })).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('HTTP 500'));

    warnSpy.mockRestore();
  });

  it('blocks execution on a resolved non-200 response when failOpen is false', async () => {
    const client = axios.create();
    jest.spyOn(client, 'get').mockResolvedValue({ status: 503, data: {} });
    _setHttpClientForTests(client);

    await expect(checkAgentStatus('agent-500-closed', { failOpen: false })).rejects.toBeInstanceOf(
      AgentBlockedError,
    );
  });

  it('defaults status to "allowed" when the response omits it, and failOpen to true when options is omitted', async () => {
    const client = axios.create();
    const get = jest.spyOn(client, 'get').mockResolvedValue({ status: 200, data: {} });
    _setHttpClientForTests(client);

    await expect(checkAgentStatus('agent-default-status')).resolves.toBeUndefined();
    expect(get).toHaveBeenCalled();
  });

  it('shares one in-flight request across concurrent calls for the same uncached agent', async () => {
    const client = axios.create();
    let resolveGet: (value: unknown) => void = () => {};
    const get = jest.spyOn(client, 'get').mockImplementation(
      () => new Promise((resolve) => {
        resolveGet = resolve;
      }),
    );
    _setHttpClientForTests(client);

    const call1 = checkAgentStatus('agent-concurrent', { failOpen: true });
    const call2 = checkAgentStatus('agent-concurrent', { failOpen: true });

    resolveGet({ status: 200, data: { status: 'allowed' } });
    await Promise.all([call1, call2]);

    expect(get).toHaveBeenCalledTimes(1);
  });
});
