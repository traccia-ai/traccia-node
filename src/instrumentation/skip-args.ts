/**
 * `observe({ skipArgs })` support: decide which call arguments are kept out of
 * the `function.args` span attribute.
 *
 * JavaScript has no reliable runtime parameter-name introspection, so a name in
 * `skipArgs` is matched two ways (see `ObserveOptions.skipArgs`):
 *
 * 1. Positional: parameter names parsed from `fn.toString()`. A positional
 *    argument whose parameter name is listed is dropped. A listed rest parameter
 *    (`...rest`) drops every argument it collects. Parameters the parser cannot
 *    name (destructuring patterns, minified or native code) never match.
 * 2. Object keys: when the call has exactly one argument and it is a plain
 *    object (the usual tool shape, `tool({ query, apiKey })`), its listed
 *    top-level keys are dropped. Nested values are left alone.
 */

const IDENT = /^[A-Za-z_$][\w$]*$/;

export interface ParamName {
    name: string;
    rest: boolean;
}

/** Remove comments so they cannot confuse the parameter scanner. */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Split the text between the parameter list's parentheses at top-level commas.
 * Returns null when the list cannot be found or is unbalanced.
 */
function paramListSegments(src: string): string[] | null {
    const open = src.indexOf('(');
    if (open < 0) return null;
    const segments: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let current = '';
    for (let i = open + 1; i < src.length; i++) {
        const ch = src[i];
        if (quote) {
            current += ch;
            if (ch === '\\') {
                current += src[++i] ?? '';
            } else if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            quote = ch;
            current += ch;
        } else if (ch === '(' || ch === '[' || ch === '{') {
            depth++;
            current += ch;
        } else if (ch === ')' || ch === ']' || ch === '}') {
            if (depth === 0) {
                if (ch !== ')') return null;
                segments.push(current);
                return segments;
            }
            depth--;
            current += ch;
        } else if (ch === ',' && depth === 0) {
            segments.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    return null;
}

/**
 * Best-effort parameter names of `fn`, one entry per declared parameter.
 * An entry is null when the parameter has no plain name (destructuring).
 * Returns [] when the source cannot be parsed, so nothing matches positionally.
 */
export function parameterNames(fn: unknown): (ParamName | null)[] {
    if (typeof fn !== 'function') return [];
    let src: string;
    try {
        src = stripComments(Function.prototype.toString.call(fn)).trim();
    } catch {
        return [];
    }

    // Single unparenthesised arrow parameter: `x => ...`, `async x => ...`.
    const bareArrow = /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(src);
    if (bareArrow && bareArrow[1] !== 'async') {
        return [{ name: bareArrow[1], rest: false }];
    }

    const segments = paramListSegments(src);
    if (!segments) return [];
    const names: (ParamName | null)[] = [];
    for (const raw of segments) {
        const seg = raw.trim();
        if (seg === '') continue; // trailing comma or empty list
        const rest = seg.startsWith('...');
        // Drop the default value: everything from the first top-level '='.
        const head = (rest ? seg.slice(3) : seg).split('=')[0].trim();
        names.push(IDENT.test(head) ? { name: head, rest } : null);
    }
    return names;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * The arguments to record on the span, with `skip` applied. Returns `args`
 * itself when nothing is skipped; never mutates `args` or its elements.
 */
export function applySkipArgs(
    args: unknown[],
    skip: readonly string[] | undefined,
    params: (ParamName | null)[]
): unknown[] {
    if (!skip || skip.length === 0) return args;
    const skipSet = new Set(skip);

    const kept: unknown[] = [];
    for (let i = 0; i < args.length; i++) {
        const param = params[Math.min(i, params.length - 1)];
        // Past the declared list only a rest parameter still owns the argument.
        const owner = i < params.length ? param : param?.rest ? param : null;
        if (owner && skipSet.has(owner.name)) continue;
        kept.push(args[i]);
    }

    if (args.length === 1 && kept.length === 1 && isPlainObject(kept[0])) {
        const obj = kept[0];
        if (Object.keys(obj).some((k) => skipSet.has(k))) {
            const copy: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(obj)) {
                if (!skipSet.has(k)) copy[k] = v;
            }
            return [copy];
        }
    }
    return kept.length === args.length ? args : kept;
}
