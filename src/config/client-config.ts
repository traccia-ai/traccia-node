/**
 * Effective client configuration shared by tracing, policy, prompts and evals.
 */

import { loadConfig } from './config';

/** API key and traces endpoint resolved once by init(); what the trace exporter uses. */
export interface ClientConfig {
  readonly apiKey?: string;
  readonly endpoint?: string;
}

let clientConfig: ClientConfig | undefined;

export function setClientConfig(apiKey?: string, endpoint?: string): void {
  clientConfig = Object.freeze({ apiKey: apiKey || undefined, endpoint: endpoint || undefined });
}

export function getClientConfig(): ClientConfig | undefined {
  return clientConfig;
}

export function clearClientConfig(): void {
  clientConfig = undefined;
}

/**
 * Priority per field: explicit argument > init() config > env/config file (when init() did not set it).
 */
export function resolveClientCredentials(opts?: { apiKey?: string; endpoint?: string }): ClientConfig {
  let apiKey = opts?.apiKey || clientConfig?.apiKey;
  let endpoint = opts?.endpoint || clientConfig?.endpoint;
  if (!apiKey || !endpoint) {
    const cfg = loadConfig();
    apiKey = apiKey || cfg.tracing.api_key || process.env.TRACCIA_API_KEY;
    endpoint = endpoint || cfg.tracing.endpoint || process.env.TRACCIA_ENDPOINT;
  }
  return { apiKey, endpoint };
}
