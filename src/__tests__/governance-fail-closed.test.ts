/**
 * govern({ failOpen }) carries through to per-call policy checks under real observe().
 */

import axios from 'axios';
import { govern } from '../governance/govern';
import { observe } from '../instrumentation/decorator';
import {
  AgentBlockedError,
  _resetPolicyStateForTests,
  _setHttpClientForTests,
} from '../governance/policy';
import { _resetPepStateForTests, _setPepHttpClientForTests } from '../governance/pep';

jest.mock('../config/config', () => ({
  loadConfig: jest.fn(() => ({
    tracing: {
      api_key: 'test-key',
      endpoint: 'https://app.traccia.ai/v1/traces',
    },
  })),
  findConfigFile: jest.fn(),
}));

function policyOutage(): void {
  const statusClient = axios.create();
  jest.spyOn(statusClient, 'get').mockResolvedValue({ status: 200, data: { status: 'allowed' } });
  _setHttpClientForTests(statusClient);

  const pepClient = axios.create();
  jest
    .spyOn(pepClient, 'post')
    .mockRejectedValue(
      Object.assign(new Error('Request failed'), { isAxiosError: true, response: { status: 503 } }),
    );
  _setPepHttpClientForTests(pepClient);
}

function agentWithTool(options: { failOpen?: boolean }) {
  const ran: number[] = [];
  const refund = observe({ asType: 'tool', name: 'refund' })(async ({ amount }: { amount: number }) => {
    ran.push(amount);
    return { refunded: amount };
  });
  const run = govern({ agentId: 'support', name: 'run', ...options })(async () => refund({ amount: 500 }));
  return { run: run as () => Promise<unknown>, ran };
}

describe('govern failOpen during a policy outage', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    _resetPolicyStateForTests();
    _resetPepStateForTests();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    policyOutage();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('blocks the tool call when failOpen is false', async () => {
    const { run, ran } = agentWithTool({ failOpen: false });

    await expect(run()).rejects.toBeInstanceOf(AgentBlockedError);
    expect(ran).toEqual([]);
  });

  it('allows the tool call by default', async () => {
    const { run, ran } = agentWithTool({});

    await expect(run()).resolves.toEqual({ refunded: 500 });
    expect(ran).toEqual([500]);
  });
});
