/**
 * Environment configuration loading.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Load .env file into process.env.
 */
export function loadEnvFile(envPath: string = '.env'): void {
  if (!fs.existsSync(envPath)) {
    return;
  }

  try {
    const content = fs.readFileSync(envPath, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) {
        continue;
      }

      const key = trimmed.substring(0, eqIndex).trim();
      const value = trimmed.substring(eqIndex + 1).trim().replace(/^["']|["']$/g, '');

      if (key && !(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // Silently fail; best-effort loading
  }
}

/**
 * Load configuration from environment variables.
 */
export interface EnvConfig {
  apiKey?: string;
  endpoint?: string;
  sampleRate?: number;
  useOtlp?: boolean;
}

export function loadEnvConfig(overrides?: Record<string, string>): EnvConfig {
  const envConfig: EnvConfig = {
    apiKey: process.env.AGENT_DASHBOARD_API_KEY,
    endpoint: process.env.AGENT_DASHBOARD_ENDPOINT,
    sampleRate: process.env.AGENT_DASHBOARD_SAMPLE_RATE
      ? parseFloat(process.env.AGENT_DASHBOARD_SAMPLE_RATE)
      : undefined,
  };

  if (overrides) {
    if (overrides.apiKey !== undefined) {
      envConfig.apiKey = overrides.apiKey;
    }
    if (overrides.endpoint !== undefined) {
      envConfig.endpoint = overrides.endpoint;
    }
    if (overrides.sampleRate !== undefined) {
      envConfig.sampleRate = parseFloat(overrides.sampleRate);
    }
    if (overrides.useOtlp !== undefined) {
      envConfig.useOtlp = overrides.useOtlp === 'true';
    }
  }

  return envConfig;
}

/**
 * Find agent config file automatically.
 */
export function findAgentConfigPath(): string | undefined {
  const candidates = [
    './agent_config.json',
    './agent-config.json',
    './.config/agent_config.json',
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return path.resolve(candidate);
    }
  }

  return undefined;
}
