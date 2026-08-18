jest.mock('../config/config', () => ({
    findConfigFile: jest.fn(),
    loadConfig: jest.fn(),
}));

import { configureGovernance, govConfig } from '../governance/config';
import { findConfigFile, loadConfig } from '../config/config';

describe('configureGovernance', () => {
    const mockFindConfigFile = findConfigFile as jest.Mock;
    const mockLoadConfig = loadConfig as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        mockFindConfigFile.mockReturnValue(undefined);
        mockLoadConfig.mockReturnValue({});
        govConfig.statusCheckEndpoint = undefined;
        govConfig.postBlockEndpoint = undefined;
        govConfig.statusCacheTtlSeconds = 60;
    });

    it('applies explicit statusCheckEndpoint/postBlockEndpoint/statusCacheTtlSeconds options', () => {
        configureGovernance({
            statusCheckEndpoint: 'https://example.com/status',
            postBlockEndpoint: 'https://example.com/block',
            statusCacheTtlSeconds: 120,
        });

        expect(govConfig.statusCheckEndpoint).toBe('https://example.com/status');
        expect(govConfig.postBlockEndpoint).toBe('https://example.com/block');
        expect(govConfig.statusCacheTtlSeconds).toBe(120);
    });

    it('falls back to TOML governance section values when options are omitted', () => {
        mockFindConfigFile.mockReturnValue('/path/traccia.toml');
        mockLoadConfig.mockReturnValue({
            governance: {
                status_check_endpoint: 'https://toml.example/status',
                post_block_endpoint: 'https://toml.example/block',
                status_cache_ttl_seconds: 30,
            },
        });

        configureGovernance();

        expect(govConfig.statusCheckEndpoint).toBe('https://toml.example/status');
        expect(govConfig.postBlockEndpoint).toBe('https://toml.example/block');
        expect(govConfig.statusCacheTtlSeconds).toBe(30);
        expect(mockLoadConfig).toHaveBeenCalledWith('/path/traccia.toml');
    });

    it('prefers explicit options over TOML values', () => {
        mockFindConfigFile.mockReturnValue('/path/traccia.toml');
        mockLoadConfig.mockReturnValue({
            governance: {
                status_check_endpoint: 'https://toml.example/status',
                status_cache_ttl_seconds: 30,
            },
        });

        configureGovernance({ statusCheckEndpoint: 'https://explicit.example/status', statusCacheTtlSeconds: 99 });

        expect(govConfig.statusCheckEndpoint).toBe('https://explicit.example/status');
        expect(govConfig.statusCacheTtlSeconds).toBe(99);
    });

    it('uses an explicit configFile option instead of findConfigFile()', () => {
        mockLoadConfig.mockReturnValue({ governance: { status_check_endpoint: 'https://explicit-file.example' } });

        configureGovernance({ configFile: '/explicit/path.toml' });

        expect(mockFindConfigFile).not.toHaveBeenCalled();
        expect(mockLoadConfig).toHaveBeenCalledWith('/explicit/path.toml');
        expect(govConfig.statusCheckEndpoint).toBe('https://explicit-file.example');
    });

    it('leaves defaults untouched when the config file loads but has no governance section', () => {
        mockFindConfigFile.mockReturnValue('/path/traccia.toml');
        mockLoadConfig.mockReturnValue({ tracing: { api_key: 'k' } });

        configureGovernance();

        expect(govConfig.statusCheckEndpoint).toBeUndefined();
        expect(govConfig.statusCacheTtlSeconds).toBe(60);
    });

    it('leaves defaults untouched when no config file is found and no options are given', () => {
        mockFindConfigFile.mockReturnValue(undefined);

        configureGovernance();

        expect(govConfig.statusCheckEndpoint).toBeUndefined();
        expect(govConfig.postBlockEndpoint).toBeUndefined();
        expect(govConfig.statusCacheTtlSeconds).toBe(60);
        expect(mockLoadConfig).not.toHaveBeenCalled();
    });

    it('swallows a loadConfig parse error and leaves the governance section empty', () => {
        mockFindConfigFile.mockReturnValue('/path/traccia.toml');
        mockLoadConfig.mockImplementation(() => {
            throw new Error('invalid TOML');
        });

        expect(() => configureGovernance({ statusCheckEndpoint: 'https://still.example/status' })).not.toThrow();
        expect(govConfig.statusCheckEndpoint).toBe('https://still.example/status');
        expect(govConfig.statusCacheTtlSeconds).toBe(60);
    });

    it('does not overwrite an already-configured endpoint when neither options nor TOML provide one', () => {
        govConfig.statusCheckEndpoint = 'https://previously-set.example/status';
        mockFindConfigFile.mockReturnValue(undefined);

        configureGovernance();

        expect(govConfig.statusCheckEndpoint).toBe('https://previously-set.example/status');
    });
});
