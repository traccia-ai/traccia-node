/**
 * Tests for disclosure helper.
 */

import { disclosure, enrichGovernanceAttributes } from '../governance/disclosure';
import { getCurrentSpan } from '../context/context';
import {
  EVENT_TYPE,
  TRANSPARENCY_DISCLOSED,
  CONTENT_SYNTHETIC,
  MODEL_ID,
  MODEL_VERSION,
  SESSION_ID,
  INPUT_HASH,
  OUTPUT_HASH,
  RISK_TIER,
  INTEGRITY_HASH,
} from '../governance/schema';

jest.mock('../context/context', () => ({
  getCurrentSpan: jest.fn(),
}));

describe('disclosure', () => {
  it('writes transparency attributes on current span', () => {
    const setAttribute = jest.fn();
    (getCurrentSpan as jest.Mock).mockReturnValue({ setAttribute });

    disclosure({ channel: 'ui', disclosedToUser: true, syntheticContent: true, generator: 'gpt-4' });

    expect(setAttribute).toHaveBeenCalledWith(EVENT_TYPE, 'transparency');
    expect(setAttribute).toHaveBeenCalledWith(TRANSPARENCY_DISCLOSED, true);
    expect(setAttribute).toHaveBeenCalledWith('governance.transparency.channel', 'ui');
    expect(setAttribute).toHaveBeenCalledWith(CONTENT_SYNTHETIC, true);
    expect(setAttribute).toHaveBeenCalledWith('governance.content.generator', 'gpt-4');
  });

  it('marks synthetic without generator', () => {
    const setAttribute = jest.fn();
    (getCurrentSpan as jest.Mock).mockReturnValue({ setAttribute });
    disclosure({ syntheticContent: true });
    expect(setAttribute).toHaveBeenCalledWith(CONTENT_SYNTHETIC, true);
    expect(setAttribute).not.toHaveBeenCalledWith(
      'governance.content.generator',
      expect.anything(),
    );
  });

  it('no-ops when no active span', () => {
    (getCurrentSpan as jest.Mock).mockReturnValue(undefined);
    expect(() => disclosure()).not.toThrow();
  });
});

describe('enrichGovernanceAttributes', () => {
  it('fills model, session, hashes, and risk tier', () => {
    const out = enrichGovernanceAttributes(
      { existing: true },
      {
        eventType: 'tool_call',
        modelId: 'm1',
        modelVersion: 'v1',
        sessionId: 's1',
        inputText: 'in',
        outputText: 'out',
        euRiskTier: 'high',
      },
    );
    expect(out.existing).toBe(true);
    expect(out[EVENT_TYPE]).toBe('tool_call');
    expect(out[MODEL_ID]).toBe('m1');
    expect(out[MODEL_VERSION]).toBe('v1');
    expect(out[SESSION_ID]).toBe('s1');
    expect(out[INPUT_HASH]).toEqual(expect.any(String));
    expect(out[OUTPUT_HASH]).toEqual(expect.any(String));
    expect(out[RISK_TIER]).toBe('high');
    expect(out[INTEGRITY_HASH]).toEqual(expect.any(String));
  });

  it('defaults event type when options empty', () => {
    const out = enrichGovernanceAttributes({});
    expect(out[EVENT_TYPE]).toBe('inference');
    expect(out[INPUT_HASH]).toBeUndefined();
  });
});
