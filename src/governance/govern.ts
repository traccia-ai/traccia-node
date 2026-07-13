/**
 * Runtime policy enforcement combined with observability.
 */

import { observe, ObserveOptions } from '../instrumentation/decorator';
import { runIdentity } from '../config/runtime-config';
import { checkAgentStatus } from './policy';

export interface GovernOptions extends ObserveOptions {
  agentId?: string;
  failOpen?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

function createGovernWrapper(
  fn: AnyFn,
  options: GovernOptions,
  defaultName: string,
): AnyFn {
  const { agentId, failOpen = true, ...observeOptions } = options;
  const observedFn = observe(observeOptions)(fn) as AnyFn;
  const agentName = observeOptions.attributes?.['agent.name'] as string | undefined;

  const enforceAndRun = async (thisArg: unknown, args: unknown[]) => {
    const resolvedId = agentId || process.env.TRACCIA_AGENT_ID;
    if (resolvedId) {
      await checkAgentStatus(resolvedId, { failOpen });
    } else {
      console.warn(
        '[traccia.governance] No agentId provided to govern() and TRACCIA_AGENT_ID is not set. Skipping policy check.',
      );
    }

    return runIdentity({ agentId, agentName }, () => observedFn.apply(thisArg, args));
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function (this: any, ...args: any[]) {
    return enforceAndRun(this, args);
  };
}

/**
 * Observability plus runtime policy enforcement.
 *
 * Unlike observe(), govern() calls the Traccia platform agent-status API before each
 * invocation. Requires a Traccia account (API key + endpoint). For tracing-only
 * setups, use observe() instead.
 */
export function govern(options: GovernOptions = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function (target: any, propertyKey?: string, descriptor?: PropertyDescriptor): any {
    if (descriptor && typeof descriptor.value === 'function') {
      const originalMethod = descriptor.value;
      descriptor.value = createGovernWrapper(
        originalMethod,
        options,
        propertyKey || options.name || 'method',
      );
      return descriptor;
    }

    if (typeof target === 'function' && !propertyKey && !descriptor) {
      return createGovernWrapper(target, options, options.name || target.name || 'function');
    }

    return target;
  };
}
