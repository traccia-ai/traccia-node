jest.mock('fs');

import * as fs from 'fs';
import { loadEnvFile, loadEnvConfig, findAgentConfigPath } from '../config/env-config';

describe('env-config', () => {
    const mockExistsSync = fs.existsSync as jest.Mock;
    const mockReadFileSync = fs.readFileSync as jest.Mock;

    const savedEnv = { ...process.env };

    beforeEach(() => {
        jest.clearAllMocks();
        process.env = { ...savedEnv };
    });

    afterAll(() => {
        process.env = savedEnv;
    });

    describe('loadEnvFile', () => {
        it('does nothing when the file does not exist', () => {
            mockExistsSync.mockReturnValue(false);

            loadEnvFile('.env');

            expect(mockReadFileSync).not.toHaveBeenCalled();
        });

        it('parses key=value lines into process.env', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue('FOO=bar\nBAZ=qux\n');
            delete process.env.FOO;
            delete process.env.BAZ;

            loadEnvFile('.env');

            expect(process.env.FOO).toBe('bar');
            expect(process.env.BAZ).toBe('qux');
        });

        it('skips blank lines and comments', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue('\n# a comment\nFOO=bar\n');
            delete process.env.FOO;

            loadEnvFile('.env');

            expect(process.env.FOO).toBe('bar');
        });

        it('skips lines with no "=" separator', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue('not-a-valid-line\nFOO=bar\n');
            delete process.env.FOO;

            expect(() => loadEnvFile('.env')).not.toThrow();
            expect(process.env.FOO).toBe('bar');
        });

        it('strips surrounding quotes from values', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue('FOO="quoted value"\nBAR=\'single quoted\'\n');
            delete process.env.FOO;
            delete process.env.BAR;

            loadEnvFile('.env');

            expect(process.env.FOO).toBe('quoted value');
            expect(process.env.BAR).toBe('single quoted');
        });

        it('does not override an existing env var', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue('FOO=from-file\n');
            process.env.FOO = 'already-set';

            loadEnvFile('.env');

            expect(process.env.FOO).toBe('already-set');
        });

        it('silently swallows read errors', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockImplementation(() => {
                throw new Error('EACCES');
            });

            expect(() => loadEnvFile('.env')).not.toThrow();
        });

        it('defaults to ".env" when no path is given', () => {
            mockExistsSync.mockReturnValue(false);

            loadEnvFile();

            expect(mockExistsSync).toHaveBeenCalledWith('.env');
        });
    });

    describe('loadEnvConfig', () => {
        it('reads apiKey/endpoint/sampleRate from process.env', () => {
            process.env.AGENT_DASHBOARD_API_KEY = 'key-1';
            process.env.AGENT_DASHBOARD_ENDPOINT = 'https://example.com';
            process.env.AGENT_DASHBOARD_SAMPLE_RATE = '0.5';

            const config = loadEnvConfig();

            expect(config).toEqual({ apiKey: 'key-1', endpoint: 'https://example.com', sampleRate: 0.5 });
        });

        it('leaves sampleRate undefined when the env var is unset', () => {
            delete process.env.AGENT_DASHBOARD_SAMPLE_RATE;

            const config = loadEnvConfig();

            expect(config.sampleRate).toBeUndefined();
        });

        it('applies overrides for apiKey/endpoint/sampleRate/useOtlp', () => {
            const config = loadEnvConfig({
                apiKey: 'override-key',
                endpoint: 'https://override.example',
                sampleRate: '0.25',
                useOtlp: 'true',
            });

            expect(config).toMatchObject({
                apiKey: 'override-key',
                endpoint: 'https://override.example',
                sampleRate: 0.25,
                useOtlp: true,
            });
        });

        it('sets useOtlp to false when the override string is not "true"', () => {
            const config = loadEnvConfig({ useOtlp: 'false' });

            expect(config.useOtlp).toBe(false);
        });

        it('ignores an empty overrides object (no override fields set)', () => {
            process.env.AGENT_DASHBOARD_API_KEY = 'from-env';
            const config = loadEnvConfig({});

            expect(config.apiKey).toBe('from-env');
        });
    });

    describe('findAgentConfigPath', () => {
        it('returns undefined when no candidate file exists', () => {
            mockExistsSync.mockReturnValue(false);

            expect(findAgentConfigPath()).toBeUndefined();
        });

        it('returns the resolved path of the first matching candidate', () => {
            mockExistsSync.mockImplementation((p: unknown) => p === './agent-config.json');

            const result = findAgentConfigPath();

            expect(result).toContain('agent-config.json');
        });

        it('checks candidates in order and stops at the first match', () => {
            mockExistsSync.mockImplementation((p: unknown) => p === './.config/agent_config.json');

            const result = findAgentConfigPath();

            expect(result).toContain('agent_config.json');
            expect(mockExistsSync).toHaveBeenCalledWith('./agent_config.json');
            expect(mockExistsSync).toHaveBeenCalledWith('./agent-config.json');
            expect(mockExistsSync).toHaveBeenCalledWith('./.config/agent_config.json');
        });
    });
});
