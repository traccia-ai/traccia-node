import { observe } from '../instrumentation/decorator';
import { applySkipArgs, parameterNames } from '../instrumentation/skip-args';

const mockSpan = {
    setAttribute: jest.fn(),
    recordException: jest.fn(),
    end: jest.fn(),
    status: 0,
};

const mockTracer = {
    startActiveSpan: jest.fn((_name, fn) => fn(mockSpan)),
};

jest.mock('../auto', () => ({
    getTracer: jest.fn(() => mockTracer),
}));

/** The parsed `function.args` attribute recorded on the mock span. */
function recordedArgs(): unknown[] {
    const call = mockSpan.setAttribute.mock.calls.find(([key]) => key === 'function.args');
    expect(call).toBeDefined();
    return JSON.parse(call![1] as string);
}

describe('observe({ skipArgs })', () => {
    beforeEach(() => jest.clearAllMocks());

    it('drops a skipped key from a single object argument', async () => {
        const fn = jest.fn(async (_input: { query: string; apiKey: string }) => 'ok');
        const wrapped = observe({ skipArgs: ['apiKey'] })(fn);

        await wrapped({ query: 'weather', apiKey: 'sk-secret' });

        expect(recordedArgs()).toEqual([{ query: 'weather' }]);
        expect(JSON.stringify(mockSpan.setAttribute.mock.calls)).not.toContain('sk-secret');
        // The function itself still gets the full argument.
        expect(fn).toHaveBeenCalledWith({ query: 'weather', apiKey: 'sk-secret' });
    });

    it('drops skipped positional arguments by parameter name', async () => {
        const wrapped = observe({ skipArgs: ['token', 'email'] })(
            async (userId: string, token: string, email: string, limit: number) =>
                `${userId}${token}${email}${limit}`
        );

        await wrapped('u1', 'tok-123', 'a@b.c', 5);

        expect(recordedArgs()).toEqual(['u1', 5]);
    });

    it('drops positional arguments of a decorated method', async () => {
        class Client {
            @observe({ skipArgs: ['password'] })
            async login(user: string, password: string) {
                return `${user}:${password.length}`;
            }
        }

        await expect(new Client().login('ada', 'hunter2')).resolves.toBe('ada:7');
        expect(recordedArgs()).toEqual(['ada']);
    });

    it('records everything when skipArgs names nothing present', async () => {
        const wrapped = observe({ skipArgs: ['missing'] })(
            async (a: number, opts: { b: number }) => a + opts.b
        );

        await wrapped(1, { b: 2 });

        expect(recordedArgs()).toEqual([1, { b: 2 }]);
    });

    it('leaves nested values with a skipped name alone', async () => {
        const wrapped = observe({ skipArgs: ['token'] })(
            async (_input: { auth: { token: string }; query: string }) => 'ok'
        );

        await wrapped({ auth: { token: 'nested' }, query: 'q' });

        expect(recordedArgs()).toEqual([{ auth: { token: 'nested' }, query: 'q' }]);
    });

    it('records every argument when skipArgs is not set', async () => {
        const wrapped = observe({})(async (token: string) => token);

        await wrapped('visible');

        expect(recordedArgs()).toEqual(['visible']);
    });
});

describe('parameterNames', () => {
    const names = (fn: unknown) => parameterNames(fn).map((p) => p && (p.rest ? `...${p.name}` : p.name));

    it('reads plain, default, rest and destructured parameters', () => {
        /* eslint-disable @typescript-eslint/no-unused-vars */
        function f(a: number, b = '(,)', { c }: { c: number } = { c: 1 }, ...rest: unknown[]) {
            return a;
        }
        /* eslint-enable @typescript-eslint/no-unused-vars */
        expect(names(f)).toEqual(['a', 'b', null, '...rest']);
    });

    it('reads arrow functions with and without parentheses', () => {
        expect(names(new Function('return x => x')())).toEqual(['x']);
        expect(names(new Function('return async y => y')())).toEqual(['y']);
        expect(names(new Function('return async (p, q) => p')())).toEqual(['p', 'q']);
    });

    it('ignores comments and returns nothing for native code', () => {
        expect(names(new Function('return function (/* a, */ b /* c */) {}')())).toEqual(['b']);
        expect(names(Math.max)).toEqual([]);
        expect(names(undefined)).toEqual([]);
    });
});

describe('applySkipArgs', () => {
    it('drops every argument collected by a skipped rest parameter', () => {
        const params = [{ name: 'a', rest: false }, { name: 'more', rest: true }];
        expect(applySkipArgs([1, 2, 3], ['more'], params)).toEqual([1]);
    });

    it('keeps arguments past the declared list when no rest parameter owns them', () => {
        const params = [{ name: 'a', rest: false }];
        expect(applySkipArgs([1, 2], ['a'], params)).toEqual([2]);
    });

    it('does not strip keys when there is more than one argument', () => {
        const arg = { secret: 1 };
        expect(applySkipArgs([arg, 2], ['secret'], [])).toEqual([{ secret: 1 }, 2]);
    });

    it('does not mutate the caller\'s arguments', () => {
        const arg = { keep: 1, drop: 2 };
        const args = [arg];
        expect(applySkipArgs(args, ['drop'], [])).toEqual([{ keep: 1 }]);
        expect(arg).toEqual({ keep: 1, drop: 2 });
        expect(args).toEqual([arg]);
    });
});
