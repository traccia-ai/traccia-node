/**
 * Loaded prompt object and span attribute helpers.
 */

import { getCurrentSpan } from '../context/context';
import { compileBody, CompileError } from './compile';

export const ATTR_PROMPT_NAME = 'traccia.prompt.name';
export const ATTR_PROMPT_VERSION = 'traccia.prompt.version';
export const ATTR_PROMPT_VERSION_ID = 'traccia.prompt.version_id';
export const ATTR_PROMPT_LABEL = 'traccia.prompt.label';
export const ATTR_PROMPT_IS_FALLBACK = 'traccia.prompt.is_fallback';

export interface PromptMessage {
  role: string;
  content: string;
  [key: string]: unknown;
}

export interface LoadedPromptOptions {
  name: string;
  type: string;
  body: Record<string, unknown>;
  version?: number | null;
  versionId?: string | null;
  label?: string | null;
  variables?: unknown;
  modelConfig?: Record<string, unknown> | null;
  tools?: unknown;
  isFallback?: boolean;
  isStale?: boolean;
}

export class LoadedPrompt {
  readonly name: string;
  readonly type: string;
  readonly body: Record<string, unknown>;
  readonly version: number | null | undefined;
  readonly versionId: string | null | undefined;
  readonly label: string | null | undefined;
  readonly variables: unknown;
  readonly config: Record<string, unknown>;
  readonly tools: unknown;
  readonly isFallback: boolean;
  readonly isStale: boolean;

  constructor(opts: LoadedPromptOptions) {
    this.name = opts.name;
    this.type = opts.type;
    this.body = { ...(opts.body || {}) };
    this.version = opts.version;
    this.versionId = opts.versionId;
    this.label = opts.label;
    this.variables = opts.variables ?? [];
    this.config = { ...(opts.modelConfig || {}) };
    this.tools = opts.tools;
    this.isFallback = !!opts.isFallback;
    this.isStale = !!opts.isStale;
  }

  static fromPayload(
    payload: Record<string, unknown>,
    flags?: { isFallback?: boolean; isStale?: boolean },
  ): LoadedPrompt {
    return new LoadedPrompt({
      name: String(payload.name ?? ''),
      type: String(payload.type ?? 'text'),
      body: (payload.body as Record<string, unknown>) || {},
      version: payload.version as number | undefined,
      versionId: payload.version_id != null ? String(payload.version_id) : null,
      label: payload.label as string | undefined,
      variables: payload.variables,
      modelConfig:
        (payload.model_config as Record<string, unknown>) ||
        (payload.config as Record<string, unknown>) ||
        null,
      tools: payload.tools,
      isFallback: flags?.isFallback,
      isStale: flags?.isStale,
    });
  }

  static fromFallback(
    name: string,
    fallback: Record<string, unknown>,
    label?: string | null,
  ): LoadedPrompt {
    const fbType = String(
      fallback.type || (fallback.messages ? 'chat' : 'text'),
    );
    const body =
      fbType === 'chat'
        ? { messages: [...((fallback.messages as unknown[]) || [])] }
        : { text: String(fallback.text ?? '') };
    return new LoadedPrompt({
      name,
      type: fbType,
      body,
      version: fallback.version as number | undefined,
      versionId: fallback.version_id as string | undefined,
      label: label ?? (fallback.label as string | undefined),
      modelConfig:
        (fallback.model_config as Record<string, unknown>) ||
        (fallback.config as Record<string, unknown>) ||
        null,
      tools: fallback.tools,
      isFallback: true,
      isStale: false,
    });
  }

  get text(): string | undefined {
    if (this.type === 'text') return String(this.body.text ?? '');
    return undefined;
  }

  get messages(): PromptMessage[] | undefined {
    if (this.type === 'chat') {
      return [...((this.body.messages as PromptMessage[]) || [])];
    }
    return undefined;
  }

  spanAttributes(): Record<string, unknown> {
    const attrs: Record<string, unknown> = { [ATTR_PROMPT_NAME]: this.name };
    if (this.version != null) attrs[ATTR_PROMPT_VERSION] = String(this.version);
    if (this.versionId) attrs[ATTR_PROMPT_VERSION_ID] = this.versionId;
    if (this.label) attrs[ATTR_PROMPT_LABEL] = this.label;
    if (this.isFallback) attrs[ATTR_PROMPT_IS_FALLBACK] = true;
    return attrs;
  }

  applySpanAttributes(span?: { setAttribute?: (k: string, v: unknown) => void } | null): void {
    try {
      const target = span ?? getCurrentSpan();
      if (!target || typeof target.setAttribute !== 'function') return;
      for (const [k, v] of Object.entries(this.spanAttributes())) {
        target.setAttribute(k, v);
      }
    } catch {
      // best-effort
    }
  }

  compile(variables: Record<string, unknown> = {}): string | PromptMessage[] {
    let declared: Array<Record<string, unknown>> | undefined;
    if (Array.isArray(this.variables) && this.variables[0] && typeof this.variables[0] === 'object') {
      declared = this.variables as Array<Record<string, unknown>>;
    }
    const { compiled, extras } = compileBody(this.type, this.body, variables, declared);
    if (extras.length) {
      console.warn(`[traccia.prompts] Unknown prompt variables ignored: ${extras.join(', ')}`);
    }
    this.applySpanAttributes();
    if (this.type === 'text') {
      return String(compiled.text ?? '');
    }
    return [...((compiled.messages as PromptMessage[]) || [])];
  }
}

export { CompileError };
