/**
 * Regression and verification test suite for Audit Finding 19 (2026-10-09).
 *
 * Covers:
 * 1. Native OTel child inside active Traccia span shares trace and parent.
 * 2. Express and Fastify middlewares extract incoming W3C trace context and make
 *    request span active for next() / hookDone().
 * 3. Explicit parent traceFlags=0 is preserved (not coerced to 1 via || 1)
 *    and tracestate is propagated.
 */

import { trace } from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { TracerProvider } from '../tracer/provider';
import { getCurrentSpan, runWithSpan, spanScope } from '../context';
import { expressMiddleware } from '../instrumentation/express';
import { fastifyPlugin } from '../instrumentation/fastify';
import { ISpan } from '../types';

describe('Audit Finding 19: OTel Context Bridging and W3C Propagation', () => {
  let basicProvider: BasicTracerProvider;
  let tracciaProvider: TracerProvider;

  beforeAll(() => {
    basicProvider = new BasicTracerProvider();
    trace.setGlobalTracerProvider(basicProvider);
  });

  beforeEach(() => {
    tracciaProvider = new TracerProvider();
  });

  describe('Reproduction 1: Active Traccia span bridges to OTel context', () => {
    it('native OTel child inside active Traccia span shares trace and parent span', async () => {
      const tracer = tracciaProvider.getTracer('test-bridge');

      await tracer.startActiveSpan('traccia-active', async (activeSpan) => {
        expect(getCurrentSpan()).toBe(activeSpan);

        // Active OTel span matches the Traccia span's underlying OTel span
        const activeOtelSpan = trace.getActiveSpan();
        expect(activeOtelSpan).toBeDefined();
        expect(activeOtelSpan?.spanContext().spanId).toBe(activeSpan.context.spanId);
        expect(activeOtelSpan?.spanContext().traceId).toBe(activeSpan.context.traceId);

        // Native OTel child created inside active Traccia span
        const nativeTracer = trace.getTracer('native-lib');
        const nativeChild = nativeTracer.startSpan('native-child');

        try {
          const childCtx = nativeChild.spanContext();
          expect(childCtx.traceId).toBe(activeSpan.context.traceId);
          expect((nativeChild as any).parentSpanContext?.spanId).toBe(activeSpan.context.spanId);
        } finally {
          nativeChild.end();
        }
      });
    });

    it('spanScope.run and spanScope.runAsync bridge to OTel context', async () => {
      const scope = spanScope('scope-parent', { tracerName: 'scope-tracer' });
      const parentSpan = scope.span;

      // Synchronous run
      scope.run(() => {
        const nativeTracer = trace.getTracer('native-sync');
        const nativeChild = nativeTracer.startSpan('native-child-sync');
        try {
          expect(nativeChild.spanContext().traceId).toBe(parentSpan.context.traceId);
          expect((nativeChild as any).parentSpanContext?.spanId).toBe(parentSpan.context.spanId);
        } finally {
          nativeChild.end();
        }
      });

      // Asynchronous run
      await scope.runAsync(async () => {
        const nativeTracer = trace.getTracer('native-async');
        const nativeChild = nativeTracer.startSpan('native-child-async');
        try {
          expect(nativeChild.spanContext().traceId).toBe(parentSpan.context.traceId);
          expect((nativeChild as any).parentSpanContext?.spanId).toBe(parentSpan.context.spanId);
        } finally {
          nativeChild.end();
        }
      });

      scope.end();
    });
  });

  describe('Reproduction 2: Express & Fastify middleware extract W3C context & activate span', () => {
    it('Express middleware extracts incoming traceparent and makes request span active for next()', (done) => {
      const incomingTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
      const incomingSpanId = '00f067aa0ba902b7';
      const incomingTraceState = 'rojo=1,congo=2';
      const traceparent = `00-${incomingTraceId}-${incomingSpanId}-01`;

      const req: any = {
        method: 'GET',
        url: '/api/resource',
        path: '/api/resource',
        headers: {
          traceparent,
          tracestate: incomingTraceState,
        },
      };

      const res: any = {
        statusCode: 200,
        on: jest.fn(),
      };

      const middleware = expressMiddleware();

      middleware(req, res, () => {
        try {
          // Request span should be stored on request
          const requestSpan = req._tracciaSpan;
          expect(requestSpan).toBeDefined();
          expect(requestSpan.context.traceId).toBe(incomingTraceId);
          expect(requestSpan.parentSpanId).toBe(incomingSpanId);

          // Request span should be active in context during next()
          expect(getCurrentSpan()).toBe(requestSpan);

          // A Traccia child span created inside handler inherits trace and request parent
          const tracer = tracciaProvider.getTracer('express-handler');
          const handlerSpan = tracer.startSpan('handler-operation');
          expect(handlerSpan.context.traceId).toBe(incomingTraceId);
          expect(handlerSpan.parentSpanId).toBe(requestSpan.context.spanId);
          handlerSpan.end();

          // A native OTel child span created inside handler also inherits trace and request parent
          const nativeTracer = trace.getTracer('native-db');
          const nativeChild = nativeTracer.startSpan('db-query');
          expect(nativeChild.spanContext().traceId).toBe(incomingTraceId);
          expect((nativeChild as any).parentSpanContext?.spanId).toBe(requestSpan.context.spanId);
          nativeChild.end();

          done();
        } catch (error) {
          done(error);
        }
      });
    });

    it('Fastify plugin extracts incoming traceparent and makes request span active for hookDone()', (done) => {
      const incomingTraceId = '5cb73e4688b44ea7b4df838e1f1f5847';
      const incomingSpanId = '11a178bb1ca013c8';
      const traceparent = `00-${incomingTraceId}-${incomingSpanId}-01`;

      const hooks: Record<string, Function> = {};
      const mockFastify: any = {
        addHook: jest.fn((name, handler) => {
          hooks[name] = handler;
        }),
      };

      const plugin = fastifyPlugin();
      plugin(mockFastify, {}, () => {});

      const req: any = {
        method: 'POST',
        url: '/items',
        routerPath: '/items',
        headers: {
          traceparent,
        },
      };

      hooks['onRequest'](req, {}, () => {
        try {
          const requestSpan = req._tracciaSpan;
          expect(requestSpan).toBeDefined();
          expect(requestSpan.context.traceId).toBe(incomingTraceId);
          expect(requestSpan.parentSpanId).toBe(incomingSpanId);

          // Active in context
          expect(getCurrentSpan()).toBe(requestSpan);

          const tracer = tracciaProvider.getTracer('fastify-handler');
          const handlerSpan = tracer.startSpan('save-item');
          expect(handlerSpan.context.traceId).toBe(incomingTraceId);
          expect(handlerSpan.parentSpanId).toBe(requestSpan.context.spanId);
          handlerSpan.end();

          done();
        } catch (error) {
          done(error);
        }
      });
    });
  });

  describe('Reproduction 3: Explicit parent traceFlags=0 and tracestate preservation', () => {
    it('preserves traceFlags=0 and tracestate when parentContext has traceFlags=0', () => {
      const tracer = tracciaProvider.getTracer('test-flags');
      const parentContext = {
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        spanId: '00f067aa0ba902b7',
        traceFlags: 0, // Unsampled
        traceState: 'vendor1=val1,vendor2=val2',
      };

      const child = tracer.startSpan('child-unsampled', { parentContext });

      expect(child.context.traceId).toBe(parentContext.traceId);
      expect(child.parentSpanId).toBe(parentContext.spanId);
      expect(child.context.traceFlags).toBe(0); // Must remain 0, NOT become 1
      expect(child.context.traceState).toBe('vendor1=val1,vendor2=val2');
      child.end();
    });

    it('preserves traceFlags=0 and tracestate when options.parent has traceFlags=0', () => {
      const tracer = tracciaProvider.getTracer('test-flags-parent');

      // Create a mock parent ISpan with unsampled flag and tracestate
      const parentSpan: ISpan = {
        context: {
          traceId: '7af83e4688b44ea7b4df838e1f1f5847',
          spanId: '22b278bb1ca013c9',
          traceFlags: 0,
          traceState: 'congo=uc,rojo=plain',
        },
        name: 'mock-parent',
        attributes: {},
        events: [],
        status: 0,
        startTimeNs: 0,
        durationNs: undefined,
        setAttribute: jest.fn(),
        addEvent: jest.fn(),
        end: jest.fn(),
        recordException: jest.fn(),
        isRecording: () => false,
      };

      const child = tracer.startSpan('child-from-parent', { parent: parentSpan });

      expect(child.context.traceId).toBe(parentSpan.context.traceId);
      expect(child.parentSpanId).toBe(parentSpan.context.spanId);
      expect(child.context.traceFlags).toBe(0); // Must remain 0
      expect(child.context.traceState).toBe('congo=uc,rojo=plain');
      child.end();
    });

    it('preserves traceFlags=0 and tracestate when active parent has traceFlags=0', () => {
      const tracer = tracciaProvider.getTracer('test-active-flags');

      const parentSpan: ISpan = {
        context: {
          traceId: '9af83e4688b44ea7b4df838e1f1f5847',
          spanId: '33b278bb1ca013c9',
          traceFlags: 0,
          traceState: 'alpha=one',
        },
        name: 'active-unsampled-parent',
        attributes: {},
        events: [],
        status: 0,
        startTimeNs: 0,
        durationNs: undefined,
        setAttribute: jest.fn(),
        addEvent: jest.fn(),
        end: jest.fn(),
        recordException: jest.fn(),
        isRecording: () => false,
      };

      runWithSpan(parentSpan, () => {
        const child = tracer.startSpan('child-auto-parent');
        expect(child.context.traceId).toBe(parentSpan.context.traceId);
        expect(child.parentSpanId).toBe(parentSpan.context.spanId);
        expect(child.context.traceFlags).toBe(0);
        expect(child.context.traceState).toBe('alpha=one');
        child.end();
      });
    });
  });
});
