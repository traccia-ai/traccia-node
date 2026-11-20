/**
 * HTTP client for /api/v1/eval-runtime/*
 */

import axios from 'axios';
import { resolveCredentials } from '../prompts/client';
import { EvaluateError } from './errors';

/** A JSON object returned by the eval runtime API. */
export type ApiRecord = Record<string, unknown>;

async function request(
  method: 'GET' | 'POST',
  path: string,
  opts?: {
    apiKey?: string;
    promptApiBase?: string;
    body?: Record<string, unknown>;
    timeout?: number;
  },
): Promise<ApiRecord> {
  const { apiKey, baseUrl } = resolveCredentials({
    apiKey: opts?.apiKey,
    promptApiBase: opts?.promptApiBase,
  });
  try {
    const resp = await axios.request<ApiRecord>({
      method,
      url: `${baseUrl}${path}`,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      data: opts?.body,
      timeout: opts?.timeout ?? 60000,
      validateStatus: () => true,
    });
    if (resp.status >= 400) {
      const detail = resp.data?.detail ?? resp.statusText;
      throw new EvaluateError(`Eval runtime ${resp.status}: ${JSON.stringify(detail)}`);
    }
    return resp.data;
  } catch (err: unknown) {
    if (err instanceof EvaluateError) throw err;
    const message = (err as { message?: unknown } | null | undefined)?.message;
    throw new EvaluateError(`Eval runtime request failed: ${String(message || err)}`);
  }
}

export async function fetchDataset(nameOrId: string, opts?: { apiKey?: string; promptApiBase?: string }) {
  return request('GET', `/api/v1/eval-runtime/datasets/${encodeURIComponent(nameOrId)}`, opts);
}

export async function fetchDatasetItemsPayload(
  datasetId: string,
  opts?: { apiKey?: string; promptApiBase?: string },
) {
  const data = await request('GET', `/api/v1/eval-runtime/datasets/${datasetId}/items`, opts);
  return (data || { items: [] }) as Record<string, unknown>;
}

export async function fetchDatasetItems(
  datasetId: string,
  opts?: { apiKey?: string; promptApiBase?: string },
) {
  const data = await fetchDatasetItemsPayload(datasetId, opts);
  return (data?.items || []) as Record<string, unknown>[];
}

export async function createEphemeralDataset(opts: {
  name: string;
  items: Record<string, unknown>[];
  description?: string;
  apiKey?: string;
  promptApiBase?: string;
}) {
  return request('POST', '/api/v1/eval-runtime/datasets', {
    apiKey: opts.apiKey,
    promptApiBase: opts.promptApiBase,
    body: {
      name: opts.name,
      description: opts.description,
      items: opts.items,
    },
  });
}

export async function fetchScorer(nameOrId: string, opts?: { apiKey?: string; promptApiBase?: string }) {
  return request('GET', `/api/v1/eval-runtime/scorers/${encodeURIComponent(nameOrId)}`, opts);
}

export async function scoreRemote(opts: {
  scorerId?: string;
  scorerName?: string;
  output: unknown;
  expectedOutput?: unknown;
  input?: unknown;
  providerKeys?: Record<string, string>;
  scorerSnapshotToken?: string;
  apiKey?: string;
  promptApiBase?: string;
}) {
  return request('POST', '/api/v1/eval-runtime/score', {
    apiKey: opts.apiKey,
    promptApiBase: opts.promptApiBase,
    body: {
      scorer_id: opts.scorerId,
      scorer_name: opts.scorerName,
      output: opts.output,
      expected_output: opts.expectedOutput,
      input: opts.input,
      provider_keys: opts.providerKeys || {},
      ...(opts.scorerSnapshotToken ? { scorer_snapshot_token: opts.scorerSnapshotToken } : {}),
    },
  });
}

export async function fetchExperiment(
  experimentId: string,
  opts?: { apiKey?: string; promptApiBase?: string },
) {
  return request('GET', `/api/v1/eval-runtime/experiments/${experimentId}`, opts);
}

export async function createExperiment(opts: {
  datasetId: string;
  name?: string;
  experimentId?: string;
  promptVersionIds?: string[];
  scorerIds?: string[];
  results?: Record<string, unknown>;
  aggregates?: Record<string, unknown>;
  runContext?: Record<string, unknown>;
  datasetSnapshotToken?: string;
  apiKey?: string;
  promptApiBase?: string;
}) {
  const body: Record<string, unknown> = {
    dataset_id: opts.datasetId,
    name: opts.name,
    prompt_version_ids: opts.promptVersionIds || [],
    scorer_ids: opts.scorerIds || [],
    results: opts.results || {},
    aggregates: opts.aggregates || {},
    run_context: opts.runContext || {},
  };
  if (opts.datasetSnapshotToken) body.dataset_snapshot_token = opts.datasetSnapshotToken;
  if (opts.experimentId) body.id = opts.experimentId;
  const call = () => request('POST', '/api/v1/eval-runtime/experiments', {
    apiKey: opts.apiKey,
    promptApiBase: opts.promptApiBase,
    body,
  });
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await call();
    } catch (err) {
      lastError = err;
      const retry = err instanceof EvaluateError && String(err.message).startsWith('Eval runtime 5');
      if (!retry || attempt === 2) throw err;
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function resolvePromptVersionIds(
  promptName: string,
  opts?: { apiKey?: string; promptApiBase?: string; version?: number | null; label?: string | null },
): Promise<string[]> {
  const { fetchPromptRuntime } = await import('../prompts/client');
  const { payload } = await fetchPromptRuntime(promptName, opts);
  const vid = (payload.version_id || payload.id) as string | undefined;
  return vid ? [String(vid)] : [];
}
