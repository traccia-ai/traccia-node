/**
 * Runtime policy enforcement combined with observability.
 */

import { observe, ObserveOptions } from '../instrumentation/decorator';
import { getAgentId, runIdentity } from '../config/runtime-config';
import { governedRun } from './evidence';
import type { PolicyFailMode } from './fail-mode';
import { checkAgentStatus, GovernanceConfigError, localFailMode } from './policy';

export interface GovernOptions extends ObserveOptions {
  agentId?: string;
  /**
   * Overrides your Traccia setting for this run and the checks inside it, only when
   * Traccia gives no answer: 'open' allows, 'closed' blocks.
   */
  policyFailMode?: PolicyFailMode;
  /** @deprecated Omit to follow your Traccia setting, or use policyFailMode (true = 'open', false = 'closed'). */
  failOpen?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

function resolveGovernAgentId(explicit?: string): string | undefined {
  const override = explicit?.trim();
  if (override) return override;
  const fromInit = getAgentId()?.trim();
  if (fromInit) return fromInit;
  const fromEnv = process.env.TRACCIA_AGENT_ID?.trim();
  return fromEnv || undefined;
}

function createGovernWrapper(
  fn: AnyFn,
  options: GovernOptions,
  defaultName: string,
): AnyFn {
  const { agentId, failOpen, policyFailMode, ...observeOptions } = options;
  const local = localFailMode(failOpen, policyFailMode, 'govern');
  const observedFn = observe(observeOptions)(fn) as AnyFn;
  const agentName = observeOptions.attributes?.['agent.name'] as string | undefined;

  const enforceAndRun = async (thisArg: unknown, args: unknown[]) => {
    const resolvedId = resolveGovernAgentId(agentId);
    if (!resolvedId) {
      throw new GovernanceConfigError(
        'No agentId on init, govern(), or TRACCIA_AGENT_ID. govern() needs one to check policies; ' +
          'use observe() for tracing only.',
      );
    }
    await checkAgentStatus(resolvedId, { policyFailMode: local });

    const identity: { pepEnabled: true; pepFailMode?: PolicyFailMode; agentId?: string; agentName?: string } = {
      pepEnabled: true,
      pepFailMode: local,
    };
    if (agentId?.trim()) identity.agentId = agentId.trim();
    if (agentName) identity.agentName = agentName;
    return runIdentity(identity, () => governedRun(() => Promise.resolve(observedFn.apply(thisArg, args))));
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function (this: any, ...args: any[]) {
    return enforceAndRun(this, args);
  };
}

/**
 * Observability plus runtime policy enforcement.
 *
 * Unlike observe(), govern():
 * 1. Polls agent status (lagged next-run breaker) before the function body.
 * 2. Turns on per-call policy checks for instrumented LLM clients and
 *    observe({ asType: 'tool' }) functions (Spend Cap, Model Boundary, Loop Cap).
 *
 * Identity comes from init({ agentId }) or TRACCIA_AGENT_ID. Pass agentId here
 * only to override for one function in a multi-agent process.
 *
 * Deny throws AgentBlockedError. Reshape may swap the model on the in-flight
 * request. Observe/Warn in the dashboard still let the call proceed.
 *
 * When Traccia gives no answer (HTTP error, timeout), the policy fail mode applies:
 * your Traccia setting (Settings -> Policy Enforcement), else block. policyFailMode
 * 'open' or 'closed' overrides it for this run and the checks inside it, and only
 * then: a rejected API key, a block, a deny or a missing API key, endpoint or agent
 * ID always stops the call. failOpen is deprecated (true = 'open', false = 'closed').
 *
 * Requires a Traccia account (API key + endpoint). Tracing-only setups should
 * use observe() instead.
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
