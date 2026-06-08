
import { observe } from '../instrumentation/decorator';

// Mock getTracer and Span
const mockSpan = {
    setAttribute: jest.fn(),
    recordException: jest.fn(),
    end: jest.fn(),
    status: 0,
};

const mockTracer = {
    startActiveSpan: jest.fn((name, fn) => fn(mockSpan)),
};

jest.mock('../auto', () => ({
    getTracer: jest.fn(() => mockTracer),
}));

describe('@observe Decorator with Tags', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should add tags to span attributes when provided', async () => {
        const original = async () => 'result';
        const wrapped = observe({
            name: 'tagged-function',
            tags: ['test-tag', 'another-tag']
        })(original);

        await wrapped();

        expect(mockTracer.startActiveSpan).toHaveBeenCalledWith('tagged-function', expect.any(Function));
        // Verify span.tags attribute is set with the array of tags
        expect(mockSpan.setAttribute).toHaveBeenCalledWith('span.tags', ['test-tag', 'another-tag']);
        expect(mockSpan.end).toHaveBeenCalled();
    });

    it('should not add span.tags attribute when tags are empty or undefined', async () => {
        const original = async () => 'result';
        const wrapped = observe({
            name: 'no-tags-function'
        })(original);

        await wrapped();

        expect(mockTracer.startActiveSpan).toHaveBeenCalledWith('no-tags-function', expect.any(Function));
        // Verify span.tags is NOT called
        expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('span.tags', expect.anything());
        expect(mockSpan.end).toHaveBeenCalled();
    });
});
