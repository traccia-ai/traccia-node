import { resolveServiceName } from '../config/service-name';

describe('resolveServiceName', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OTEL_SERVICE_NAME;
    delete process.env.SERVICE_NAME;
    delete process.env.TRACCIA_SERVICE_NAME;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('prefers explicit override', () => {
    expect(resolveServiceName('my-service')).toBe('my-service');
  });

  it('falls back to OTEL_SERVICE_NAME', () => {
    process.env.OTEL_SERVICE_NAME = 'otel-service';
    expect(resolveServiceName()).toBe('otel-service');
  });

  it('falls back to TRACCIA_SERVICE_NAME', () => {
    process.env.TRACCIA_SERVICE_NAME = 'traccia-service';
    expect(resolveServiceName()).toBe('traccia-service');
  });

  it('falls back to SERVICE_NAME', () => {
    process.env.SERVICE_NAME = 'legacy-service';
    expect(resolveServiceName()).toBe('legacy-service');
  });

  it('falls back to cwd name before traccia_app default', () => {
    expect(resolveServiceName()).toBe('traccia-node');
  });

  it('falls back to argv script stem when cwd is empty', () => {
    const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue('');
    const originalArgv = process.argv;
    process.argv = ['node', '/opt/app/run-worker.ts'];

    expect(resolveServiceName()).toBe('run-worker');

    process.argv = originalArgv;
    cwdSpy.mockRestore();
  });

  it('falls back to traccia_app when cwd and argv are unavailable', () => {
    const cwdSpy = jest.spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('cwd unavailable');
    });
    const originalArgv = process.argv;
    process.argv = ['node', '-c'];

    expect(resolveServiceName()).toBe('traccia_app');

    process.argv = originalArgv;
    cwdSpy.mockRestore();
  });
});
