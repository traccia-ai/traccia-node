/**
 * HTTP client for prompt-runtime fetch.
 */

import axios, { AxiosInstance } from 'axios';
import { loadConfig } from '../config/config';
import { DEFAULT_ENDPOINT } from '../exporter/http-exporter';

const DEFAULT_RUNTIME_PATH = '/api/v1/prompt-runtime/prompts/{name}';

export class PromptFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptFetchError';
  }
}

let httpClient: AxiosInstance = axios.create({ timeout: 5000 });
let configuredPromptApiBase: string | undefined;

export function setPromptApiBase(base?: string | null): void {
  configuredPromptApiBase = base ? String(base).replace(/\/$/, '') : undefined;
}

export function getPromptApiBase(): string | undefined {
  return configuredPromptApiBase;
}

export function _setHttpClientForTests(client: AxiosInstance): void {
  httpClient = client;
}

export function _resetHttpClientForTests(): void {
  httpClient = axios.create({ timeout: 5000 });
  configuredPromptApiBase = undefined;
}

export function deriveBaseUrl(tracesEndpoint: string): string {
  const url = new URL(tracesEndpoint);
  return `${url.protocol}//${url.host}`;
}

export function resolveCredentials(opts?: {
  apiKey?: string;
  endpoint?: string;
  promptApiBase?: string;
}): { apiKey: string; baseUrl: string } {
  const cfg = loadConfig();
  const apiKey = opts?.apiKey || cfg.tracing.api_key || '';
  const traces = opts?.endpoint || cfg.tracing.endpoint || DEFAULT_ENDPOINT;
  if (!apiKey) {
    throw new PromptFetchError(
      'Traccia API key not found. Call init({ apiKey }) or set TRACCIA_API_KEY before loadPrompt.',
    );
  }
  let base =
    opts?.promptApiBase ||
    configuredPromptApiBase ||
    process.env.TRACCIA_PROMPT_API_BASE ||
    undefined;
  if (!base) {
    base = deriveBaseUrl(traces);
  }
  return { apiKey, baseUrl: base.replace(/\/$/, '') };
}

export async function fetchPromptRuntime(
  name: string,
  opts?: {
    label?: string | null;
    version?: number | null;
    apiKey?: string;
    endpoint?: string;
    promptApiBase?: string;
    timeout?: number;
  },
): Promise<{ payload: Record<string, unknown>; etag?: string }> {
  if (opts?.label && opts?.version != null) {
    throw new Error('Pass label or version, not both');
  }
  const { apiKey, baseUrl } = resolveCredentials({
    apiKey: opts?.apiKey,
    endpoint: opts?.endpoint,
    promptApiBase: opts?.promptApiBase,
  });
  const params: Record<string, string | number> = {};
  if (opts?.version != null) {
    params.version = opts.version;
  } else {
    params.label = opts?.label || 'production';
  }
  const url = `${baseUrl}${DEFAULT_RUNTIME_PATH.replace('{name}', encodeURIComponent(name))}`;
  try {
    const resp = await httpClient.get(url, {
      params,
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      timeout: opts?.timeout ?? 5000,
      validateStatus: () => true,
    });
    if (resp.status === 404) {
      throw new PromptFetchError(`Prompt '${name}' not found`);
    }
    if (resp.status >= 400) {
      const detail =
        typeof resp.data === 'string'
          ? resp.data.slice(0, 200)
          : JSON.stringify(resp.data).slice(0, 200);
      throw new PromptFetchError(`Prompt fetch failed (${resp.status}): ${detail}`);
    }
    return {
      payload: resp.data as Record<string, unknown>,
      etag: resp.headers?.etag as string | undefined,
    };
  } catch (err) {
    if (err instanceof PromptFetchError) throw err;
    throw new PromptFetchError(`Failed to fetch prompt '${name}': ${String(err)}`);
  }
}
