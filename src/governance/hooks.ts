/**
 * Governance hooks framework.
 */

import { ISpan } from '../types';

export interface GovernanceHook {
  onBeforeExecute?(span: ISpan, schema?: any): void | Promise<void>;
  onAfterExecute?(span: ISpan, schema?: any, result?: any): void | Promise<void>;
  onPolicyViolation?(span: ISpan, error: Error): void | Promise<void>;
}

/**
 * Registry for governance hooks.
 */
export class GovernanceManager {
  private hooks: GovernanceHook[] = [];

  public registerHooks(hook: GovernanceHook): void {
    this.hooks.push(hook);
  }

  public getHooks(): GovernanceHook[] {
    return this.hooks;
  }

  public triggerBeforeExecute(span: ISpan, schema?: any): void {
    for (const hook of this.hooks) {
      if (hook.onBeforeExecute) {
        try {
          void hook.onBeforeExecute(span, schema);
        } catch (e) {
          // Swallow exceptions
        }
      }
    }
  }

  public triggerAfterExecute(span: ISpan, schema?: any, result?: any): void {
    for (const hook of this.hooks) {
      if (hook.onAfterExecute) {
        try {
          void hook.onAfterExecute(span, schema, result);
        } catch (e) {
          // Swallow exceptions
        }
      }
    }
  }

  public triggerPolicyViolation(span: ISpan, error: Error): void {
    for (const hook of this.hooks) {
      if (hook.onPolicyViolation) {
        try {
          void hook.onPolicyViolation(span, error);
        } catch (e) {
          // Swallow exceptions
        }
      }
    }
  }
}

export const governanceHooks = new GovernanceManager();
