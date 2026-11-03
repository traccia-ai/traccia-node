/**
 * Runtime governance configuration (advanced endpoint overrides).
 */

import { findConfigFile, loadConfig } from '../config/config';
import { resetFailModeState, validateMode, type PolicyFailMode } from './fail-mode';

export interface GovernanceConfigOptions {
  statusCheckEndpoint?: string;
  postBlockEndpoint?: string;
  statusCacheTtlSeconds?: number;
  policyFailMode?: PolicyFailMode;
}

export interface GovernanceTomlSection {
  status_check_endpoint?: string;
  post_block_endpoint?: string;
  status_cache_ttl_seconds?: number;
  policy_fail_mode?: PolicyFailMode;
}

class GovernanceConfig {
  statusCheckEndpoint?: string;
  postBlockEndpoint?: string;
  statusCacheTtlSeconds = 60;
  /**
   * Local fail mode override for this process (TRC-342): 'open', 'closed' or undefined
   * (follow the customer's setting in Traccia). Applies only when Traccia gives no answer.
   */
  policyFailMode?: PolicyFailMode;
}

const GOVERNANCE_CONFIG_KEY = Symbol.for('traccia.governanceConfig');

type GovernanceConfigHost = typeof globalThis & { [GOVERNANCE_CONFIG_KEY]?: GovernanceConfig };

/** One process shares the overrides across the separately bundled entry points (auto, index, cli). */
const host = globalThis as GovernanceConfigHost;

export const govConfig = (host[GOVERNANCE_CONFIG_KEY] ??= new GovernanceConfig());

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

  resetFailModeState(); // a new init starts without a remembered setting
  govConfig.policyFailMode = validateMode(options.policyFailMode ?? govSection.policy_fail_mode);
}
