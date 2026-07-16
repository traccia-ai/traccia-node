/**
 * Tests for Compile parity and loadPrompt behavior.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  compileBody,
  CompileError,
  extractFromBody,
  extractVariableNames,
} from '../prompts/compile';
import {
  loadPrompt,
  prefetchPrompts,
  resetPromptCache,
  configurePrompts,
  _setFetchImplForTests,
  _resetFetchImplForTests,
  LoadedPrompt,
  PromptFetchError,
} from '../prompts';
import {
  deriveBaseUrl,
  fetchPromptRuntime,
  resolveCredentials,
  setPromptApiBase,
  _setHttpClientForTests,
  _resetHttpClientForTests,
} from '../prompts/client';
import { redactAttributes } from '../redaction/redaction';

const FIXTURES = path.resolve(__dirname, 'fixtures/compile-fixtures.json');

beforeEach(() => {
  resetPromptCache();
  _resetFetchImplForTests();
  _resetHttpClientForTests();
  configurePrompts({ cacheTtlS: 60 });
  delete process.env.TRACCIA_PROMPT_API_BASE;
});

afterEach(() => {
  resetPromptCache();
  _resetFetchImplForTests();
  _resetHttpClientForTests();
  delete process.env.TRACCIA_PROMPT_API_BASE;
});

describe('compile fixtures', () => {
  it('matches shared golden cases', () => {
    const data = JSON.parse(fs.readFileSync(FIXTURES, 'utf8'));
    for (const testCase of data.cases) {
      if (testCase.error) {
        expect(() =>
          compileBody(testCase.type, testCase.body, testCase.variables),
        ).toThrow(CompileError);
        expect(() =>
          compileBody(testCase.type, testCase.body, testCase.variables),
        ).toThrow(testCase.error);
        continue;
      }
      const { compiled, extras } = compileBody(
        testCase.type,
        testCase.body,
        testCase.variables,
      );
      expect(compiled).toEqual(testCase.expected);
      expect(extras).toEqual(testCase.warn_extras || []);
    }
  });
});

describe('loadPrompt', () => {
  it('caches hits', async () => {
    let n = 0;
    const payload = {
      name: 'support-reply',
      type: 'chat',
      version: 1,
      version_id: 'v1',
      label: 'production',
      body: { messages: [{ role: 'system', content: 'hi' }] },
      model_config: {},
    };
    _setFetchImplForTests(async () => {
      n += 1;
      return { payload, etag: '"e"' };
    });
    const a = await loadPrompt({ name: 'support-reply' });
    const b = await loadPrompt({ name: 'support-reply' });
    expect(n).toBe(1);
    expect(a.version).toBe(1);
    expect(b.version).toBe(1);
    expect(a.isStale).toBe(false);
  });

  it('serves stale while revalidating', async () => {
    const payloads = [
      {
        name: 'p',
        type: 'text',
        version: 1,
        version_id: 'a',
        label: 'production',
        body: { text: 'v1' },
      },
      {
        name: 'p',
        type: 'text',
        version: 2,
        version_id: 'b',
        label: 'production',
        body: { text: 'v2' },
      },
    ];
    let i = 0;
    _setFetchImplForTests(async () => {
      const payload = payloads[Math.min(i, payloads.length - 1)];
      i += 1;
      return { payload };
    });
    configurePrompts({ cacheTtlS: 0.05 });
    const first = await loadPrompt({ name: 'p' });
    expect(first.version).toBe(1);
    await new Promise((r) => setTimeout(r, 60));
    const second = await loadPrompt({ name: 'p' });
    expect(second.isStale).toBe(true);
    expect(second.version).toBe(1);
    configurePrompts({ cacheTtlS: 60 });
    let third: LoadedPrompt | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise((r) => setTimeout(r, 50));
      third = await loadPrompt({ name: 'p' });
      if (third.version === 2) break;
    }
    expect(third?.version).toBe(2);
    expect(third?.isStale).toBe(false);
  });

  it('uses fallback and sets is_fallback', async () => {
    _setFetchImplForTests(async () => {
      throw new PromptFetchError('down');
    });
    const prompt = await loadPrompt({
      name: 'missing',
      fallback: {
        type: 'chat',
        messages: [{ role: 'system', content: 'offline' }],
      },
    });
    expect(prompt.isFallback).toBe(true);
    expect(prompt.messages?.[0].content).toBe('offline');
    expect(prompt.spanAttributes()['traccia.prompt.is_fallback']).toBe(true);
  });

  it('prefetch warms cache', async () => {
    const calls: string[] = [];
    _setFetchImplForTests(async (name) => {
      calls.push(name);
      return {
        payload: {
          name,
          type: 'text',
          version: 1,
          version_id: name,
          label: 'production',
          body: { text: name },
        },
      };
    });
    await prefetchPrompts(['a', 'b'], { jitterMs: 0 });
    expect(calls).toEqual(['a', 'b']);
    const before = calls.length;
    await loadPrompt({ name: 'a' });
    expect(calls.length).toBe(before);
  });
});

describe('redaction allowlist', () => {
  it('preserves traccia.prompt.* identity attrs', () => {
    const out = redactAttributes({
      'gen_ai.prompt': 'email me at a@b.com',
      'traccia.prompt.name': 'support-reply',
      'traccia.prompt.version': '12',
      'traccia.prompt.label': 'production',
      'traccia.prompt.is_fallback': true,
    });
    expect(String(out['gen_ai.prompt'])).toContain('[REDACTED_EMAIL]');
    expect(out['traccia.prompt.name']).toBe('support-reply');
    expect(out['traccia.prompt.version']).toBe('12');
    expect(out['traccia.prompt.label']).toBe('production');
    expect(out['traccia.prompt.is_fallback']).toBe(true);
  });
});

describe('LoadedPrompt.compile', () => {
  it('compiles chat messages', () => {
    const prompt = LoadedPrompt.fromPayload({
      name: 'greet',
      type: 'chat',
      version: 1,
      version_id: 'x',
      label: 'production',
      body: {
        messages: [{ role: 'user', content: 'Hi {{name}}' }],
      },
    });
    const messages = prompt.compile({ name: 'Ada' }) as Array<{ content: string }>;
    expect(messages[0].content).toBe('Hi Ada');
  });

  it('compiles text prompts and warns on extras', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const prompt = LoadedPrompt.fromPayload({
      name: 'greet',
      type: 'text',
      version: 2,
      version_id: 'y',
      label: 'latest',
      body: { text: 'Hi {{name}}' },
    });
    expect(prompt.text).toBe('Hi {{name}}');
    expect(prompt.messages).toBeUndefined();
    expect(prompt.compile({ name: 'Ada', unused: 1 })).toBe('Hi Ada');
    expect(warn).toHaveBeenCalled();
    expect(prompt.spanAttributes()['traccia.prompt.version']).toBe('2');
    expect(prompt.spanAttributes()['traccia.prompt.label']).toBe('latest');
    warn.mockRestore();
  });

  it('fromFallback defaults chat vs text', () => {
    const chat = LoadedPrompt.fromFallback('a', {
      messages: [{ role: 'system', content: 'x' }],
    });
    expect(chat.type).toBe('chat');
    expect(chat.isFallback).toBe(true);
    const text = LoadedPrompt.fromFallback('b', { text: 'offline' }, 'production');
    expect(text.type).toBe('text');
    expect(text.text).toBe('offline');
    expect(text.label).toBe('production');
  });

  it('applySpanAttributes is best-effort', () => {
    const prompt = LoadedPrompt.fromPayload({
      name: 'n',
      type: 'text',
      body: { text: 'x' },
    });
    const span = { setAttribute: jest.fn() };
    prompt.applySpanAttributes(span);
    expect(span.setAttribute).toHaveBeenCalledWith('traccia.prompt.name', 'n');
    prompt.applySpanAttributes(null);
  });
});

describe('compile helpers', () => {
  it('extractVariableNames and extractFromBody cover chat/text', () => {
    expect(extractVariableNames('{{a}} and {{b}} and {{a}}')).toEqual(['a', 'b']);
    expect(extractFromBody('text', { text: 'Hi {{name}}' })).toEqual(['name']);
    expect(
      extractFromBody('chat', {
        messages: [
          { role: 'system', content: '{{topic}}' },
          { role: 'user', content: '{{q}}' },
        ],
      }),
    ).toEqual(['topic', 'q']);
  });

  it('compileBody respects declared variables', () => {
    const { compiled } = compileBody(
      'text',
      { text: 'Hi {{name}}' },
      { name: 'Ada', unused: 1 },
      [{ name: 'name' }],
    );
    expect(compiled).toEqual({ text: 'Hi Ada' });
  });
});

describe('prompt HTTP client', () => {
  it('deriveBaseUrl strips path', () => {
    expect(deriveBaseUrl('https://api.traccia.ai/v2/traces')).toBe(
      'https://api.traccia.ai',
    );
  });

  it('resolveCredentials prefers overrides and env', () => {
    expect(() => resolveCredentials()).toThrow(PromptFetchError);
    expect(
      resolveCredentials({
        apiKey: 'tr_x',
        endpoint: 'https://api.traccia.ai/v2/traces',
      }).baseUrl,
    ).toBe('https://api.traccia.ai');
    setPromptApiBase('https://custom.example/');
    expect(
      resolveCredentials({
        apiKey: 'tr_x',
        endpoint: 'https://api.traccia.ai/v2/traces',
      }).baseUrl,
    ).toBe('https://custom.example');
    setPromptApiBase(null);
    process.env.TRACCIA_PROMPT_API_BASE = 'https://from-env.example';
    expect(
      resolveCredentials({
        apiKey: 'tr_x',
        endpoint: 'https://api.traccia.ai/v2/traces',
      }).baseUrl,
    ).toBe('https://from-env.example');
  });

  it('fetchPromptRuntime handles success, 404, 500, and network errors', async () => {
    const get = jest.fn();
    _setHttpClientForTests({ get } as never);

    get.mockResolvedValueOnce({
      status: 200,
      data: { name: 'p', type: 'text', body: { text: 'ok' } },
      headers: { etag: '"e1"' },
    });
    const ok = await fetchPromptRuntime('p', {
      apiKey: 'tr_x',
      endpoint: 'https://api.traccia.ai/v2/traces',
      label: 'production',
    });
    expect(ok.payload.name).toBe('p');
    expect(ok.etag).toBe('"e1"');

    get.mockResolvedValueOnce({ status: 404, data: 'missing' });
    await expect(
      fetchPromptRuntime('missing', {
        apiKey: 'tr_x',
        endpoint: 'https://api.traccia.ai/v2/traces',
      }),
    ).rejects.toThrow(/not found/);

    get.mockResolvedValueOnce({ status: 500, data: { error: 'boom' } });
    await expect(
      fetchPromptRuntime('p', {
        apiKey: 'tr_x',
        endpoint: 'https://api.traccia.ai/v2/traces',
        version: 3,
      }),
    ).rejects.toThrow(/Prompt fetch failed \(500\)/);

    await expect(
      fetchPromptRuntime('p', {
        apiKey: 'tr_x',
        endpoint: 'https://api.traccia.ai/v2/traces',
        label: 'production',
        version: 1,
      }),
    ).rejects.toThrow(/label or version/);

    get.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(
      fetchPromptRuntime('p', {
        apiKey: 'tr_x',
        endpoint: 'https://api.traccia.ai/v2/traces',
      }),
    ).rejects.toThrow(/Failed to fetch prompt/);
  });
});

describe('loadPrompt error paths', () => {
  it('throws PromptFetchError when fetch fails without fallback', async () => {
    _setFetchImplForTests(async () => {
      throw new PromptFetchError('down');
    });
    await expect(loadPrompt({ name: 'x' })).rejects.toThrow(PromptFetchError);
  });

  it('forceRefresh bypasses fresh cache', async () => {
    let n = 0;
    _setFetchImplForTests(async () => {
      n += 1;
      return {
        payload: {
          name: 'p',
          type: 'text',
          version: n,
          version_id: String(n),
          label: 'production',
          body: { text: `v${n}` },
        },
      };
    });
    await loadPrompt({ name: 'p' });
    const again = await loadPrompt({ name: 'p', forceRefresh: true });
    expect(n).toBe(2);
    expect(again.version).toBe(2);
  });

  it('returns last good cache when refresh fails', async () => {
    let fail = false;
    _setFetchImplForTests(async () => {
      if (fail) throw new PromptFetchError('down');
      return {
        payload: {
          name: 'p',
          type: 'text',
          version: 1,
          version_id: 'a',
          label: 'production',
          body: { text: 'v1' },
        },
      };
    });
    configurePrompts({ cacheTtlS: 0.01 });
    await loadPrompt({ name: 'p' });
    await new Promise((r) => setTimeout(r, 20));
    fail = true;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Expire + force a failed fetch with an entry still present via SWR path:
    // first get after TTL starts SWR; then forceRefresh with fail should hit catch+cache
    const stale = await loadPrompt({ name: 'p' });
    expect(stale.isStale).toBe(true);
    const kept = await loadPrompt({ name: 'p', forceRefresh: true });
    expect(kept.version).toBe(1);
    expect(kept.isStale).toBe(true);
    warn.mockRestore();
  });

  it('loads by version key', async () => {
    _setFetchImplForTests(async (_name, opts) => {
      expect(opts?.version).toBe(9);
      expect(opts?.label).toBeNull();
      return {
        payload: {
          name: 'p',
          type: 'text',
          version: 9,
          version_id: 'v9',
          body: { text: 'pinned' },
        },
      };
    });
    const prompt = await loadPrompt({ name: 'p', version: 9 });
    expect(prompt.version).toBe(9);
    expect(prompt.compile()).toBe('pinned');
  });
});