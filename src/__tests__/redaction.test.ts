/**
 * Tests for PII redaction.
 */

import {
  redactString,
  redactAttributes,
  redactValue,
  applyRedactionToSpan,
  DEFAULT_SENSITIVE_KEY_FRAGMENTS,
} from '../redaction/redaction';
import { RedactionSpanProcessor } from '../redaction/processor';

describe('redactString', () => {
  it('should redact email addresses', () => {
    const result = redactString('Contact me at test@example.com please');
    expect(result).toBe('Contact me at [REDACTED_EMAIL] please');
  });

  it('should redact phone numbers', () => {
    const result = redactString('Call 123-456-7890');
    expect(result).toBe('Call [REDACTED_PHONE]');
  });

  it('should redact SSN', () => {
    const result = redactString('My SSN is 123-45-6789');
    expect(result).toBe('My SSN is [REDACTED_SSN]');
  });

  it('should redact MRN, NPI, and DOB heuristics', () => {
    const result = redactString('Patient MRN: A12B34; NPI 1234567890; DOB 01/15/1980');
    expect(result).toContain('[REDACTED_MRN]');
    expect(result).toContain('[REDACTED_NPI]');
    expect(result).toContain('[REDACTED_DOB]');
    expect(result).not.toContain('A12B34');
    expect(result).not.toContain('1234567890');
  });

  it('should redact NPI before treating digits as phone', () => {
    const result = redactString('Provider NPI 1234567890');
    expect(result).toContain('[REDACTED_NPI]');
    expect(result).not.toContain('[REDACTED_PHONE]');
  });

  it('should redact medicare-style IDs', () => {
    expect(redactString('ID 1234-5678-9012')).toContain('[REDACTED_ID]');
  });

  it('should return empty string unchanged', () => {
    expect(redactString('')).toBe('');
    expect(redactString(null as unknown as string)).toBe('');
  });
});

describe('redactAttributes', () => {
  it('should redact sensitive string attributes', () => {
    const attrs = {
      prompt: 'My email is test@example.com',
      'llm.output': 'Hello world',
      other_attr: 'Not sensitive',
    };

    const result = redactAttributes(attrs);
    expect(result.prompt).toBe('My email is [REDACTED_EMAIL]');
    expect(result['llm.output']).toBe('Hello world');
    expect(result.other_attr).toBe('Not sensitive');
  });

  it('should return empty object for null/undefined input', () => {
    expect(redactAttributes(null)).toEqual({});
    expect(redactAttributes(undefined)).toEqual({});
  });

  it('should add REDACTION_APPLIED marker', () => {
    const result = redactAttributes({ prompt: 'test' });
    expect(result['governance.redaction_applied']).toBe(true);
  });
});

describe('applyRedactionToSpan', () => {
  it('should apply redaction to span attributes', () => {
    const originalSetAttribute = jest.fn();
    const span = {
      attributes: {
        prompt: 'My email is test@example.com',
      },
      setAttribute: originalSetAttribute,
    };

    const changed = applyRedactionToSpan(span);
    expect(changed).toBeGreaterThan(0);
    expect(originalSetAttribute).toHaveBeenCalledWith('governance.redaction_applied', true);
  });

  it('should return 0 for span without setAttribute', () => {
    const changed = applyRedactionToSpan({});
    expect(changed).toBe(0);
  });

  it('should return 0 for empty span attributes', () => {
    const span = {
      attributes: {},
      setAttribute: jest.fn(),
    };
    const changed = applyRedactionToSpan(span);
    expect(changed).toBe(0);
  });

  it('honors extraKeyFragments', () => {
    const setAttribute = jest.fn();
    const span = {
      attributes: { custom_secret: 'a@b.com' },
      setAttribute,
    };
    applyRedactionToSpan(span, { extraKeyFragments: ['secret'] });
    expect(setAttribute).toHaveBeenCalledWith(
      'custom_secret',
      expect.stringContaining('[REDACTED_EMAIL]'),
    );
  });
});

describe('redactValue', () => {
  it('redacts nested objects and arrays for sensitive keys', () => {
    const nested = redactValue({
      patient: 'email a@b.com',
      tags: ['x', 'contact y@z.com'],
      meta: { prompt: 'hi a@b.com' },
      count: 1,
    }) as Record<string, unknown>;
    expect(nested.patient).toEqual(expect.stringContaining('[REDACTED_EMAIL]'));
    expect(JSON.stringify(nested.meta)).toContain('[REDACTED_EMAIL]');
    expect(nested.count).toBe(1);
  });

  it('leaves nonsensitive strings alone unless redactAllStrings', () => {
    expect(redactValue('a@b.com', { key: 'meta' })).toBe('a@b.com');
    expect(redactValue('a@b.com', { redactAllStrings: true })).toContain('[REDACTED_EMAIL]');
  });
});

describe('RedactionSpanProcessor', () => {
  it('redacts span attributes on end', () => {
    const setAttribute = jest.fn();
    const processor = new RedactionSpanProcessor({ extraKeyFragments: ['note'] });
    processor.onEnd({
      attributes: { clinical_note: 'MRN: ABCD12' },
      setAttribute,
    } as never);
    expect(setAttribute).toHaveBeenCalledWith('governance.redaction_applied', true);
    expect(setAttribute).toHaveBeenCalledWith(
      'clinical_note',
      expect.stringContaining('[REDACTED_MRN]'),
    );
  });

  it('no-ops for empty or invalid spans', () => {
    const processor = new RedactionSpanProcessor();
    expect(() => processor.onEnd(null as never)).not.toThrow();
    expect(() => processor.onEnd({ attributes: {}, setAttribute: jest.fn() } as never)).not.toThrow();
    expect(() => processor.shutdown()).not.toThrow();
    expect(() => processor.forceFlush()).not.toThrow();
  });
});

describe('DEFAULT_SENSITIVE_KEY_FRAGMENTS', () => {
  it('should contain expected key fragments', () => {
    expect(DEFAULT_SENSITIVE_KEY_FRAGMENTS.has('prompt')).toBe(true);
    expect(DEFAULT_SENSITIVE_KEY_FRAGMENTS.has('completion')).toBe(true);
    expect(DEFAULT_SENSITIVE_KEY_FRAGMENTS.has('input')).toBe(true);
    expect(DEFAULT_SENSITIVE_KEY_FRAGMENTS.has('output')).toBe(true);
    expect(DEFAULT_SENSITIVE_KEY_FRAGMENTS.has('message')).toBe(true);
  });
});