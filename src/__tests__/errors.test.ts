import { TracciaError, ConfigError, RateLimitError, ExportError, InstrumentationError } from '../errors';

describe('Error Hierarchy', () => {
  it('should instantiate TracciaError with message', () => {
    const error = new TracciaError('Base error');
    expect(error.message).toBe('Base error');
    expect(error.name).toBe('TracciaError');
  });

  it('should preserve details with TracciaError', () => {
    const details = { code: 404 };
    const error = new TracciaError('Wrapped error', details);
    expect(error.message).toBe('Wrapped error');
    expect(error.details).toBe(details);
    expect(error.name).toBe('TracciaError');
  });

  it('should have correct names for specific errors', () => {
    expect(new ConfigError('msg').name).toBe('ConfigError');
    expect(new RateLimitError('msg').name).toBe('RateLimitError');
    expect(new ExportError('msg').name).toBe('ExportError');
    expect(new InstrumentationError('msg').name).toBe('InstrumentationError');
  });

  it('should correctly instanceof check', () => {
    const configError = new ConfigError('msg');
    expect(configError instanceof ConfigError).toBe(true);
    expect(configError instanceof TracciaError).toBe(true);
    expect(configError instanceof Error).toBe(true);
  });
});
