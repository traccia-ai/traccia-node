/**
 * Generic argument serialization and redaction utilities for instrumentation.
 *
 * Designed to be generic, lightweight, and fail-closed:
 * - Avoids runtime parameter name introspection which breaks under minification/transpilation.
 * - Supports positional argument redaction via index (e.g. 0, '1').
 * - Supports property key redaction on object arguments (e.g. 'password', 'apiKey').
 * - Handles BigInt and circular object references safely without throwing.
 * - Fails closed: if serialization encounters an error when skipArgs is set,
 *   returns '[REDACTED]' to prevent sensitive data leaks.
 */

export function safeStringify(
    value: unknown,
    skipArgs?: readonly (string | number)[],
    maxLength = 1000
): string {
    const hasSkip = Boolean(skipArgs && skipArgs.length > 0);
    const skipSet = hasSkip
        ? new Set(skipArgs!.map((s) => String(s).toLowerCase().trim()))
        : null;

    try {
        const seen = new WeakSet<object>();
        const str = JSON.stringify(value, (key, val) => {
            if (key && skipSet && skipSet.has(key.toLowerCase())) {
                return '[REDACTED]';
            }
            if (typeof val === 'bigint') {
                return `${val.toString()}n`;
            }
            if (typeof val === 'object' && val !== null) {
                if (seen.has(val)) {
                    return '[Circular]';
                }
                seen.add(val);
            }
            return val;
        });

        return (str ?? String(value)).slice(0, maxLength);
    } catch {
        return hasSkip ? '[REDACTED]' : '[Unserializable]';
    }
}

/**
 * Serializes function arguments into a bounded JSON string while redacting sensitive data.
 *
 * Signature accepts either:
 *   safeSerializeArgs(args, skipArgs, maxLength)
 *   safeSerializeArgs(fn, args, skipArgs, maxLength) [for backward compatibility]
 */
export function safeSerializeArgs(
    arg1: unknown,
    arg2?: unknown,
    arg3?: unknown,
    arg4 = 1000
): string {
    let args: unknown[];
    let skipArgs: readonly (string | number)[] | undefined;
    let maxLength: number;

    if (Array.isArray(arg1)) {
        args = arg1;
        skipArgs = arg2 as readonly (string | number)[] | undefined;
        maxLength = typeof arg3 === 'number' ? arg3 : 1000;
    } else if (Array.isArray(arg2)) {
        args = arg2;
        skipArgs = arg3 as readonly (string | number)[] | undefined;
        maxLength = arg4;
    } else {
        return '[]';
    }

    if (args.length === 0) {
        return '[]';
    }

    const hasSkip = Boolean(skipArgs && skipArgs.length > 0);
    const skipSet = hasSkip
        ? new Set(skipArgs!.map((s) => String(s).toLowerCase().trim()))
        : null;

    try {
        // Redact positional arguments matching specified numeric or string indices (e.g. 0, '1')
        const processedArgs = args.map((arg, idx) => {
            if (skipSet && (skipSet.has(String(idx)) || skipSet.has(`arg${idx}`))) {
                return '[REDACTED]';
            }
            return arg;
        });

        return safeStringify(processedArgs, skipArgs, maxLength);
    } catch {
        // Fail-closed policy: never leak unredacted data if serialization fails
        return hasSkip ? '[REDACTED]' : '[]';
    }
}
