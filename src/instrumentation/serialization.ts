/**
 * Generic argument serialization and redaction utilities for instrumentation.
 *
 * Designed to be generic, lightweight, and fail-closed:
 * - Avoids runtime parameter name introspection which breaks under minification/transpilation.
 * - Supports positional argument redaction via index (e.g. 0, '1').
 * - Supports property key redaction on object arguments (e.g. 'password', 'apiKey').
 * - Handles BigInt and circular object references safely without treating repeated references as cycles.
 * - Prevents redaction bypass through custom toJSON() serializers by sanitizing sensitive properties
 *   before toJSON() is invoked, or failing closed if custom serialization throws or cannot be sanitized.
 * - Fails closed: if serialization encounters an error when skipArgs is set,
 *   returns '[REDACTED]' to prevent sensitive data leaks.
 */

interface JsonSerializable {
    toJSON(): unknown;
}

interface TypedAccessorDescriptor {
    get?: (this: unknown) => unknown;
    set?: (this: unknown, value: unknown) => void;
    enumerable?: boolean;
}

function hasToJsonMethod(obj: unknown): obj is JsonSerializable {
    return Boolean(obj && typeof obj === 'object' && typeof (obj as Partial<JsonSerializable>).toJSON === 'function');
}

function defineSanitizedGetter(
    target: object,
    key: string,
    desc: PropertyDescriptor,
    skipSet: Set<string>,
    defaultEnumerable: boolean,
): void {
    const typed = desc as TypedAccessorDescriptor;
    const getter = typed.get;
    const setter = typed.set;
    if (typeof getter !== 'function') return;
    Object.defineProperty(target, key, {
        get(this: unknown): unknown {
            const res = Reflect.apply(getter, this, []);
            if (res === this) return this;
            return sanitizeForToJSON(res, new WeakMap([[target, target]]), skipSet);
        },
        ...(typeof setter === 'function'
            ? {
                  set(this: unknown, value: unknown): void {
                      Reflect.apply(setter, this, [value]);
                  },
              }
            : {}),
        enumerable: typed.enumerable ?? defaultEnumerable,
        configurable: true,
    });
}

function hasOwnSensitiveKeys(
    obj: object,
    skipSet: Set<string>,
    seen: Set<object> = new Set(),
    ignoreNumericKeys = false,
): boolean {
    if (!obj || typeof obj !== 'object' || seen.has(obj)) return false;
    seen.add(obj);

    const descs = Object.getOwnPropertyDescriptors(obj);
    for (const [key, desc] of Object.entries(descs)) {
        if (ignoreNumericKeys && (/^\d+$/.test(key) || key === 'length')) {
            continue;
        }
        if (skipSet.has(key.toLowerCase())) {
            return true;
        }
        if ('value' in desc && desc.value && typeof desc.value === 'object') {
            if (hasOwnSensitiveKeys(desc.value as object, skipSet, seen)) {
                return true;
            }
        }
    }
    return false;
}

function redactExtraDescriptors(
    source: object,
    target: object,
    clones: WeakMap<object, unknown>,
    skipSet: Set<string>,
    skipNumericAndLength: boolean,
): void {
    const descriptors = Object.getOwnPropertyDescriptors(source);
    for (const [key, desc] of Object.entries(descriptors)) {
        if (skipNumericAndLength && (/^\d+$/.test(key) || key === 'length')) {
            continue;
        }
        if (skipSet.has(key.toLowerCase())) {
            Object.defineProperty(target, key, {
                value: '[REDACTED]',
                writable: true,
                enumerable: desc.enumerable ?? true,
                configurable: true,
            });
        } else if ('value' in desc) {
            Object.defineProperty(target, key, {
                value: sanitizeForToJSON(desc.value, clones, skipSet),
                writable: desc.writable ?? true,
                enumerable: desc.enumerable ?? true,
                configurable: true,
            });
        } else if (desc.get) {
            defineSanitizedGetter(target, key, desc, skipSet, true);
        }
    }
}

