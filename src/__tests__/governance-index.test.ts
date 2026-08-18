/**
 * Smoke test for the governance barrel export (src/governance/index.ts).
 * Nothing else imports from '../governance' directly - every other test
 * imports from the specific submodules - so this file exists purely to
 * catch a broken/typo'd re-export in the barrel that per-submodule tests
 * can't catch.
 */
import * as governance from '../governance';

describe('governance barrel export', () => {
    it('re-exports the expected public API', () => {
        expect(typeof governance.govern).toBe('function');
        expect(typeof governance.checkAgentStatus).toBe('function');
        expect(typeof governance.configureGovernance).toBe('function');
        expect(governance.govConfig).toBeDefined();
        expect(governance.governanceHooks).toBeDefined();
        expect(typeof governance.GovernanceManager).toBe('function');
        expect(typeof governance.AgentBlockedError).toBe('function');
        expect(typeof governance.disclosure).toBe('function');
        expect(typeof governance.enrichGovernanceAttributes).toBe('function');
    });
});
