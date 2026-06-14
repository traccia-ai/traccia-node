/**
 * Governance lifecycle hooks.
 */

import { ISpan } from '../types';

export interface GovernanceHooks {
  /**
   * Called before execution.
   */
  onBeforeExecute?: (span: ISpan, schema: Record<string, unknown>) => void;

  /**
   * Called after execution.
   */
  onAfterExecute?: (span: ISpan, schema: Record<string, unknown>, result: unknown) => void;

  /**
   * Called when a policy violation occurs.
   */
  onPolicyViolation?: (span: ISpan, violation: Error) => void;
}

export class GovernanceManager {
  private hooks: GovernanceHooks[];

  constructor() {
    this.hooks = [];
  }

  public registerHooks(hooks: GovernanceHooks): void {
    this.hooks.push(hooks);
  }

  public triggerBeforeExecute(span: ISpan, schema: Record<string, unknown>): void {
    for (const hook of this.hooks) {
      if (hook.onBeforeExecute) {
        try {
          hook.onBeforeExecute(span, schema);
        } catch (e) {
          console.error('Error in onBeforeExecute hook', e);
        }
      }
    }
  }

  public triggerAfterExecute(span: ISpan, schema: Record<string, unknown>, result: unknown): void {
    for (const hook of this.hooks) {
      if (hook.onAfterExecute) {
        try {
          hook.onAfterExecute(span, schema, result);
        } catch (e) {
          console.error('Error in onAfterExecute hook', e);
        }
      }
    }
  }

  public triggerPolicyViolation(span: ISpan, violation: Error): void {
    for (const hook of this.hooks) {
      if (hook.onPolicyViolation) {
        try {
          hook.onPolicyViolation(span, violation);
        } catch (e) {
          console.error('Error in onPolicyViolation hook', e);
        }
      }
    }
  }
}

// Global governance manager
export const globalGovernanceManager = new GovernanceManager();
