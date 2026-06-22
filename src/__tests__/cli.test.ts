import * as fs from 'fs';

import axios from 'axios';

jest.mock('fs');
jest.mock('axios');
jest.mock('../config/config', () => ({
  loadConfig: jest.fn().mockReturnValue({
    tracing: { endpoint: 'http://test', api_key: 'test-key', use_otlp: true, sample_rate: 1.0 },
    exporters: { enable_console: false, enable_file: false },
    instrumentation: { enable_patching: true },
    rate_limiting: {}
  }),
  findConfigFile: jest.fn().mockReturnValue('/mock/traccia.toml'),
  ENV_VAR_MAPPING: { TRACING: ['TRACCIA_API_KEY'] }
}));

jest.mock('../config/pricing-config', () => ({
  getLocalCacheInfo: jest.fn().mockReturnValue(null),
  loadBundledPricing: jest.fn().mockReturnValue({}),
  getBundledGeneratedAt: jest.fn().mockReturnValue('2024-01-01'),
  fetchUpstreamPricing: jest.fn().mockResolvedValue({ models: {} }),
  fetchPlatformPricing: jest.fn().mockResolvedValue(null),
  writeLocalCache: jest.fn().mockReturnValue('/mock/cache.json'),
  clearLocalCache: jest.fn().mockReturnValue(true),
  getCachePath: jest.fn().mockReturnValue('/mock/cache.json'),
}));

describe('CLI Commands', () => {
  let originalArgv: string[];
  let originalExit: NodeJS.Process['exit'];
  let mockExit: any;
  let consoleLogMock: jest.SpyInstance;
  let consoleErrorMock: jest.SpyInstance;

  beforeEach(() => {
    originalArgv = process.argv;
    originalExit = process.exit;
    mockExit = jest.fn() as any;
    process.exit = mockExit;

    consoleLogMock = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorMock = jest.spyOn(console, 'error').mockImplementation(() => {});

    jest.clearAllMocks();
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;
    consoleLogMock.mockRestore();
    consoleErrorMock.mockRestore();
  });

  function runCli(args: string[]) {
    process.argv = ['node', 'cli.js', ...args];
    jest.isolateModules(() => {
      require('../cli');
    });
  }

  describe('check command', () => {
    it('should test connectivity successfully', async () => {
      (axios.head as jest.Mock).mockResolvedValueOnce({ status: 200 });
      runCli(['check']);
      
      // wait for async action
      await new Promise(process.nextTick);
      
      expect(axios.head).toHaveBeenCalledWith('http://test', expect.any(Object));
      expect(consoleLogMock).toHaveBeenCalledWith(expect.stringContaining('Connectivity test successful!'));
    });

    it('should handle API validation rejections (e.g. 401)', async () => {
      (axios.isAxiosError as unknown as jest.Mock).mockReturnValue(true);
      (axios.head as jest.Mock).mockRejectedValueOnce({ response: { status: 401 } });
      
      runCli(['check']);
      await new Promise(process.nextTick);

      expect(consoleLogMock).toHaveBeenCalledWith(expect.stringContaining('Authentication required'));
      expect(mockExit).not.toHaveBeenCalled(); // 401 doesn't exit with error
    });

    it('should handle complete failure', async () => {
      (axios.isAxiosError as unknown as jest.Mock).mockReturnValue(false);
      (axios.head as jest.Mock).mockRejectedValueOnce(new Error('Network error'));
      
      runCli(['check']);
      await new Promise(process.nextTick);

      expect(consoleErrorMock).toHaveBeenCalledWith(expect.stringContaining('Connection failed'));
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe('config init command', () => {
    it('should create config file', () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      runCli(['config', 'init']);
      
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('traccia.toml'),
        expect.any(String),
        'utf-8'
      );
      expect(consoleLogMock).toHaveBeenCalledWith(expect.stringContaining('Created config file'));
    });

    it('should not overwrite existing file without --force', () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      runCli(['config', 'init']);
      
      expect(fs.writeFileSync).not.toHaveBeenCalled();
      expect(consoleErrorMock).toHaveBeenCalledWith(expect.stringContaining('Config file already exists'), expect.any(String));
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('should overwrite existing file with --force', () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      runCli(['config', 'init', '--force']);
      
      expect(fs.writeFileSync).toHaveBeenCalled();
    });
  });

  describe('doctor command', () => {
    it('should run diagnostics successfully with no issues', () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      runCli(['doctor']);
      
      expect(consoleLogMock).toHaveBeenCalledWith(expect.stringContaining('No issues found!'));
      expect(mockExit).not.toHaveBeenCalled();
    });

    it('should report issues when exporters are misconfigured', () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      const { loadConfig } = require('../config/config');
      loadConfig.mockReturnValueOnce({
        tracing: { endpoint: '', use_otlp: false }, // no endpoint and OTLP disabled
        exporters: { enable_console: false, enable_file: false }, // nothing enabled
        instrumentation: { enable_patching: true },
        rate_limiting: {}
      });

      runCli(['doctor']);
      
      expect(consoleLogMock).toHaveBeenCalledWith(expect.stringContaining('No exporter is enabled!'));
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe('pricing commands', () => {
    it('pricing:status should print cache info', () => {
      runCli(['pricing:status']);
      expect(consoleLogMock).toHaveBeenCalledWith(expect.stringContaining('Bundled snapshot'));
    });

    it('pricing:refresh should fetch from platform', async () => {
      const { fetchPlatformPricing } = require('../config/pricing-config');
      fetchPlatformPricing.mockResolvedValueOnce({ models: { 'test-model': {} }, generated_at: '2024-01-01' });
      
      runCli(['pricing:refresh']);
      await new Promise(process.nextTick);

      expect(consoleLogMock).toHaveBeenCalledWith(expect.stringContaining('Pricing refreshed: 1 models'));
    });

    it('pricing:clear should clear local cache', () => {
      runCli(['pricing:clear']);
      expect(consoleLogMock).toHaveBeenCalledWith(expect.stringContaining('Local pricing cache cleared'));
    });
  });
});
