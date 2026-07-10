/**
 * Runtime governance configuration (advanced endpoint overrides).
 */

import { findConfigFile, loadConfig } from '../config/config';

export interface GovernanceConfigOptions {
  statusCheckEndpoint?: string;
  postBlockEndpoint?: string;
  statusCacheTtlSeconds?: number;
}

export interface GovernanceTomlSection {
  status_check_endpoint?: string;
  post_block_endpoint?: string;
  status_cache_ttl_seconds?: number;
}

class GovernanceConfig {
  statusCheckEndpoint?: string;
  postBlockEndpoint?: string;
  statusCacheTtlSeconds = 60;
}

export const govConfig = new GovernanceConfig();

export function configureGovernance(
  options: GovernanceConfigOptions & { configFile?: string } = {},
): void {
  const configPath = options.configFile || findConfigFile();
  let govSection: GovernanceTomlSection = {};

  if (configPath) {
    try {
      const loaded = loadConfig(configPath) as ReturnType<typeof loadConfig> & {
        governance?: GovernanceTomlSection;
      };
      govSection = loaded.governance || {};
    } catch {
      // ignore parse errors — loadConfig already logs
    }
  }

  if (options.statusCheckEndpoint !== undefined) {
    govConfig.statusCheckEndpoint = options.statusCheckEndpoint;
  } else if (govSection.status_check_endpoint) {
    govConfig.statusCheckEndpoint = govSection.status_check_endpoint;
  }

  if (options.postBlockEndpoint !== undefined) {
    govConfig.postBlockEndpoint = options.postBlockEndpoint;
  } else if (govSection.post_block_endpoint) {
    govConfig.postBlockEndpoint = govSection.post_block_endpoint;
  }

  const ttl = options.statusCacheTtlSeconds ?? govSection.status_cache_ttl_seconds;
  if (ttl !== undefined) {
    govConfig.statusCacheTtlSeconds = ttl;
  }
}
