/**
 * Whether a tool call that failed may have done its side effect: such a call's key is held as
 * unconfirmed. It is released only when the tool says the failure is definite.
 */

const DEFINITE_FAILURE = Symbol.for('traccia.definiteFailure');

/**
 * Throw from an idempotent tool to say its call surely did not happen, so the key is freed and a
 * retry runs: `throw new DefiniteFailure('card declined', { cause: err })`. Throw it only where no
 * request can have done the work: it vouches for everything below it in the chain.
 */
export class DefiniteFailure extends Error {
  readonly [DEFINITE_FAILURE] = true;

  constructor(message?: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'DefiniteFailure';
    if (options && 'cause' in options) (this as { cause?: unknown }).cause = options.cause;
  }
}

// How many errors one classification reads looking for one `unconfirmedOn` accepts (causes, group
// members). A walk cut short holds the call. Same as the Python SDK.
const WALK_BUDGET = 1000;

/** A property that never throws: a getter on a third-party error must not cost the settle. */
function attr(obj: unknown, name: string | symbol): unknown {
  if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) return undefined;
  try {
    return (obj as Record<string | symbol, unknown>)[name];
  } catch {
    return undefined;
  }
}

/**
 * Whether a tool call that threw `error` may have done its side effect, so its key is held.
 *
 * Held unless the error the tool threw is the author's say that the call did not happen: a
 * `DefiniteFailure` (from any copy of the SDK), or one `releaseOn` returns `true` for (only `true`:
 * a promise is not a yes), with nothing in its chain (`cause`, group `errors`) that `unconfirmedOn`
 * accepts. Nothing else frees a call: an error describes only the last request, and a client that
 * retried by itself, followed a redirect, or a tool that made several requests, may have done the
 * work before it. An error group is judged as itself, not by its members.
 */
export function isUnconfirmed(
  error: unknown,
  unconfirmedOn?: (error: unknown) => boolean,
  releaseOn?: (error: unknown) => boolean,
): boolean {
  if (attr(error, DEFINITE_FAILURE) !== true && !(releaseOn && releaseOn(error) === true)) return true;
  if (!unconfirmedOn) return false;
  const stack: unknown[] = [error];
  const seen = new Set<unknown>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || current === null || seen.has(current)) continue;
    if (seen.size >= WALK_BUDGET) return true; // errors still unread: unconfirmedOn may accept one
    seen.add(current);
    if (unconfirmedOn(current)) return true; // any truthy value, a promise too, holds
    const linked: unknown[] = [];
    if (groupMembers(attr(current, 'errors'), WALK_BUDGET, linked)) return true;
    linked.push(attr(current, 'cause'));
    for (let i = linked.length - 1; i >= 0; i--) stack.push(linked[i]);
  }
  return false;
}

/**
 * Adds the members of an error group to `out`: an array, a Map's values, or any other iterable such
 * as a Set, at most `cap` of them. Returns whether some were left unread (more than `cap`, or an
 * iterator that threw).
 */
function groupMembers(value: unknown, cap: number, out: unknown[]): boolean {
  if (value === null || typeof value !== 'object') return false;
  let source: unknown = value;
  try {
    if (Object.prototype.toString.call(value) === '[object Map]') source = (value as Map<unknown, unknown>).values();
  } catch {
    return true;
  }
  if (Array.isArray(source)) {
    for (let i = 0; i < source.length && i < cap; i++) out.push(source[i]);
    return source.length > cap;
  }
  let iterator: unknown;
  try {
    iterator = (source as { [Symbol.iterator]?: unknown })[Symbol.iterator];
  } catch {
    return true;
  }
  if (typeof iterator !== 'function') return false;
  let count = 0;
  try {
    for (const member of source as Iterable<unknown>) {
      if (count >= cap) return true;
      out.push(member);
      count++;
    }
  } catch {
    return true; // a throwing iterator: the members it did not give are unread
  }
  return false;
}
