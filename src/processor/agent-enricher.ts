/**
 * Span processor that enriches spans with agent metadata and cost.
 */

import * as fs from 'fs';
import { ISpanProcessor, ISpan } from '../types';
import { computeCost } from './cost-processor';

export interface AgentEnrichmentOptions {
    /** Path to agent config JSON file */
    agentConfigPath?: string;
    /** Default agent ID if not found in span attributes */
    defaultAgentId?: string;
    /** Default environment (default: "production") */
    defaultEnv?: string;
    /** Service role */
    serviceRole?: string;
}

interface AgentMetadata {
    id?: string;
    name?: string;
    type?: string;
    description?: string;
    owner?: string;
    team?: string;
    org_id?: string;
    sub_org_id?: string;
    env?: string;
    consuming_teams?: string[];
}

type AgentCatalog = Record<string, AgentMetadata>;

/**
 * Load agent metadata from a JSON file.
 *
 * Supports formats:
 * - { "agents": [ { "id": "...", "name": "...", ... } ] }
 * - { "agent-id": { "name": "...", ... }, ... }
 */
function loadAgentCatalog(filePath?: string): AgentCatalog {
    if (!filePath) {
        return {};
    }

    try {
        if (!fs.existsSync(filePath)) {
            return {};
        }

        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;

        // Format 1: { "agents": [ ... ] }
        if (data && typeof data === 'object' && 'agents' in data && Array.isArray((data as Record<string, unknown>).agents)) {
            const catalog: AgentCatalog = {};
            for (const agent of (data as { agents: unknown[] }).agents) {
                if (agent && typeof agent === 'object' && 'id' in agent) {
                    catalog[String((agent as { id: unknown }).id)] = agent as AgentMetadata;
                }
            }
            return catalog;
        }

        // Format 2: { "agent-id": { ... }, ... }
        if (data && typeof data === 'object') {
            const catalog: AgentCatalog = {};
            for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
                if (value && typeof value === 'object') {
                    catalog[String(key)] = value as AgentMetadata;
                }
            }
            return catalog;
        }

        return {};
    } catch {
        return {};
    }
}

/**
 * Get environment variable value.
 */
function getEnv(key: string): string | undefined {
    // Use globalThis for cross-environment compatibility
    const proc = globalThis.process as { env?: Record<string, string> } | undefined;
    return proc?.env?.[key];
}

/**
 * Enrich spans with agent metadata (id/name/env/owner/team/org) and compute llm.cost.usd if missing.
 *
 * Static metadata can come from:
 * - span attributes (preferred)
 * - environment variables (AGENT_DASHBOARD_AGENT_ID/NAME/ENV/OWNER/TEAM/ORG_ID/SUB_ORG_ID/DESCRIPTION)
 * - JSON config file pointed by AGENT_DASHBOARD_AGENT_CONFIG
 */
export class AgentEnrichmentProcessor implements ISpanProcessor {
    private defaultAgentId?: string;
    private defaultEnv: string;
    private defaultName?: string;
    private defaultType?: string;
    private defaultOwner?: string;
    private defaultTeam?: string;
    private defaultOrg?: string;
    private defaultSubOrg?: string;
    private defaultDescription?: string;
    private catalog: AgentCatalog;
    private singleAgentId?: string;
    private serviceRole?: string;

    constructor(options: AgentEnrichmentOptions = {}) {
        this.defaultAgentId = options.defaultAgentId || getEnv('AGENT_DASHBOARD_AGENT_ID');
        this.defaultEnv = getEnv('AGENT_DASHBOARD_ENV') || options.defaultEnv || 'production';
        this.defaultName = getEnv('AGENT_DASHBOARD_AGENT_NAME');
        this.defaultType = getEnv('AGENT_DASHBOARD_AGENT_TYPE');
        this.defaultOwner = getEnv('AGENT_DASHBOARD_AGENT_OWNER');
        this.defaultTeam = getEnv('AGENT_DASHBOARD_AGENT_TEAM');
        this.defaultOrg = getEnv('AGENT_DASHBOARD_ORG_ID');
        this.defaultSubOrg = getEnv('AGENT_DASHBOARD_SUB_ORG_ID');
        this.defaultDescription = getEnv('AGENT_DASHBOARD_AGENT_DESCRIPTION');

        const cfgPath =
            options.agentConfigPath || getEnv('AGENT_DASHBOARD_AGENT_CONFIG') || 'agent_config.json';

        this.catalog = loadAgentCatalog(cfgPath);

        // If only one agent is declared, remember it for convenient fallback
        const catalogKeys = Object.keys(this.catalog);
        if (catalogKeys.length === 1) {
            this.singleAgentId = catalogKeys[0];
        }
        this.serviceRole = options.serviceRole;
    }

