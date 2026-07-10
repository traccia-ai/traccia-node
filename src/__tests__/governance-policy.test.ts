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
});
