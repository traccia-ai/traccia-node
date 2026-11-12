import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { init, stopTracing, runWithAutoTrace } from '../auto';
import { observe } from '../instrumentation/decorator';
import { ISpan, ISpanExporter } from '../types';

// TRC-359: init() starts no root trace, so each top-level call is its own trace.
describe('trace grouping', () => {
    let spans: ISpan[];
    const exporter: ISpanExporter = {
        export: (batch) => {
            spans.push(...batch);
            return true;
        },
        shutdown: () => undefined,
    };

    // observe() wrappers are async: await them before stopTracing().
    const inner = observe({ name: 'inner' })((i: number) => i);
    const run = observe({ name: 'run' })((i: number) => inner(i));

    // Isolated from this machine: no traccia.toml in cwd or HOME, no TRACCIA_* / AGENT_DASHBOARD_* variables
    // (a developer's TRACCIA_SAMPLE_RATE=0 would otherwise drop every span).
    const savedEnv = { ...process.env };
    const savedCwd = process.cwd();
    let tmp: string;

    beforeAll(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traccia-grouping-'));
        for (const key of Object.keys(process.env)) {
            if (key.startsWith('TRACCIA_') || key.startsWith('AGENT_DASHBOARD_')) delete process.env[key];
        }
        process.env.HOME = tmp;
        process.env.USERPROFILE = tmp;
        process.chdir(tmp);
    });

    beforeEach(async () => {
        await stopTracing();
        spans = [];
        await init({ exporter, loadEnv: false });
    });

    afterAll(async () => {
        await stopTracing();
        process.chdir(savedCwd);
        process.env = savedEnv;
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    const named = (name: string) => spans.filter((s) => s.name === name);

    it('gives each top-level call its own trace, with no root span', async () => {
        for (let i = 0; i < 3; i++) await run(i);
        await stopTracing();

        expect(spans).toHaveLength(6);
        const runs = named('run');
        expect(runs).toHaveLength(3);
        expect(named('inner')).toHaveLength(3);
        expect(runs.every((s) => !s.parentSpanId)).toBe(true);
        expect(new Set(runs.map((s) => s.context.traceId)).size).toBe(3);
        // Nested calls stay in their caller's trace.
        for (const s of named('inner')) {
            const parent = runs.find((r) => r.context.spanId === s.parentSpanId);
            expect(parent).toBeDefined();
            expect(s.context.traceId).toBe(parent!.context.traceId);
        }
    });

    it('runWithAutoTrace groups calls into one trace under its root span', async () => {
        await runWithAutoTrace('run-group', async () => {
            for (let i = 0; i < 3; i++) await run(i);
        });
        await stopTracing();

        expect(spans).toHaveLength(7);
        const roots = named('run-group');
        expect(roots).toHaveLength(1);
        const [root] = roots;
        expect(root.parentSpanId).toBeFalsy();
        expect(new Set(spans.map((s) => s.context.traceId))).toEqual(new Set([root.context.traceId]));
        const runs = named('run');
        expect(runs).toHaveLength(3);
        expect(runs.map((s) => s.parentSpanId)).toEqual([root.context.spanId, root.context.spanId, root.context.spanId]);
        const inners = named('inner');
        expect(inners).toHaveLength(3);
        expect(inners.map((s) => s.parentSpanId).sort()).toEqual(runs.map((s) => s.context.spanId).sort());
    });
});
