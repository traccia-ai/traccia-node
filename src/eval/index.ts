/**
 * SDK evaluate() — offline experiments from code.
 */

export { evaluate, EvaluateResult } from './evaluate';
export type { EvaluateOptions, ScorerSpec, DataSpec } from './evaluate';
export { EvaluateError } from './errors';
export { BUILTIN_SCORERS, runBuiltinScorer } from './builtins';
