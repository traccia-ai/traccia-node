/**
 * Tests for spanScope, runWithSpan, runWithSpanAsync and nested span propagation.
 */

import { TracerProvider } from "../tracer/provider";
import { spanScope } from "../context/span-scope";
import { getCurrentSpan, runWithSpan, runWithSpanAsync } from "../context/context";
import { setTracerProvider } from "../auto";
import { SpanStatus } from "../types";

describe("spanScope", () => {
  let provider: TracerProvider;

  beforeEach(() => {
    provider = new TracerProvider();
    setTracerProvider(provider);
  });

  it("creates child spans under scope.runAsync", async () => {
    const turn = spanScope("chat.turn", {
      attributes: { "span.type": "span" },
    });

    await turn.runAsync(async () => {
      expect(getCurrentSpan()?.context.spanId).toBe(turn.span.context.spanId);

      const tracer = provider.getTracer("test");
      const llm = tracer.startSpan("llm.inference", {
        attributes: { "span.type": "LLM" },
      });
      expect(llm.context.traceId).toBe(turn.span.context.traceId);
      expect(llm.parentSpanId).toBe(turn.span.context.spanId);
      llm.end();
    });

    turn.end();
  });

  it("records exception on end(error)", () => {
    const scope = spanScope("chat.turn");
    scope.end(new Error("boom"));
    expect(scope.span.status).toBe(SpanStatus.ERROR);
  });

  it("records non-Error values as exceptions on end(error)", () => {
    const scope = spanScope("chat.turn");
    scope.end("boom");
    expect(scope.span.status).toBe(SpanStatus.ERROR);
  });

  it("ignores duplicate end() calls", () => {
    const scope = spanScope("chat.turn");
    const endSpy = jest.spyOn(scope.span, "end");

    scope.end();
    scope.end();

    expect(endSpy).toHaveBeenCalledTimes(1);
    endSpy.mockRestore();
  });

  it("runs sync callbacks via scope.run", () => {
    const scope = spanScope("chat.turn");
    const tracer = provider.getTracer("test");

    scope.run(() => {
      expect(getCurrentSpan()?.context.spanId).toBe(scope.span.context.spanId);
      const child = tracer.startSpan("child");
      expect(child.parentSpanId).toBe(scope.span.context.spanId);
      child.end();
    });

    scope.end();
  });
});

describe("runWithSpan", () => {
  let provider: TracerProvider;

  beforeEach(() => {
    provider = new TracerProvider();
    setTracerProvider(provider);
  });

  it("sets active span synchronously for the duration of fn", () => {
    const tracer = provider.getTracer("test");
    const span = tracer.startSpan("sync.op");

    let capturedSpanId: string | undefined;
    runWithSpan(span, () => {
      capturedSpanId = getCurrentSpan()?.context.spanId;
    });

    expect(capturedSpanId).toBe(span.context.spanId);
    expect(getCurrentSpan()).toBeUndefined();
    span.end();
  });

  it("restores previous active span after fn completes", () => {
    const tracer = provider.getTracer("test");
    const outer = tracer.startSpan("outer");
    const inner = tracer.startSpan("inner");

    let innerActive: string | undefined;
    runWithSpan(outer, () => {
      runWithSpan(inner, () => {
        innerActive = getCurrentSpan()?.context.spanId;
      });
      expect(getCurrentSpan()?.context.spanId).toBe(outer.context.spanId);
    });

    expect(innerActive).toBe(inner.context.spanId);
    inner.end();
    outer.end();
  });
});

describe("runWithSpanAsync", () => {
  let provider: TracerProvider;

  beforeEach(() => {
    provider = new TracerProvider();
    setTracerProvider(provider);
  });

  it("sets active span for the duration of async fn", async () => {
    const tracer = provider.getTracer("test");
    const span = tracer.startSpan("async.op");

    let capturedSpanId: string | undefined;
    await runWithSpanAsync(span, async () => {
      capturedSpanId = getCurrentSpan()?.context.spanId;
    });

    expect(capturedSpanId).toBe(span.context.spanId);
    expect(getCurrentSpan()).toBeUndefined();
    span.end();
  });

  it("child spans created inside fn share the trace and have correct parent", async () => {
    const tracer = provider.getTracer("test");
    const parent = tracer.startSpan("parent");

    let child: ReturnType<typeof tracer.startSpan> | undefined;
    await runWithSpanAsync(parent, async () => {
      child = tracer.startSpan("child");
      child.end();
    });

    expect(child?.context.traceId).toBe(parent.context.traceId);
    expect(child?.parentSpanId).toBe(parent.context.spanId);
    parent.end();
  });
});

describe("Tracer nested startActiveSpan", () => {
  it("links implicit child to active parent", async () => {
    const provider = new TracerProvider();
    const tracer = provider.getTracer("test");

    await tracer.startActiveSpan("chat.turn", async (turn) => {
      const child = tracer.startSpan("llm.inference");
      expect(child.parentSpanId).toBe(turn.context.spanId);
      child.end();
    });
  });
});