function sanitizeForToJSON(
    val: unknown,
    clones: WeakMap<object, unknown>,
    skipSet: Set<string>,
): unknown {
    if (val === null || val === undefined || typeof val !== 'object') {
        return val;
    }

    if (clones.has(val)) {
        return clones.get(val);
    }

    if (val instanceof Date) {
        return hasOwnSensitiveKeys(val, skipSet) ? '[REDACTED]' : new Date(val.getTime());
    }

    if (val instanceof RegExp) {
        return hasOwnSensitiveKeys(val, skipSet) ? '[REDACTED]' : new RegExp(val.source, val.flags);
    }

    if (typeof URL !== 'undefined' && val instanceof URL) {
        return hasOwnSensitiveKeys(val, skipSet) ? '[REDACTED]' : new URL(val.href);
    }

    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(val)) {
        return hasOwnSensitiveKeys(val, skipSet, new Set(), true) ? '[REDACTED]' : val;
    }

    if (ArrayBuffer.isView(val)) {
        return hasOwnSensitiveKeys(val, skipSet, new Set(), true) ? '[REDACTED]' : val;
    }

    if (val instanceof Map) {
        const cloned = new Map<unknown, unknown>();
        clones.set(val, cloned);
        for (const [k, v] of val.entries()) {
            cloned.set(sanitizeForToJSON(k, clones, skipSet), sanitizeForToJSON(v, clones, skipSet));
        }
        redactExtraDescriptors(val, cloned, clones, skipSet, false);
        return cloned;
    }

    if (val instanceof Set) {
        const cloned = new Set<unknown>();
        clones.set(val, cloned);
        for (const item of val.values()) {
            cloned.add(sanitizeForToJSON(item, clones, skipSet));
        }
        redactExtraDescriptors(val, cloned, clones, skipSet, false);
        return cloned;
    }

    const proto: unknown = Object.getPrototypeOf(val);
    const isArr = Array.isArray(val);
    const sanitized = (isArr ? [] : Object.create(proto as object | null)) as object;
    clones.set(val, sanitized);

    if (isArr) {
        const arr = val as unknown[];
        const targetArr = sanitized as unknown[];
        targetArr.length = arr.length;
        for (let i = 0; i < arr.length; i++) {
            if (i in arr) {
                targetArr[i] = sanitizeForToJSON(arr[i], clones, skipSet);
            }
        }
    }

    redactExtraDescriptors(val, sanitized, clones, skipSet, isArr);

    let curr = proto as object | null;
    while (curr && curr !== Object.prototype && curr !== Array.prototype) {
        const protoDescs = Object.getOwnPropertyDescriptors(curr);
        for (const [prop, desc] of Object.entries(protoDescs)) {
            if (prop === 'constructor' || Object.prototype.hasOwnProperty.call(sanitized, prop)) {
                continue;
            }
            if (skipSet.has(prop.toLowerCase())) {
                Object.defineProperty(sanitized, prop, {
                    value: '[REDACTED]',
                    writable: true,
                    enumerable: true,
                    configurable: true,
                });
            } else if (desc.get && prop !== 'toJSON') {
                defineSanitizedGetter(sanitized, prop, desc, skipSet, false);
            }
        }
        curr = Object.getPrototypeOf(curr) as object | null;
    }

    return sanitized;
}

function transform(
    val: unknown,
    ancestors: Set<object>,
    skipSet: Set<string> | null,
    hasSkip: boolean
): unknown {
    if (val === null || val === undefined) return val;
    if (typeof val === 'bigint') return `${val.toString()}n`;
    if (typeof val !== 'object') return val;

    if (ancestors.has(val)) {
        return '[Circular]';
    }

    if (val instanceof Date) {
        return isNaN(val.getTime()) ? null : val.toISOString();
    }

    ancestors.add(val);
    try {
        if (hasToJsonMethod(val)) {
            if (skipSet) {
                const sanitized = sanitizeForToJSON(val, new WeakMap(), skipSet);
                if (!sanitized || typeof sanitized !== 'object') {
                    return transform(sanitized, ancestors, skipSet, hasSkip);
                }
                if (!hasToJsonMethod(sanitized)) {
                    if (hasSkip) throw new Error('Sanitization failed');
                    return '[REDACTED]';
                }
                const res = sanitized.toJSON();
                if (res === sanitized || res === val) {
                    return '[Circular]';
                }
                ancestors.add(sanitized);
                try {
                    return transform(res, ancestors, skipSet, hasSkip);
                } finally {
                    ancestors.delete(sanitized);
                }
            } else {
                const res = val.toJSON();
                if (res === val) {
                    return '[Circular]';
                }
                return transform(res, ancestors, skipSet, hasSkip);
            }
        }

        if (Array.isArray(val)) {
            const arr: unknown[] = [];
            for (let i = 0; i < val.length; i++) {
                try {
                    arr.push(transform(val[i], ancestors, skipSet, hasSkip));
                } catch (err) {
                    if (hasSkip) throw err;
                    arr.push('[Unserializable]');
                }
            }
            return arr;
        }

        const obj: Record<string, unknown> = {};
        for (const key of Object.keys(val)) {
            if (skipSet && skipSet.has(key.toLowerCase())) {
                obj[key] = '[REDACTED]';
            } else {
                try {
                    obj[key] = transform((val as Record<string, unknown>)[key], ancestors, skipSet, hasSkip);
                } catch (err) {
                    if (hasSkip) throw err;
                    obj[key] = '[Unserializable]';
                }
            }
        }
        return obj;
    } finally {
        ancestors.delete(val);
    }
}

export function safeStringify(
    value: unknown,
    skipArgs?: readonly (string | number)[],
    maxLength = 1000
): string {
    const hasSkip = Boolean(skipArgs && skipArgs.length > 0);
    const skipSet = skipArgs && skipArgs.length > 0
        ? new Set(skipArgs.map((s) => String(s).toLowerCase().trim()))
        : null;

    try {
        const transformed = transform(value, new Set(), skipSet, hasSkip);
        const str = JSON.stringify(transformed);
        return (str ?? (hasSkip ? '[REDACTED]' : '[Unserializable]')).slice(0, maxLength);
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
    const skipSet = skipArgs && skipArgs.length > 0
        ? new Set(skipArgs.map((s) => String(s).toLowerCase().trim()))
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
