import { install } from '../integrations/crewai';

// Mock dependencies
const mockTracer = {
  startSpan: jest.fn().mockImplementation(() => {
    return {
      setAttribute: jest.fn(),
      end: jest.fn(),
    };
  }),
};

jest.mock('../index', () => ({
  getTracer: jest.fn().mockReturnValue(mockTracer),
}));

describe('crewai integration', () => {
  let originalCrewai: any;
  let mockCrew: any;
  let mockTask: any;
  let mockAgent: any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    mockCrew = {
      prototype: {
        kickoff: jest.fn().mockReturnValue('sync kickoff result'),
        kickoffAsync: jest.fn().mockResolvedValue('async kickoff result'),
      }
    };

    mockTask = {
      prototype: {
        execute_sync: jest.fn().mockReturnValue('task result'),
      }
    };

    mockAgent = {
      prototype: {
        execute_task: jest.fn().mockReturnValue('agent result'),
      }
    };

    originalCrewai = {
      Crew: mockCrew,
      Task: mockTask,
      Agent: mockAgent,
    };

    jest.mock('crewai', () => originalCrewai, { virtual: true });
    
    // reset module state
    jest.isolateModules(() => {
      // do nothing, we just want to ensure instrumented = false
    });
  });

  it('should return false if enabled is false', () => {
    const result = install(false);
    expect(result).toBe(false);
  });

  it('should return true if already instrumented', () => {
    const { install: isolatedInstall } = require('../integrations/crewai');
    isolatedInstall(true);
    const result = isolatedInstall(true);
    expect(result).toBe(true);
  });

  it('should return false if crewai is not installed', () => {
    jest.unmock('crewai');
    jest.mock('crewai', () => {
      throw new Error('Cannot find module');
    }, { virtual: true });
    
    const { install: isolatedInstall } = require('../integrations/crewai');
    const result = isolatedInstall();
    expect(result).toBe(false);
  });

  it('should wrap Crew.prototype.kickoff', () => {
    const { install: isolatedInstall } = require('../integrations/crewai');
    isolatedInstall();

    const crewInstance = Object.create(mockCrew.prototype);
    crewInstance.id = 'test-crew-id';

    const result = crewInstance.kickoff();
    
    expect(result).toBe('sync kickoff result');
    expect(mockTracer.startSpan).toHaveBeenCalledWith('crewai.crew.kickoff', expect.objectContaining({
      'crewai.crew.id': 'test-crew-id',
      'crewai.type': 'crew'
    }));
  });

  it('should wrap Crew.prototype.kickoffAsync', async () => {
    const { install: isolatedInstall } = require('../integrations/crewai');
    isolatedInstall();

    const crewInstance = Object.create(mockCrew.prototype);
    crewInstance.id = 'test-crew-async-id';

    const result = await crewInstance.kickoffAsync();
    
    expect(result).toBe('async kickoff result');
    expect(mockTracer.startSpan).toHaveBeenCalledWith('crewai.crew.kickoff_async', expect.objectContaining({
      'crewai.crew.id': 'test-crew-async-id'
    }));
  });

  it('should trace exceptions in Crew kickoff', () => {
    const { install: isolatedInstall } = require('../integrations/crewai');
    mockCrew.prototype.kickoff.mockImplementation(() => {
      throw new Error('kickoff error');
    });
    isolatedInstall();

    const crewInstance = Object.create(mockCrew.prototype);
    
    expect(() => crewInstance.kickoff()).toThrow('kickoff error');
  });

  it('should wrap Task.prototype.execute_sync', () => {
    const { install: isolatedInstall } = require('../integrations/crewai');
    isolatedInstall();

    const taskInstance = Object.create(mockTask.prototype);
    taskInstance.id = 'test-task-id';
    taskInstance.name = 'test-task-name';

    const result = taskInstance.execute_sync();
    
    expect(result).toBe('task result');
    expect(mockTracer.startSpan).toHaveBeenCalledWith('crewai.task.test-task-name', expect.objectContaining({
      'crewai.task.id': 'test-task-id',
      'crewai.type': 'task',
      'crewai.task.name': 'test-task-name'
    }));
  });

  it('should trace exceptions in Task execution', () => {
    const { install: isolatedInstall } = require('../integrations/crewai');
    mockTask.prototype.execute_sync.mockImplementation(() => {
      throw new Error('task error');
    });
    isolatedInstall();

    const taskInstance = Object.create(mockTask.prototype);
    
    expect(() => taskInstance.execute_sync()).toThrow('task error');
  });

  it('should wrap Agent.prototype.execute_task', () => {
    const { install: isolatedInstall } = require('../integrations/crewai');
    isolatedInstall();

    const agentInstance = Object.create(mockAgent.prototype);
    agentInstance.id = 'test-agent-id';
    agentInstance.role = 'test-agent-role';

    const result = agentInstance.execute_task();
    
    expect(result).toBe('agent result');
    expect(mockTracer.startSpan).toHaveBeenCalledWith('crewai.agent.test-agent-role', expect.objectContaining({
      'crewai.agent.id': 'test-agent-id',
      'crewai.type': 'agent',
      'crewai.agent.role': 'test-agent-role'
    }));
  });

  it('should trace exceptions in Agent execution', () => {
    const { install: isolatedInstall } = require('../integrations/crewai');
    mockAgent.prototype.execute_task.mockImplementation(() => {
      throw new Error('agent error');
    });
    isolatedInstall();

    const agentInstance = Object.create(mockAgent.prototype);
    
    expect(() => agentInstance.execute_task()).toThrow('agent error');
  });
});
