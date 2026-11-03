/**
 * Runtime configuration management.
 */

import { AsyncLocalStorage } from 'async_hooks';

interface RunIdentity {
  agentId?: string;
  agentName?: string;
  pepEnabled?: boolean;
  /** The govern() run's local fail mode override, or undefined: use init's, else the customer's setting (TRC-342). */
  pepFailMode?: 'open' | 'closed';
}

interface RuntimeConfig {
  autoInstrumentTools: boolean;
  toolInclude: string[];
  maxToolSpans: number;
  maxSpanDepth: number;
  sessionId?: string;
  userId?: string;
  tenantId?: string;
  projectId?: string;
  agentId?: string;
  agentName?: string;
  env?: string;
  debug: boolean;
  attrTruncationLimit?: number;
}

const RUNTIME_CONFIG_KEY = Symbol.for('traccia.runtimeConfig');

interface SharedRuntimeConfig {
  config: RuntimeConfig;
  runIdentityStorage: AsyncLocalStorage<RunIdentity>;
}

/** One process shares the config and run identity across the separately bundled entry points. */
function sharedRuntimeConfig(): SharedRuntimeConfig {
  const host = globalThis as typeof globalThis & { [RUNTIME_CONFIG_KEY]?: SharedRuntimeConfig };
  if (!host[RUNTIME_CONFIG_KEY]) {
    host[RUNTIME_CONFIG_KEY] = {
      config: {
        autoInstrumentTools: false,
        toolInclude: [],
        maxToolSpans: 100,
        maxSpanDepth: 10,
        debug: false,
      },
      runIdentityStorage: new AsyncLocalStorage<RunIdentity>(),
    };
  }
  return host[RUNTIME_CONFIG_KEY];
}

const shared = sharedRuntimeConfig();
const runIdentityStorage = shared.runIdentityStorage;

/**
 * Get the current runtime configuration.
 */
export function getConfig(): RuntimeConfig {
  return shared.config;
}

/**
 * Update the runtime configuration.
 */
export function updateConfig(partial: Partial<RuntimeConfig>): void {
  shared.config = { ...shared.config, ...partial };
}

/**
 * Set auto-instrument tools flag.
 */
export function setAutoInstrumentTools(value: boolean): void {
  shared.config.autoInstrumentTools = value;
}

/**
 * Set tool include list.
 */
export function setToolInclude(tools: string[]): void {
  shared.config.toolInclude = tools;
}

/**
 * Set max tool spans.
 */
export function setMaxToolSpans(max: number): void {
  shared.config.maxToolSpans = max;
}

/**
 * Set max span depth.
 */
export function setMaxSpanDepth(max: number): void {
  shared.config.maxSpanDepth = max;
}

/**
 * Set session ID.
 */
export function setSessionId(id?: string): void {
  shared.config.sessionId = id;
}

/**
 * Set user ID.
 */
export function setUserId(id?: string): void {
  shared.config.userId = id;
}

/**
 * Set tenant ID.
 */
export function setTenantId(id?: string): void {
  shared.config.tenantId = id;
}

/**
 * Set project ID.
 */
export function setProjectId(id?: string): void {
  shared.config.projectId = id;
}

export function getAgentId(): string | undefined {
  return runIdentityStorage.getStore()?.agentId ?? shared.config.agentId;
}

export function setAgentId(id?: string): void {
  shared.config.agentId = id;
}

export function setAgentName(name?: string): void {
  shared.config.agentName = name;
}

export function getAgentName(): string | undefined {
  return runIdentityStorage.getStore()?.agentName ?? shared.config.agentName;
}

export function setEnv(value?: string): void {
  shared.config.env = value;
}

export function getEnv(): string | undefined {
  return shared.config.env;
}

/**
 * Set debug flag.
 */
export function setDebug(value: boolean): void {
  shared.config.debug = value;
}

/**
 * Set attribute truncation limit.
 */
export function setAttrTruncationLimit(limit?: number): void {
  shared.config.attrTruncationLimit = limit;
}

/**
 * Run-scoped agent identity for parallel runs in one process (matches Python run_identity).
 */
export function pepEnabled(): boolean {
  return Boolean(runIdentityStorage.getStore()?.pepEnabled);
}

/** The current govern() run's local fail mode override, or undefined. Per run: concurrent runs never share it. */
export function pepFailMode(): 'open' | 'closed' | undefined {
  return runIdentityStorage.getStore()?.pepFailMode;
}

export function runIdentity<T>(
  identity: { agentId?: string; agentName?: string; pepEnabled?: boolean; pepFailMode?: 'open' | 'closed' },
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const parent = runIdentityStorage.getStore() || {};
  const next: RunIdentity = { ...parent };
  if (identity.agentId !== undefined) next.agentId = identity.agentId;
  if (identity.agentName !== undefined) next.agentName = identity.agentName;
  if (identity.pepEnabled !== undefined) next.pepEnabled = identity.pepEnabled;
  if (identity.pepFailMode !== undefined) next.pepFailMode = identity.pepFailMode;
  return runIdentityStorage.run(next, fn);
}
