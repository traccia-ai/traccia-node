export class EvaluateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluateError';
  }
}
