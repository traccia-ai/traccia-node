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
});
