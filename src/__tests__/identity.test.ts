import { AgentIdentity } from '../identity';

describe('AgentIdentity', () => {
  it('should construct with valid attributes', () => {
    const identity = new AgentIdentity({ id: 'agent-1', name: 'My Agent', type: 'workflow', env: 'test', project: 'proj-A' });
    expect(identity.id).toBe('agent-1');
    expect(identity.name).toBe('My Agent');
    expect(identity.type).toBe('workflow');
    expect(identity.env).toBe('test');
    expect(identity.project).toBe('proj-A');
  });

  it('should generate valid OTel resource attributes', () => {
    const identity = new AgentIdentity({ id: 'agent-1', name: 'My Agent', type: 'workflow', env: 'test', project: 'proj-A' });
    const attrs = identity.toResourceAttributes();
    
    expect(attrs['agent.id']).toBe('agent-1');
    expect(attrs['agent.name']).toBe('My Agent');
    expect(attrs['env']).toBe('test');
    expect(attrs['project.id']).toBe('proj-A');
  });

  it('should omit undefined values from resource attributes', () => {
    const identity = new AgentIdentity({ id: 'agent-1' });
    const attrs = identity.toResourceAttributes();
    
    expect(attrs['agent.id']).toBe('agent-1');
    expect(attrs['agent.name']).toBeUndefined();
    expect(attrs['env']).toBeUndefined();
  });

  it('should throw ValidationError on invalid type', () => {
    expect(() => {
      // @ts-ignore
      new AgentIdentity({ id: 'agent-1', type: 'invalid_type' });
    }).toThrow('Invalid AgentIdentity configuration');
  });

  it('should validate serviceRole', () => {
    const identity = new AgentIdentity({ id: 'agent-1', serviceRole: 'orchestrator' });
    expect(identity.serviceRole).toBe('orchestrator');
    const attrs = identity.toResourceAttributes();
    expect(attrs['traccia.service_role']).toBe('orchestrator');
  });
});
