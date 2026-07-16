/**
 * Tests for Compile parity and loadPrompt behavior.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  compileBody,
  CompileError,
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
import { redactAttributes } from '../redaction/redaction';

const FIXTURES = path.resolve(
  __dirname,
  '../../../docs/implementation/prompt-management/scratch/f49-compile-fixtures.json',
);

beforeEach(() => {
  resetPromptCache();
  _resetFetchImplForTests();
  configurePrompts({ cacheTtlS: 60 });
});

afterEach(() => {
  resetPromptCache();
  _resetFetchImplForTests();
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
});