    /**
     * Called when span starts - no-op for enrichment.
     */
    onStart(_span: ISpan): void {
        // No action needed on start
    }

    /**
     * Called when span ends - enrich with agent metadata.
     */
    onEnd(span: ISpan): void {
        if (this.serviceRole === 'orchestrator') {
            return;
        }

        const attrs = span.attributes || {};

        // Resolve agent id
        let agentId =
            (attrs['agent.id'] as string) ||
            (attrs['agent'] as string) ||
            this.defaultAgentId;

        // If not found in attributes/env, and only one agent exists in catalog, use it
        if (!agentId && this.singleAgentId) {
            agentId = this.singleAgentId;
        }

        // If still missing, skip enrichment
        if (!agentId) {
            return;
        }

        // Look up static metadata
        let meta = this.catalog[agentId] || {};

        // If the resolved id is not in catalog but we have a single agent defined, use that entry
        if (Object.keys(meta).length === 0 && this.singleAgentId) {
            agentId = this.singleAgentId;
            meta = this.catalog[agentId] || {};
        }

        const setIfMissing = (key: string, value: unknown): void => {
            if (value === null || value === undefined) return;
            if (!(key in attrs) || attrs[key] === null || attrs[key] === '') {
                span.setAttribute(key, value);
            }
        };

        // Set agent attributes
        span.setAttribute('agent.id', agentId);
        setIfMissing('agent.name', meta.name || this.defaultName || agentId);
        setIfMissing('agent.type', meta.type || this.defaultType || 'workflow');
        setIfMissing('agent.description', meta.description || this.defaultDescription || '');
        setIfMissing('owner', meta.owner || this.defaultOwner);
        setIfMissing('team', meta.team || this.defaultTeam);
        setIfMissing('org.id', meta.org_id || this.defaultOrg);
        setIfMissing('sub_org.id', meta.sub_org_id || this.defaultSubOrg);

        // Environment
        setIfMissing('env', meta.env || this.defaultEnv);
        setIfMissing('environment', meta.env || this.defaultEnv);

        // Consumers (store as list)
        if (meta.consuming_teams && !attrs['agent.consuming_teams']) {
            span.setAttribute('agent.consuming_teams', meta.consuming_teams);
        }

        // Cost: fill llm.cost.usd if we have tokens + model
        if (!attrs['llm.cost.usd']) {
            const model = attrs['llm.model'] as string | undefined;
            const promptTokens = (attrs['llm.usage.prompt_tokens'] as number) || 0;
            const completionTokens = (attrs['llm.usage.completion_tokens'] as number) || 0;

            if (model && (promptTokens || completionTokens)) {
                try {
                    const cost = computeCost(model, promptTokens, completionTokens);
                    if (cost !== undefined && cost !== null) {
                        span.setAttribute('llm.cost.usd', cost);
                    }
                } catch {
                    // Silently ignore cost computation errors
                }
            }
        }

        // Span type inference if missing
        if (!attrs['span.type'] && !attrs['type']) {
            let spanType: string | undefined;

            if (attrs['llm.model']) {
                spanType = 'LLM';
            } else if (attrs['tool.name'] || attrs['tool'] || attrs['http.url']) {
                spanType = 'TOOL';
            }

            if (spanType) {
                span.setAttribute('span.type', spanType);
            }
        }
    }

    /**
     * Shutdown processor.
     */
    async shutdown(): Promise<void> {
        // No cleanup needed
    }

    /**
     * Force flush - no-op for synchronous processor.
     */
    async forceFlush(_timeoutMs?: number): Promise<void> {
        // No-op
    }
}
