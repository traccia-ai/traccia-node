
import { getTracer } from '../auto';
import { SpanStatus } from '../types';
import { ATTR_GUARDRAIL_TRIGGERED, ATTR_GUARDRAIL_NAME, ATTR_GUARDRAIL_CATEGORY } from '../guardrails/constants';

export interface ObserveOptions {
    name?: string;
    attributes?: Record<string, unknown>;
    type?: 'span' | 'tool' | 'llm' | 'guardrail';
    skipArgs?: string[];
    skipResult?: boolean;
    tags?: string[];
    guardrailName?: string;
    guardrailCategory?: string;
}

/**
 * Decorator/Wrapper to create spans around functions.
 *
 * Usage:
 * 1. As Method Decorator:
 *    class MyClass {
 *      @observe({ name: 'my-method' })
 *      method() { ... }
 *    }
 *
 * 2. As Function Wrapper:
 *    const protectedFunc = observe({ name: 'my-func' })(originalFunc);
 */
export function observe(options: ObserveOptions = {}) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return function (
        target: any,
        propertyKey?: string,
        descriptor?: PropertyDescriptor
    ): any {
        // Case 1: Method Decorator
        if (descriptor && typeof descriptor.value === 'function') {
            const originalMethod = descriptor.value;
            descriptor.value = createWrapper(
                originalMethod,
                options,
                propertyKey || options.name || 'method'
            );
            return descriptor;
        }

        // Case 2: Function Wrapper (target is the function itself)
        if (typeof target === 'function' && !propertyKey && !descriptor) {
            return createWrapper(target, options, options.name || target.name || 'function');
        }

        // Fallback/Error
        return target;
    };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createWrapper(fn: any, options: ObserveOptions, defaultName: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return function (this: any, ...args: any[]) {
        const tracer = getTracer('default');
        const name = options.name || defaultName;

        const attributes: Record<string, unknown> = {
            ...(options.attributes || {}),
            'span.type': options.type || 'span',
        };

        if (options.tags && options.tags.length > 0) {
            attributes['span.tags'] = options.tags;
        }

        // Capture arguments
        if (options.skipArgs) {
            // Simple index-based capture or similar matching could be implemented here
            // For now, simpler than Python's introspection:
            attributes['function.args'] = JSON.stringify(args).slice(0, 1000);
        } else {
            attributes['function.args'] = JSON.stringify(args).slice(0, 1000);
        }

        // Auto-set guardrail attributes if type is guardrail
        if (options.type === 'guardrail') {
            if (options.guardrailName) {
                attributes[ATTR_GUARDRAIL_NAME] = options.guardrailName;
            }
            if (options.guardrailCategory) {
                attributes[ATTR_GUARDRAIL_CATEGORY] = options.guardrailCategory;
            }
        }

        return tracer.startActiveSpan(name, async (span) => {
            // Set initial attributes
            for (const [key, value] of Object.entries(attributes)) {
                span.setAttribute(key, value);
            }

            try {
                // Execute original function
                const result = await fn.apply(this, args);

                // Auto-set guardrail.triggered if type is guardrail and result is boolean
                if (options.type === 'guardrail' && typeof result === 'boolean') {
                    span.setAttribute(ATTR_GUARDRAIL_TRIGGERED, result);
                }

                // Capture result
                if (!options.skipResult) {
                    try {
                        const resStr = typeof result === 'string' ? result : JSON.stringify(result);
                        span.setAttribute('result', resStr.slice(0, 1000));
                    } catch {
                        span.setAttribute('result', String(result).slice(0, 1000));
                    }
                }

                return result;
            } catch (error) {
                if (error instanceof Error) {
                    span.recordException(error);
                    span.status = SpanStatus.ERROR;
                    if (error.message) {
                        span.statusDescription = error.message;
                    }
                }
                throw error;
            } finally {
                span.end();
            }
        });
    };
}
