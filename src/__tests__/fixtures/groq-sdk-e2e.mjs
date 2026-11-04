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
    const data = url.endsWith('/check') ? { effect: 'allow', would_have: false, obligations: { reserved_usd: 0.5 } } : {};
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
// When set, a stream sends its first two chunks and then nothing until it is aborted.
let hang = false;
// The AbortSignal of each Groq request, to see whether a dropped stream's request was aborted.
const signals = [];
// The first span's end count when the last Groq request was about to respond.
let endedAtResponse;
const fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  signals.push(init.signal);
  await sleep(fetchDelay);
  endedAtResponse = spans[0]?.ended ?? 0;
  if (status !== 200) {
    return new Response(JSON.stringify({ error: { message: 'bad request' } }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (body.stream && hang) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sse(CHUNKS.slice(0, 2)).replace('data: [DONE]\n\n', '')));
        init.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
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
  signals.length = 0;
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
    interrupted: spans.map((s) => s.attributes['llm.interrupted']),
    usage: spans.map((s) => ({
      source: s.attributes['llm.usage.source'],
      prompt: s.attributes['llm.usage.prompt_tokens'],
      completion: s.attributes['llm.usage.completion_tokens'],
    })),
    aborted: signals.map((s) => Boolean(s?.aborted)),
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
// A second iterator of a stream already being read gets groq-sdk's "consumed stream" error;
// the app catches it and reads the first iterator to the end.
const refused = {};
await run('secondIterator', async () => {
  const stream = await create({ stream: true });
  const first = stream[Symbol.asyncIterator]();
  await first.next();
  try {
    await stream[Symbol.asyncIterator]().next();
  } catch (e) {
    refused.secondIterator = e?.message;
  }
  while (!(await first.next()).done);
});
await run('teeAfterReading', async () => {
  const stream = await create({ stream: true });
  const first = stream[Symbol.asyncIterator]();
  await first.next();
  try {
    const [left] = stream.tee();
    for await (const _ of left);
  } catch (e) {
    refused.teeAfterReading = e?.message;
  }
  while (!(await first.next()).done);
});
results.secondIterator.refused = refused.secondIterator;
results.teeAfterReading.refused = refused.teeAfterReading;

// return() on an iterator, or cancel() on a ReadableStream, before any read leaves groq-sdk's
// stream unconsumed: the app then reads it in full.
const texts = {};
const readText = async (stream) => {
  let text = '';
  for await (const c of stream) text += c.choices[0]?.delta?.content ?? '';
  return text;
};
await run('returnBeforeNext', async () => {
  const stream = await create({ stream: true });
  await stream[Symbol.asyncIterator]().return();
  texts.returnBeforeNext = await readText(stream);
});
await run('cancelReadableBeforeReading', async () => {
  const stream = await create({ stream: true });
  await stream.toReadableStream().cancel();
  texts.cancelReadableBeforeReading = await readText(stream);
});
results.returnBeforeNext.text = texts.returnBeforeNext;
results.cancelReadableBeforeReading.text = texts.cancelReadableBeforeReading;

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

// A stream still open when tracing stops is aborted and charged its reservation; its span
// records the estimate of what was read.
await run('streamOpenAtShutdown', async () => {
  const it = (await create({ stream: true }))[Symbol.asyncIterator]();
  await it.next();
  await it.next();
  await lib.settleOpenCalls(1000);
});

// A stream cancelled before any read and then dropped is still ended once collected.
await run('cancelReadableThenDrop', async () => {
  await (async () => {
    await (await create({ stream: true })).toReadableStream().cancel();
  })();
  await collectUntilEnded();
});

// A stream left going at shutdown (ungoverned at stopTracing(), or by the signal drain at its
// time limit) is stopped once the app drops it. Groq's stream here never ends on its own.
const abortedBeforeDrop = {};
async function leaveGoingThenDrop(name, shutdown, identity) {
  hang = true;
  // The fake stream holds nothing that keeps the process alive, as a real socket would.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await (async () => {
      const stream = await lib.runIdentity(identity, () => create({ stream: true }));
      const it = stream[Symbol.asyncIterator]();
      await it.next();
      await it.next();
    })();
    await shutdown();
    abortedBeforeDrop[name] = Boolean(signals[0]?.aborted);
    for (let i = 0; i < 50 && !signals[0]?.aborted; i++) {
      await sleep(20);
      globalThis.gc?.();
    }
  } finally {
    clearInterval(keepAlive);
    hang = false;
  }
}
await run('ungovernedStopThenDrop', () =>
  leaveGoingThenDrop('ungovernedStopThenDrop', () => lib.settleOpenCalls(200), { pepEnabled: false })
);
await run('drainTimeoutThenDrop', () =>
  leaveGoingThenDrop('drainTimeoutThenDrop', () => lib.drainOpenCalls(100), { pepEnabled: true })
);
results.ungovernedStopThenDrop.abortedBeforeDrop = abortedBeforeDrop.ungovernedStopThenDrop;
results.drainTimeoutThenDrop.abortedBeforeDrop = abortedBeforeDrop.drainTimeoutThenDrop;

// Collecting the create() promise must never end or settle a call that is still in flight.
const asResponseInFlight = async () => {
  endedAtResponse = undefined;
  // From a function that has returned, so no suspended frame keeps the create() promise.
  const pending = (() => create().asResponse())();
  // Force garbage collection for as long as the call is in flight (the check and the request),
  // and look at the span when Groq responds, so a slow machine cannot hide an early end.
  for (let i = 0; i < 250 && endedAtResponse === undefined; i++) {
    await sleep(20);
    globalThis.gc?.();
  }
  results.endedBeforeResponse = endedAtResponse;
  await (await pending).json();
  await collectUntilEnded();
};
fetchDelay = 200;
await run('asResponseSlowRequest', asResponseInFlight);
results.asResponseSlowRequest.endedBeforeResponse = results.endedBeforeResponse;
fetchDelay = 0;
checkDelay = 200;
await run('asResponseSlowCheck', asResponseInFlight);
results.asResponseSlowCheck.endedBeforeResponse = results.endedBeforeResponse;
await run('fireAndForgetSlowCheck', async () => {
  create();
  await sleep(10);
  globalThis.gc?.();
  await collectUntilEnded();
});
checkDelay = 0;
delete results.endedBeforeResponse;

process.stdout.write(JSON.stringify({ patchGroq, patchGroqEsm, results }));
