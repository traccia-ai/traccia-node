import { AgentEnrichmentProcessor } from '../processor/agent-enricher';
import { ISpan } from '../types';
import * as fs from 'fs';

jest.mock('fs');
jest.mock('../processor/cost-processor', () => ({
    computeCost: jest.fn((model, p, c) => (p + c) * 0.01)
}));

describe('AgentEnrichmentProcessor', () => {
    let mockSpan: ISpan;

    beforeEach(() => {
        mockSpan = {
            attributes: {},
            setAttribute: jest.fn((key, val) => {
                mockSpan.attributes![key] = val;
            })
        } as unknown as ISpan;
        
        jest.clearAllMocks();
        delete process.env.AGENT_DASHBOARD_AGENT_ID;
        delete process.env.AGENT_DASHBOARD_ENV;
    });

    it('loads catalog from file format 1', () => {
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({
            agents: [
                { id: 'agent-1', name: 'Agent One' }
            ]
        }));

        const processor = new AgentEnrichmentProcessor({ agentConfigPath: 'test.json' });
        processor.onEnd(mockSpan);

        expect(fs.readFileSync).toHaveBeenCalledWith('test.json', 'utf-8');
    });

    it('loads catalog from file format 2', () => {
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({
            'agent-2': { name: 'Agent Two' }
        }));

        const processor = new AgentEnrichmentProcessor({ agentConfigPath: 'test.json' });
        
        mockSpan.attributes = { 'agent.id': 'agent-2' };
        processor.onEnd(mockSpan);

        expect(mockSpan.setAttribute).toHaveBeenCalledWith('agent.name', 'Agent Two');
    });

    it('handles missing config file safely', () => {
        (fs.existsSync as jest.Mock).mockReturnValue(false);
        const processor = new AgentEnrichmentProcessor({ agentConfigPath: 'missing.json' });
        
        mockSpan.attributes = { 'agent.id': 'agent-1' };
        processor.onEnd(mockSpan);
        
        expect(mockSpan.setAttribute).toHaveBeenCalledWith('agent.name', 'agent-1');
    });

    it('enriches span with catalog metadata', () => {
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({
            'agent-1': { 
                name: 'Test Agent',
                type: 'custom',
                description: 'A test agent',
                owner: 'tester',
                team: 'qa',
                org_id: 'org1',
                sub_org_id: 'sub1',
                env: 'staging',
                consuming_teams: ['dev']
            }
        }));

        const processor = new AgentEnrichmentProcessor({ agentConfigPath: 'test.json' });
        mockSpan.attributes = { 'agent.id': 'agent-1' };
        processor.onEnd(mockSpan);

        expect(mockSpan.setAttribute).toHaveBeenCalledWith('agent.name', 'Test Agent');
        expect(mockSpan.setAttribute).toHaveBeenCalledWith('agent.type', 'custom');
        expect(mockSpan.setAttribute).toHaveBeenCalledWith('agent.description', 'A test agent');
        expect(mockSpan.setAttribute).toHaveBeenCalledWith('owner', 'tester');
        expect(mockSpan.setAttribute).toHaveBeenCalledWith('team', 'qa');
        expect(mockSpan.setAttribute).toHaveBeenCalledWith('org.id', 'org1');
        expect(mockSpan.setAttribute).toHaveBeenCalledWith('sub_org.id', 'sub1');
        expect(mockSpan.setAttribute).toHaveBeenCalledWith('env', 'staging');
        expect(mockSpan.setAttribute).toHaveBeenCalledWith('environment', 'staging');
        expect(mockSpan.setAttribute).toHaveBeenCalledWith('agent.consuming_teams', ['dev']);
    });

    it('skips enrichment if orchestrator serviceRole', () => {
        const processor = new AgentEnrichmentProcessor({ serviceRole: 'orchestrator' });
        mockSpan.attributes = { 'agent.id': 'agent-1' };
        processor.onEnd(mockSpan);
        expect(mockSpan.setAttribute).not.toHaveBeenCalled();
    });

    it('uses single agent id if only one in catalog', () => {
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({
            'only-agent': { name: 'Only Agent' }
        }));

        const processor = new AgentEnrichmentProcessor({ agentConfigPath: 'test.json' });
        processor.onEnd(mockSpan);

        expect(mockSpan.setAttribute).toHaveBeenCalledWith('agent.id', 'only-agent');
        expect(mockSpan.setAttribute).toHaveBeenCalledWith('agent.name', 'Only Agent');
    });

    it('computes cost if tokens and model are present', () => {
        const processor = new AgentEnrichmentProcessor({ defaultAgentId: 'agent-1' });
        mockSpan.attributes = {
            'llm.model': 'gpt-4',
            'llm.usage.prompt_tokens': 100,
            'llm.usage.completion_tokens': 50
        };

        processor.onEnd(mockSpan);
        expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.cost.usd', 1.5);
    });

    it('infers span type LLM or TOOL', () => {
        const processor = new AgentEnrichmentProcessor({ defaultAgentId: 'agent-1' });
        
        mockSpan.attributes = { 'llm.model': 'gpt-4' };
        processor.onEnd(mockSpan);
        expect(mockSpan.setAttribute).toHaveBeenCalledWith('span.type', 'LLM');

        jest.clearAllMocks();
        mockSpan.attributes = { 'tool.name': 'search' };
        processor.onEnd(mockSpan);
        expect(mockSpan.setAttribute).toHaveBeenCalledWith('span.type', 'TOOL');
    });

    it('implements shutdown and forceFlush', async () => {
        const processor = new AgentEnrichmentProcessor();
        processor.onStart(mockSpan);
        await expect(processor.shutdown()).resolves.toBeUndefined();
        await expect(processor.forceFlush()).resolves.toBeUndefined();
    });
});
