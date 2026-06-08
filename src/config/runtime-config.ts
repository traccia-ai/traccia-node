/**
 * Runtime configuration management.
 */

interface RuntimeConfig {
  autoInstrumentTools: boolean;
  toolInclude: string[];
  maxToolSpans: number;
  maxSpanDepth: number;
  sessionId?: string;
  userId?: string;
  tenantId?: string;
  projectId?: string;
  debug: boolean;
  attrTruncationLimit?: number;
}

let config: RuntimeConfig = {
  autoInstrumentTools: false,
  toolInclude: [],
  maxToolSpans: 100,
  maxSpanDepth: 10,
  debug: false,
};

/**
 * Get the current runtime configuration.
 */
export function getConfig(): RuntimeConfig {
  return config;
}

/**
 * Update the runtime configuration.
 */
export function updateConfig(partial: Partial<RuntimeConfig>): void {
  config = { ...config, ...partial };
}

/**
 * Set auto-instrument tools flag.
 */
export function setAutoInstrumentTools(value: boolean): void {
  config.autoInstrumentTools = value;
}

/**
 * Set tool include list.
 */
export function setToolInclude(tools: string[]): void {
  config.toolInclude = tools;
}

/**
 * Set max tool spans.
 */
export function setMaxToolSpans(max: number): void {
  config.maxToolSpans = max;
}

/**
 * Set max span depth.
 */
export function setMaxSpanDepth(max: number): void {
  config.maxSpanDepth = max;
}

/**
 * Set session ID.
 */
export function setSessionId(id?: string): void {
  config.sessionId = id;
}

/**
 * Set user ID.
 */
export function setUserId(id?: string): void {
  config.userId = id;
}

/**
 * Set tenant ID.
 */
export function setTenantId(id?: string): void {
  config.tenantId = id;
}

/**
 * Set project ID.
 */
export function setProjectId(id?: string): void {
  config.projectId = id;
}

/**
 * Set debug flag.
 */
export function setDebug(value: boolean): void {
  config.debug = value;
}

/**
 * Set attribute truncation limit.
 */
export function setAttrTruncationLimit(limit?: number): void {
  config.attrTruncationLimit = limit;
}
