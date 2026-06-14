/**
 * Traccia SDK error hierarchy and exceptions.
 */

export class TracciaError extends Error {
  public readonly details: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'TracciaError';
    this.details = details || {};
    
    // Set the prototype explicitly to ensure correct instanceOf checks in TypeScript
    Object.setPrototypeOf(this, TracciaError.prototype);
  }

  public override toString(): string {
    if (Object.keys(this.details).length > 0) {
      const detailsStr = Object.entries(this.details)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      return `${this.message} (${detailsStr})`;
    }
    return this.message;
  }
}

export class ConfigError extends TracciaError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.name = 'ConfigError';
    Object.setPrototypeOf(this, ConfigError.prototype);
  }
}

export class ValidationError extends TracciaError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

export class ExportError extends TracciaError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.name = 'ExportError';
    Object.setPrototypeOf(this, ExportError.prototype);
  }
}

export class RateLimitError extends TracciaError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.name = 'RateLimitError';
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}

export class InitializationError extends TracciaError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.name = 'InitializationError';
    Object.setPrototypeOf(this, InitializationError.prototype);
  }
}

export class InstrumentationError extends TracciaError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.name = 'InstrumentationError';
    Object.setPrototypeOf(this, InstrumentationError.prototype);
  }
}
