<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://traccia.ai/Traccia%20logo%20white%20-transparent-.png">
    <img src="https://traccia.ai/Traccia%20logo%20blue%20-transparent-.png" alt="Traccia" width="300">
  </picture>
</h1>

**The AI agent control plane. Observe, evaluate, govern and prove what your agents do.**

An open-source TypeScript and JavaScript SDK for tracing, evaluations, prompt management, and runtime governance, built on OpenTelemetry.

[![npm](https://img.shields.io/npm/v/@traccia/sdk)](https://www.npmjs.com/package/@traccia/sdk)
[![Downloads](https://img.shields.io/npm/dm/@traccia/sdk)](https://www.npmjs.com/package/@traccia/sdk)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/traccia-ai/traccia-node?style=social)](https://github.com/traccia-ai/traccia-node/stargazers)

[Docs](https://traccia.ai/docs/) · [Quickstart](https://traccia.ai/docs/sdk/quickstart/) · [Python SDK](https://github.com/traccia-ai/traccia-py) · [Free account](https://app.traccia.ai/) · [Changelog](CHANGELOG.md)

</div>

- **Observe.** `init()` traces every OpenAI, Anthropic and Gemini call, with tokens and cost on each span. Send traces to Traccia or to any OTLP backend.
- **Evaluate.** Score your agent on a dataset with `evaluate()`, locally or as a saved experiment, and fail a pull request when quality falls or cost or latency goes over your limit. Version prompts and load them at runtime.
- **Govern.** Check each LLM and tool call before it runs: stop an agent that overspends, loops or calls the wrong tool.
- **Prove.** Keep evidence for the EU AI Act and HIPAA in the Compliance Hub.

<p align="center">
  <img src="https://traccia.ai/docs/Trace_detail.png" alt="One agent run in Traccia: duration, cost, tokens, LLM and tool calls, and the span timeline" width="900">
  <br>
  <em>One agent run in Traccia: cost, tokens, every LLM and tool call, and how long each took.</em>
</p>

<!-- TODO: 20 to 30 second GIF here. An agent loops on a tool, Loop Cap blocks the next call, and the trace in Traccia shows which policy fired and why. -->

## Quickstart

No Traccia account needed. You need an OpenAI API key for this example.

**1. Install**

```bash
npm init -y
npm install @traccia/sdk openai
npm install -D tsx
export OPENAI_API_KEY="sk-..."
```

**2. Trace your first call**

Save this as `index.ts`:

```typescript
import OpenAI from 'openai';
import { init, observe, stopTracing } from '@traccia/sdk';

const client = new OpenAI(); // patched by init()

const answer = observe({ name: 'answer' })(async (question: string) => {
  const resp = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: question }],
  });
  return resp.choices[0].message.content;
});

async function main() {
  await init({ useOtlp: false, enableConsoleExporter: true }); // print spans in your terminal
  // await init({ endpoint: 'http://localhost:4318/v1/traces' }); // or send them to Jaeger, Tempo, SigNoz...
  // await init(); // or to Traccia: set TRACCIA_API_KEY from app.traccia.ai

  console.log(await answer('What is OpenTelemetry?'));
  await stopTracing(); // flush spans before the process exits
}

main();
```

```bash
npx tsx index.ts
```

**3. See the trace**

Each LLM span records the model, tokens, cost, prompt, completion and latency. It prints in your terminal, shows up in your OTLP backend ([Jaeger](https://traccia.ai/docs/guides/local-jaeger/), [Grafana](https://traccia.ai/docs/guides/local-grafana/)), or appears under **Traces** in Traccia like the run above.

## Evaluate your agent

Run your agent over a small dataset and score every answer. This runs locally, with no Traccia account. Add it to `main()` in `index.ts`, before `stopTracing()`:

```typescript
import { evaluate } from '@traccia/sdk';

// in main(), after init():
const result = await evaluate({
  name: 'trivia-check',
  data: [
    { input: { question: 'What is the capital of France?' }, expected: 'Paris' },
    { input: { question: 'What is 12 * 12?' }, expected: '144' },
    { input: { question: 'Who wrote Hamlet?' }, expected: 'Shakespeare' },
  ],
  task: async (input) => answer(input.question as string), // answer() from the quickstart
  scorers: ['contains'], // also exact_match, json_valid, or your own function
  persist: false,        // keep it local
});
console.log(result.summary());
```

If one of the three answers misses, it prints:

```text
Experiment: trivia-check
Items: 3
Pass rate: 0.6666666666666666
Scored: 3
Errors: 0
Persisted: no (local-only)
```

Drop `persist: false` and the run is saved as an experiment in Traccia, where you can compare it with the last run side by side and score with an LLM judge. In CI, `traccia-ts eval` fails the job when quality, cost or latency misses the bar you set ([CI evals](https://traccia.ai/docs/guides/ci-evals/), [GitHub Action](https://github.com/traccia-ai/traccia-eval-action)). More: [Evaluate](https://traccia.ai/docs/sdk/evaluate/).

## Version your prompts

Keep prompts in the Traccia prompt registry, where each version is fixed once saved and the `production` label marks the one to serve. Your code loads whatever version holds the label:

```typescript
import { loadPrompt } from '@traccia/sdk';

// in an async function, after init():
const prompt = await loadPrompt({
  name: 'support-reply',
  label: 'production',
  fallback: { type: 'chat', messages: [ // used if Traccia can't be reached
    { role: 'system', content: 'You answer billing questions for {{company}}.' },
    { role: 'user', content: '{{question}}' },
  ] },
});
const messages = prompt.compile({ company: 'Acme', question: 'Why was I charged twice?' });
```

`compile()` fills in the `{{variables}}` and records the prompt name and version on the current span, so each trace shows which prompt produced it. Prompts are cached, and the fallback keeps your agent running, with a warning in the log, if the registry is out of reach. More: [Prompts](https://traccia.ai/docs/sdk/prompts/).

## Stop a runaway agent

`observe()` records what happened. `govern()` also decides whether the next call is allowed to happen. Policies live in the Traccia app, so you can change a limit without a deploy.

```mermaid
flowchart LR
    A["Your agent<br/>(govern)"] --> B{"Policy check<br/>before the call"}
    B -->|Allow| C["LLM or tool runs"]
    B -->|Reshape| D["Runs on a cheaper model<br/>or with fewer tokens"]
    B -->|Deny| E["AgentBlockedError<br/>provider never called"]
    B -->|Hold| F["ApprovalPending thrown<br/>approval queued"]
    C --> G["Spans over OTLP"]
    D --> G
    G --> H["Traccia"]
    G --> I["Or any OTLP backend:<br/>Tempo, Jaeger, Zipkin, SigNoz"]
```

In the [Traccia app](https://app.traccia.ai/), create a **Loop Cap** policy with a maximum of 3 tool calls per run, set it to **Block**, and copy your API key.

```typescript
import { init, observe, govern, stopTracing, AgentBlockedError } from '@traccia/sdk';

const webSearch = observe({ name: 'web_search', asType: 'tool' })(
  async (query: string) => `results for ${query}`,
);

const runAgent = govern({ name: 'run_agent' })(async (topic: string) => {
  while (true) { // a bug: the agent never decides it has enough
    await webSearch(topic);
  }
});

async function main() {
  await init({ apiKey: '...', agentId: 'research-agent' }); // API key from app.traccia.ai
  try {
    await runAgent('agent observability');
  } catch (err) {
    if (!(err instanceof AgentBlockedError)) throw err;
    // The 4th search is denied before it runs.
    console.log(err.reasons, err.decisionId);
  }
  await stopTracing();
}

main();
```

The same wrapper runs the other policies, for example:

- [Spend Cap](https://traccia.ai/docs/platform/policies/spend-cap/) stops a model call that would go over your USD budget, or moves it to a cheaper model.
- [Refund Guard](https://traccia.ai/docs/platform/policies/refund-guard/) stops a refund over your limit. For a middle amount, `govern()` throws `ApprovalPending` and queues the request for a person to approve.
- [High-Risk Tool](https://traccia.ai/docs/platform/policies/high-risk-tool/) stops a tool you name, such as `delete_account`.

See [all policies](https://traccia.ai/docs/platform/policies/). Each one runs in Observe (log a match), Warn (alert) or Block (stop the call) mode, so you can watch what a policy would stop before you turn it on.

If Traccia can't be reached, the check blocks the call by default. You can let calls through instead under **Settings → Policy Enforcement**, or locally with `init({ policyFailMode: 'open' })`. Without an API key or agent ID, `govern()` throws `GovernanceConfigError` instead of running unchecked. See [Governance in the SDK](https://traccia.ai/docs/sdk/governance/).

### Can't add the SDK? Use the Gateway

For an agent you can't change, such as a closed-source tool or an n8n workflow, point its OpenAI, Anthropic or Gemini client at the [Traccia Gateway](https://traccia.ai/docs/platform/gateway/): change the base URL and add two Traccia headers. You keep your own provider key. The Gateway checks each model call, but it can't see tools or the rest of the run:

| | SDK (`govern()`) | Gateway |
|---|---|---|
| Spend Cap, Model Boundary | Yes | Yes |
| Loop Cap, tool guards (Refund Guard, High-Risk Tool, ...), Prompt Pin and the other SDK-only policies | Yes | No |
| What the trace shows | The whole run: tools, nested steps, every call | One span per model call |

Use one or the other for a given call, not both. Guides for the [Vercel AI SDK](https://traccia.ai/docs/platform/gateway/vercel-ai-sdk/), [LiteLLM](https://traccia.ai/docs/platform/gateway/litellm/), [n8n](https://traccia.ai/docs/platform/gateway/n8n/) and more are in the Gateway docs.

## Works with

- **Model SDKs, patched automatically:** OpenAI (Chat Completions and Responses), Anthropic, Gemini (`@google/genai` Interactions API)
- **Agent frameworks:** [LangChain](https://traccia.ai/docs/integrations/langchain/) and LangGraph, [OpenAI Agents SDK](https://traccia.ai/docs/integrations/openai-agents/)
- **HTTP:** Express and Fastify middleware, `fetch` and axios, with W3C trace context across services
- **Coding agents, traced without the SDK:** [Claude Code](https://traccia.ai/docs/integrations/claude-code/), [Cursor](https://traccia.ai/docs/integrations/cursor/), [GitHub Copilot](https://traccia.ai/docs/integrations/github-copilot/)
- **Any OTLP backend:** Grafana Tempo, Jaeger, Zipkin, SigNoz ([exporters](https://traccia.ai/docs/sdk/exporters/))

## What needs an account

| | Without an account | With a Traccia account |
|---|---|---|
| Tracing, to the console or any OTLP backend | Yes | Yes, plus the Traccia app |
| Local evals with `evaluate({ persist: false })` | Yes | Yes |
| Saved experiments, comparisons, LLM-judge scorers | No | Yes |
| Prompt registry (`loadPrompt`) | Fallback only | Yes |
| Runtime policies (`govern()`) | No | Yes |
| The Gateway, human approval, the Compliance Hub | No | On paid plans |

There is a free plan. See [pricing](https://traccia.ai/pricing/).

## Docs

| Topic | Where |
|---|---|
| Install and first trace | [Quickstart](https://traccia.ai/docs/sdk/quickstart/) |
| `observe()`, spans, async, errors | [The observe decorator](https://traccia.ai/docs/sdk/observe-decorator/) |
| `evaluate()`, scorers and experiments | [Evaluate](https://traccia.ai/docs/sdk/evaluate/) |
| `loadPrompt` and the prompt registry | [Prompts](https://traccia.ai/docs/sdk/prompts/) |
| `govern()`, policy checks, fail mode | [Governance in the SDK](https://traccia.ai/docs/sdk/governance/) |
| Guardrail detection | [Guardrails](https://traccia.ai/docs/sdk/guardrails/) |
| Cost estimation and pricing overrides | [Pricing](https://traccia.ai/docs/sdk/pricing/) |
| OpenTelemetry metrics | [Metrics](https://traccia.ai/docs/sdk/metrics/) |
| Multi-agent services | [Multi-agent](https://traccia.ai/docs/guides/multi-agent/) |
| `traccia.toml` and environment variables | [Configuration](https://traccia.ai/docs/reference/configuration/) |
| `traccia-ts config`, `eval` and the other commands | [CLI](https://traccia.ai/docs/reference/cli/) |
| Full API | [Node.js SDK reference](https://traccia.ai/docs/reference/node-sdk/) |
| Something not working | [Troubleshooting](https://traccia.ai/docs/guides/troubleshooting/) |
| Docs for your coding agent | [traccia.ai/llms.txt](https://traccia.ai/llms.txt) |

## Contributing

Bug fixes, integrations and examples are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md), and open an [issue](https://github.com/traccia-ai/traccia-node/issues) first for anything large.

```bash
git clone https://github.com/traccia-ai/traccia-node.git
cd traccia-node
npm install
npm run build
npm test
```

If Traccia caught a bad call for you, a star helps other people find it.

> ### Read this far? Come build Traccia with us.
>
> If you want to work on Traccia full time, skip the cover letter. Email **[founders@traccia.ai](mailto:founders@traccia.ai)** with one specific thing: a trace the SDK got wrong, a policy you needed and couldn't build, or a part of this code you would rewrite and how.
>
> "I'm passionate about AI" gets archived. A link to your pull request gets a reply.

## License

[Apache 2.0](LICENSE). Built on [OpenTelemetry](https://opentelemetry.io/).
