/**
 * macOS login keychain presence probe.
 *
 * @module macos-keychain
 */

import { execFileSync } from 'node:child_process';

/**
 * Environment switch that disables every keychain probe in this process.
 * Tests set it so a developer machine that really is logged in cannot turn a
 * "not authenticated" fixture green.
 *
 * Consumers: the antigravity and claude auth providers (indirectly, through
 * `hasKeychainItem`), and their tests.
 */
export const KEYCHAIN_SKIP_ENV_VAR = 'CLOUDCLI_SKIP_KEYCHAIN';

/**
 * Which generic-password item to look for. `account` is optional because some
 * CLIs store a single item per service and leave the account attribute
 * unset or opaque (Claude Code writes `acct="unknown"`).
 *
 * Consumers: `hasKeychainItem` callers in the antigravity and claude auth
 * providers.
 */
export type KeychainItemQuery = {
  service: string;
  account?: string;
  /**
   * Additional environment variable names that also disable this probe, on
   * top of `KEYCHAIN_SKIP_ENV_VAR`. Exists so provider-specific switches that
   * predate the shared one keep working for their existing tests.
   */
  extraSkipEnvVars?: string[];
};

/**
 * Reports whether the macOS login keychain holds a generic-password item for
 * the given service.
 *
 * CLIs that ship on macOS keep their OAuth credentials here rather than in a
 * dotfile: the file is written once at login while later refreshes update
 * only the keychain, so a credential file alone under-reports authenticated
 * state and traps the UI in a login prompt. The probe never passes `-w`, so
 * `security` prints item attributes only and never the secret — no keychain
 * authorization dialog is raised.
 *
 * Returns false on every non-darwin platform and whenever a skip switch is
 * set.
 *
 * Consumers: `antigravity-auth.provider.ts` and `claude-auth.provider.ts`.
 */
export function hasKeychainItem({ service, account, extraSkipEnvVars }: KeychainItemQuery): boolean {
  if (process.platform !== 'darwin') {
    return false;
  }
  if (process.env[KEYCHAIN_SKIP_ENV_VAR] === '1') {
    return false;
  }
  if (extraSkipEnvVars?.some((name) => process.env[name] === '1')) {
    return false;
  }

  const args = ['find-generic-password', '-s', service];
  if (account) {
    args.push('-a', account);
  }

  try {
    execFileSync('security', args, {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}
