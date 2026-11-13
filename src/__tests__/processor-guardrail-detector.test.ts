import { GuardrailDetectorProcessor } from '../processor/guardrail-detector';

import * as detectors from '../guardrails/detectors';
import * as guardrails from '../guardrails';

jest.mock('../guardrails/detectors', () => ({
    detectAll: jest.fn()
}));

jest.mock('../guardrails', () => ({
    evaluateRun: jest.fn()
}));

describe('GuardrailDetectorProcessor', () => {
    let mockSpan: any;
    let processor: GuardrailDetectorProcessor;

    beforeEach(() => {
        processor = new GuardrailDetectorProcessor();

        mockSpan = {
            attributes: {},
            setAttribute: jest.fn(),
            context: {
                traceId: 'trace-1',
                spanId: 'span-1',
                traceState: 'some-state'
            },
            parentSpanId: 'parent-1' // Not root by default
        };

        jest.clearAllMocks();
    });

    it('should ignore if traceId is missing', () => {
        mockSpan.context.traceId = undefined;
        processor.onEnd(mockSpan);
        expect(detectors.detectAll).not.toHaveBeenCalled();
    });

    it('should detect findings and write them to span', () => {
        const mockFindings = [
            { id: 'f1', status: 'detected', category: 'toxicity' }
        ];
        (detectors.detectAll as jest.Mock).mockReturnValue(mockFindings);

        processor.onEnd(mockSpan);

        expect(detectors.detectAll).toHaveBeenCalledWith(
            {}, 'trace-1', 'span-1', true
        );
        expect(mockSpan.setAttribute).toHaveBeenCalledWith('guardrail.finding.count', 1);
        expect(mockSpan.setAttribute).toHaveBeenCalledWith('guardrail.findings', JSON.stringify(mockFindings));
    });

    it('should safely handle JSON stringify errors for findings', () => {
        const mockFindings = [{ id: 'f1' }];
        
        const cyclicObj: any = { id: 'f1' };
        cyclicObj.self = cyclicObj;
        mockFindings.push(cyclicObj); // Induce stringify error

        (detectors.detectAll as jest.Mock).mockReturnValue(mockFindings);

        // Spy on JSON.stringify
        const stringifySpy = jest.spyOn(JSON, 'stringify').mockImplementation(() => { throw new Error('cyclic'); });

        processor.onEnd(mockSpan);

        // finding.count should be written, but stringify failure handled silently
        expect(mockSpan.setAttribute).toHaveBeenCalledWith('guardrail.finding.count', 2);
        
        stringifySpy.mockRestore();
    });

    it('should compute summary on root span', () => {
        mockSpan.parentSpanId = undefined; // Make it root
        
        (detectors.detectAll as jest.Mock).mockReturnValue([]);
        
        const mockSummary = {
            detected_categories: ['toxicity'],
            triggered_categories: [],
            missing_categories: [
                { category: 'pii', why_required: 'test', missing_confidence: 'high', evidence_ref: 'none' }
            ],
            coverage_confidence: 'medium',
            capabilities_observed: ['text'],
            limitations: ['none']
        };

        (guardrails.evaluateRun as jest.Mock).mockReturnValue(mockSummary);

        processor.onEnd(mockSpan);

        expect(guardrails.evaluateRun).toHaveBeenCalled();
        expect(mockSpan.setAttribute).toHaveBeenCalledWith('guardrail.summary.detected_categories', ['toxicity']);
        expect(mockSpan.setAttribute).toHaveBeenCalledWith('guardrail.summary.missing_count', 1);
        expect(mockSpan.setAttribute).toHaveBeenCalledWith('guardrail.summary.coverage_confidence', 'medium');
        expect(mockSpan.setAttribute).toHaveBeenCalledWith('guardrail.summary', expect.any(String));
    });

    it('should write findings on root span from state', () => {
        // Child span finishes first
        const mockFindings = [{ id: 'f1', category: 'tox' }];
        (detectors.detectAll as jest.Mock).mockReturnValue(mockFindings);
        processor.onEnd(mockSpan);

        // Root span finishes second
        const rootSpan = {
            attributes: {},
            setAttribute: jest.fn(),
            context: {
                traceId: 'trace-1',
                spanId: 'span-2'
            },
            parentSpanId: undefined
        } as any;

        (detectors.detectAll as jest.Mock).mockReturnValue([]);
        
        (guardrails.evaluateRun as jest.Mock).mockReturnValue({
            detected_categories: [],
            triggered_categories: [],
            missing_categories: [],
            coverage_confidence: 'low',
            capabilities_observed: [],
            limitations: []
        });

        processor.onEnd(rootSpan);

        expect(rootSpan.setAttribute).toHaveBeenCalledWith('guardrail.findings', expect.stringContaining('tox'));
        expect(rootSpan.setAttribute).toHaveBeenCalledWith('guardrail.finding.count', 1);
    });

    it('safely handles evaluateRun exceptions', () => {
        mockSpan.parentSpanId = undefined;
        (detectors.detectAll as jest.Mock).mockReturnValue([]);
        (guardrails.evaluateRun as jest.Mock).mockImplementation(() => {
            throw new Error('Eval error');
        });

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
        
        processor.onEnd(mockSpan);
        
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('GuardrailDetectorProcessor.writeSummary failed'));
        warnSpy.mockRestore();
    });

    it('safely handles detectAll exceptions', () => {
        (detectors.detectAll as jest.Mock).mockImplementation(() => {
            throw new Error('Detect error');
        });

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
        
        processor.onEnd(mockSpan);
        
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('GuardrailDetectorProcessor.onEnd failed'));
        warnSpy.mockRestore();
    });

    it('implements shutdown and forceFlush', () => {
        // Add something to state
        processor.onEnd(mockSpan);
        
        // State should be clear after shutdown
        processor.shutdown();
        
        // Flush doesn't crash
        processor.forceFlush();
    });

    describe('root status from parent linkage and late children (TRC-295)', () => {
        it('does not classify child without tracestate as root when parentSpanId is present', () => {
            const childSpan = {
                attributes: {},
                setAttribute: jest.fn(),
                context: {
                    traceId: 'trace-no-tracestate',
                    spanId: 'child-1',
                    traceState: undefined
                },
                parentSpanId: 'root-1'
            } as any;

            const childFindings = [{ id: 'f-child', category: 'moderation' }];
            (detectors.detectAll as jest.Mock).mockReturnValue(childFindings);

            processor.onEnd(childSpan);

            expect(childSpan.setAttribute).toHaveBeenCalledWith('guardrail.finding.count', 1);
            expect(childSpan.setAttribute).toHaveBeenCalledWith('guardrail.findings', expect.stringContaining('moderation'));
            expect(childSpan.setAttribute).not.toHaveBeenCalledWith('guardrail.summary', expect.any(String));
            expect(childSpan.setAttribute).not.toHaveBeenCalledWith('guardrail.summary.detected_categories', expect.any(Array));
            expect(guardrails.evaluateRun).not.toHaveBeenCalled();
        });

        it('retains child aggregation until real root ends and writes summary on root', () => {
            const childSpan = {
                attributes: { 'llm.finish_reason': 'content_filter' },
                setAttribute: jest.fn(),
                context: {
                    traceId: 'trace-aggregation',
                    spanId: 'child-1',
                    traceState: undefined
                },
                parentSpanId: 'root-1'
            } as any;

            const rootSpan = {
                attributes: {},
                setAttribute: jest.fn(),
                context: {
                    traceId: 'trace-aggregation',
                    spanId: 'root-1',
                    traceState: undefined
                },
                parentSpanId: undefined
            } as any;

            const childFindings = [{ id: 'f-child', category: 'moderation', status: 'detected' }];
            (detectors.detectAll as jest.Mock).mockImplementation((_attrs, _traceId, spanId) => {
                if (spanId === 'child-1') return childFindings;
                return [];
            });

            const mockSummary = {
                detected_categories: ['moderation'],
                triggered_categories: ['moderation'],
                missing_categories: [],
                coverage_confidence: 'high',
                capabilities_observed: ['calls_llm'],
                limitations: []
            };
            (guardrails.evaluateRun as jest.Mock).mockReturnValue(mockSummary);

            processor.onEnd(childSpan);
            expect(childSpan.setAttribute).not.toHaveBeenCalledWith('guardrail.summary', expect.any(String));

            processor.onEnd(rootSpan);

            expect(guardrails.evaluateRun).toHaveBeenCalledWith(expect.objectContaining({
                findings: expect.arrayContaining([expect.objectContaining({ id: 'f-child' })])
            }));
            expect(rootSpan.setAttribute).toHaveBeenCalledWith('guardrail.summary', expect.any(String));
            expect(rootSpan.setAttribute).toHaveBeenCalledWith('guardrail.summary.detected_categories', ['moderation']);
            expect(rootSpan.setAttribute).toHaveBeenCalledWith('guardrail.summary.coverage_confidence', 'high');
            expect(rootSpan.setAttribute).toHaveBeenCalledWith('guardrail.findings', expect.stringContaining('f-child'));
            expect(rootSpan.setAttribute).toHaveBeenCalledWith('guardrail.finding.count', 1);
        });

        it('explicitly accommodates late children ending after the root has ended', () => {
            const rootSpan = {
                attributes: {},
                setAttribute: jest.fn(),
                context: {
                    traceId: 'trace-late',
                    spanId: 'root-1',
                    traceState: undefined
                },
                parentSpanId: undefined
            } as any;

            const lateChildSpan = {
                attributes: { 'llm.finish_reason': 'content_filter' },
                setAttribute: jest.fn(),
                context: {
                    traceId: 'trace-late',
                    spanId: 'child-late',
                    traceState: undefined
                },
                parentSpanId: 'root-1'
            } as any;

            const lateFindings = [{ id: 'f-late', category: 'moderation' }];
            (detectors.detectAll as jest.Mock).mockImplementation((_attrs, _traceId, spanId) => {
                if (spanId === 'child-late') return lateFindings;
                return [];
            });

            const initialSummary = {
                detected_categories: [],
                triggered_categories: [],
                missing_categories: [],
                coverage_confidence: 'low',
                capabilities_observed: [],
                limitations: []
            };
            const updatedSummary = {
                detected_categories: ['moderation'],
                triggered_categories: ['moderation'],
                missing_categories: [],
                coverage_confidence: 'high',
                capabilities_observed: ['calls_llm'],
                limitations: []
            };

            (guardrails.evaluateRun as jest.Mock)
                .mockReturnValueOnce(initialSummary)
                .mockReturnValueOnce(updatedSummary);

            processor.onEnd(rootSpan);
            expect(rootSpan.setAttribute).toHaveBeenCalledWith('guardrail.summary.coverage_confidence', 'low');

            processor.onEnd(lateChildSpan);

            expect(lateChildSpan.setAttribute).toHaveBeenCalledWith('guardrail.finding.count', 1);
            expect(lateChildSpan.setAttribute).not.toHaveBeenCalledWith('guardrail.summary', expect.any(String));

            expect(rootSpan.setAttribute).toHaveBeenCalledWith('guardrail.summary.detected_categories', ['moderation']);
            expect(rootSpan.setAttribute).toHaveBeenCalledWith('guardrail.summary.coverage_confidence', 'high');
            expect(rootSpan.setAttribute).toHaveBeenCalledWith('guardrail.finding.count', 1);
            expect(rootSpan.setAttribute).toHaveBeenCalledWith('guardrail.findings', expect.stringContaining('f-late'));
        });

        it('bounds memory to MAX_TRACES by evicting oldest traces', () => {
            for (let i = 0; i < 10005; i++) {
                const span = {
                    attributes: {},
                    setAttribute: jest.fn(),
                    context: {
                        traceId: `trace-b-${i}`,
                        spanId: `span-${i}`
                    },
                    parentSpanId: undefined
                } as any;
                (detectors.detectAll as jest.Mock).mockReturnValue([]);
                (guardrails.evaluateRun as jest.Mock).mockReturnValue({
                    detected_categories: [],
                    triggered_categories: [],
                    missing_categories: [],
                    coverage_confidence: 'low',
                    capabilities_observed: [],
                    limitations: []
                });
                processor.onEnd(span);
            }

            expect(processor.getTraceCount()).toBeLessThanOrEqual(10000);
        });
    });
});
