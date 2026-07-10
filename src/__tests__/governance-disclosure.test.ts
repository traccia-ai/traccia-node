/**
 * Tests for disclosure helper.
 */

import { disclosure } from '../governance/disclosure';
import { getCurrentSpan } from '../context/context';
import {
  EVENT_TYPE,
  TRANSPARENCY_DISCLOSED,
  CONTENT_SYNTHETIC,
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

  it('no-ops when no active span', () => {
    (getCurrentSpan as jest.Mock).mockReturnValue(undefined);
    expect(() => disclosure()).not.toThrow();
  });
});
