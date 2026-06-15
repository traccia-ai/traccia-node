/**
 * Canonical agent identity model for Traccia SDK.
 */

import { z } from 'zod';
import { ValidationError } from './errors';

export type AgentType = 'workflow' | 'service' | 'tool';

export interface IAgentIdentity {
  /** Stable agent identifier (agent.id) */
  id?: string;
  /** Display name (agent.name) */
  name?: string;
  /** Agent type for categorization */
  type?: AgentType;
  /** Deployment environment (e.g. production, staging) */
  env?: string;
  /** Project or namespace */
  project?: string;
  /** Service role (e.g. agent or orchestrator) */
  serviceRole?: 'agent' | 'orchestrator';
}

const AgentIdentitySchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  type: z.enum(['workflow', 'service', 'tool']).optional(),
  env: z.string().optional(),
  project: z.string().optional(),
  serviceRole: z.enum(['agent', 'orchestrator']).optional(),
});

export class AgentIdentity implements IAgentIdentity {
  public id?: string;
  public name?: string;
  public type: AgentType;
  public env?: string;
  public project?: string;
  public serviceRole?: 'agent' | 'orchestrator';

  constructor(options: IAgentIdentity = {}) {
    const result = AgentIdentitySchema.safeParse(options);
    if (!result.success) {
      throw new ValidationError(`Invalid AgentIdentity configuration: ${result.error.message}`, { issues: result.error.issues });
    }

    const validOptions = result.data;
    this.id = validOptions.id;
    this.name = validOptions.name;
    this.type = validOptions.type || 'workflow';
    this.env = validOptions.env;
    this.project = validOptions.project;
    this.serviceRole = validOptions.serviceRole;
  }

  /**
   * Return a dictionary of resource attributes for OTLP export.
   */
  public toResourceAttributes(): Record<string, string> {
    const attrs: Record<string, string> = {};
    if (this.id) {
      attrs['agent.id'] = this.id;
    }
    if (this.name) {
      attrs['agent.name'] = this.name;
    }
    if (this.env) {
      attrs['environment'] = this.env;
      attrs['env'] = this.env;
    }
    if (this.project) {
      attrs['project.id'] = this.project;
    }
    if (this.serviceRole) {
      attrs['traccia.service_role'] = this.serviceRole;
    }
    return attrs;
  }
}
