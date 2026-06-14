/**
 * Canonical agent identity model for Traccia SDK.
 */

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
}

export class AgentIdentity implements IAgentIdentity {
  public id?: string;
  public name?: string;
  public type: AgentType;
  public env?: string;
  public project?: string;

  constructor(options: IAgentIdentity = {}) {
    this.id = options.id;
    this.name = options.name;
    this.type = options.type || 'workflow';
    this.env = options.env;
    this.project = options.project;
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
    return attrs;
  }
}
