// Drives the real groq-sdk, loaded as an ES module (`import`) or CommonJS (`require`), through
// Traccia's Groq patching. The HTTP layer (Groq and the policy server) is faked.
//
// Usage: node groq-sdk-e2e.mjs <bundled traccia lib> <esm|cjs>
// Prints one JSON object: { patchGroq, patchGroqEsm, results: { <scenario>: {...} } }.
import { createRequire } from 'module';

const [libPath, mode] = process.argv.slice(2);
process.env.TRACCIA_API_KEY = 'test-key';
process.env.TRACCIA_ENDPOINT = 'http://localhost:9/v1/traces';
const lib = createRequire(import.meta.url)(libPath);

const posts = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Delays for the policy check and the Groq request, set per scenario.
let checkDelay = 0;
let fetchDelay = 0;
lib._setPepHttpClientForTests({
  post: async (url, body) => {
    posts.push({ url, body: JSON.parse(JSON.stringify(body)) });
    if (url.endsWith('/check')) await sleep(checkDelay);
    const data = url.endsWith('/check') ? { effect: 'allow', obligations: { reserved_usd: 0.5 } } : {};
    return { status: 200, data };
  },
});
const spans = [];
lib.setTracerProvider({
  getTracer: () => ({
    startSpan: () => {
      const span = {
        attributes: {},
        ended: 0,
        setAttribute(key, value) {
          this.attributes[key] = value;
        },
        end() {
          this.ended += 1;
        },
        recordException() {},
      };
      spans.push(span);
      return span;
    },
  }),
});

// Patch before loading groq-sdk in either format, as init() does.
const patchGroq = lib.patchGroq();
const patchGroqEsm = await lib.patchGroqEsm();

const Groq =
  mode === 'esm'
    ? (await import('groq-sdk')).default
    : createRequire(import.meta.url)('groq-sdk').default;

const MODEL = 'llama-3.3-70b-versatile';
const USAGE = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 };
const COMPLETION = {
  id: 'c1',
  object: 'chat.completion',
  model: MODEL,
  usage: USAGE,
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Paris.' } }],
};
// Groq's stream shape: a role-only first chunk, and usage under x_groq on the last one.
const CHUNKS = [
  { id: 'c1', model: MODEL, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }], x_groq: { id: 'req_1' } },
  { id: 'c1', model: MODEL, choices: [{ index: 0, delta: { content: 'Par' } }] },
  { id: 'c1', model: MODEL, choices: [{ index: 0, delta: { content: 'is.' } }] },
  { id: 'c1', model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], x_groq: { id: 'req_1', usage: USAGE } },
];
const sse = (chunks) =>
  chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';

let status = 200;
const fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  await sleep(fetchDelay);
  if (status !== 200) {
    return new Response(JSON.stringify({ error: { message: 'bad request' } }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (body.stream) {
    return new Response(sse(CHUNKS), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  return new Response(JSON.stringify(COMPLETION), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
const client = new Groq({ apiKey: 'test', fetch, maxRetries: 0 });
const messages = [{ role: 'user', content: 'Capital of France?' }];
const results = {};

async function run(name, fn) {
  posts.length = 0;
  spans.length = 0;
  let error;
  try {
    await lib.runIdentity({ agentId: 'agent-a', pepEnabled: true }, fn);
  } catch (e) {
    error = e?.constructor?.name;
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  results[name] = {
    error,
    checks: posts.filter((p) => p.url.endsWith('/check')).length,
    settles: posts.filter((p) => p.url.endsWith('/settle')).map((p) => p.body),
    spans: spans.map((s) => ({ ended: s.ended, vendor: s.attributes['llm.vendor'], status: s.status })),
  };
}

const create = (extra = {}, options) =>
  client.chat.completions.create({ model: MODEL, messages, ...extra }, options);

await run('await', async () => {
  await create();
});
await run('withResponse', async () => {
  const { data, response } = await create().withResponse();
  if (!data?.choices || !response?.headers) throw new Error('withResponse lost its shape');
});
await run('stream', async () => {
  for await (const _ of await create({ stream: true }));
});
await run('streamBreak', async () => {
  for await (const _ of await create({ stream: true })) break;
});
await run('toReadableStream', async () => {
  const reader = (await create({ stream: true })).toReadableStream().getReader();
  while (!(await reader.read()).done);
});
await run('tee', async () => {
  const [left, right] = (await create({ stream: true })).tee();
  for await (const _ of left);
  for await (const _ of right);
});
status = 400;
await run('httpError', async () => {
  await create();
});
status = 200;
await run('abortedBeforeSend', async () => {
  const controller = new AbortController();
  controller.abort();
  await create({}, { signal: controller.signal });
});
// A call nobody awaits: groq-sdk still sends it, so it must still end its span and settle,
// once its promise is garbage collected (needs node --expose-gc).
await run('fireAndForget', async () => {
  create();
  for (let i = 0; i < 25 && spans[0]?.ended !== 1; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.gc?.();
  }
});

/** Force garbage collection until the first span ends, for up to a second. */
async function collectUntilEnded() {
  for (let i = 0; i < 50 && spans[0]?.ended !== 1; i++) {
    await sleep(20);
    globalThis.gc?.();
  }
}

// A stream the caller drops must still end its span and settle once it is collected.
await run('streamDroppedUnread', async () => {
  await (async () => {
    await create({ stream: true });
  })();
  await collectUntilEnded();
});
await run('streamDroppedPartlyRead', async () => {
  await (async () => {
    const it = (await create({ stream: true }))[Symbol.asyncIterator]();
    await it.next();
    await it.next();
  })();
  await collectUntilEnded();
});

process.stdout.write(JSON.stringify({ patchGroq, patchGroqEsm, results }));
