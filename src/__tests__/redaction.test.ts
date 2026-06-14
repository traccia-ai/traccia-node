/**
 * Tests for PII redaction.
 */

import {
  redactString,
  redactAttributes,
  applyRedactionToSpan,
  DEFAULT_SENSITIVE_KEY_FRAGMENTS,
} from '../redaction/redaction';

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