/**
 * OpenCode Engine Path Resolution
 *
 * OpenCode's resolution data (env override, `opencode` binary, platform
 * install locations) on the shared CLI engine path factory. Resolution order,
 * caching, and version probing live in `cli-engine-path.ts`.
 *
 * Resolution never throws: "not installed" is a legal state the auth provider
 * reports as `installed: false`; only the service supervisor turns a missing
 * engine into a run-time error.
 *
 * @module opencode-engine-path
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createCliEnginePathResolver } from '../../shared/engine-path/cli-engine-path.js';

/**
 * Default install locations by platform: Homebrew (`opencode-v2` cask), the
 * official install script (`~/.opencode/bin`), and common manual locations.
 */
const PLATFORM_CANDIDATES: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: [
    '/opt/homebrew/bin/opencode',
    '/usr/local/bin/opencode',
    path.join(os.homedir(), '.opencode', 'bin', 'opencode'),
  ],
  linux: [
    path.join(os.homedir(), '.opencode', 'bin', 'opencode'),
    path.join(os.homedir(), '.local', 'bin', 'opencode'),
    '/usr/local/bin/opencode',
  ],
  win32: [
    path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'opencode', 'bin', 'opencode.exe'),
    path.join(os.homedir(), '.opencode', 'bin', 'opencode.exe'),
  ],
};

const resolver = createCliEnginePathResolver({
  logTag: '[OpenCode]',
  envVars: ['CLOUDCLI_OPENCODE_CLI'],
  whichBinary: 'opencode',
  platformCandidates: PLATFORM_CANDIDATES,
  isValidPath: (filePath) => {
    try {
      const stats = fs.statSync(filePath);
      if (!stats.isFile()) {
        return false;
      }
      if (process.platform === 'win32') {
        return true;
      }
      fs.accessSync(filePath, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  versionProbe: {
    invocations: [(enginePath) => ({ command: enginePath, args: ['--version'] })],
    timeoutMs: 5000,
    // `opencode --version` prints `opencode v2.0.31`.
    parse: (output) => output.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null,
  },
  // Deliberately NOT eager: the service supervisor reads the version during
  // boot to refuse v1 engines, so the probe must have run by then. On-demand
  // mode probes synchronously inside the first getEngineVersion() call and
  // caches the result; an eager (async) probe would race that first boot and
  // let the gate see a null version.
});

/**
 * Resolves the OpenCode CLI binary.
 *
 * Resolution order: CLOUDCLI_OPENCODE_CLI override (dev/test) →
 * `which opencode` → platform install locations. A found path is cached for
 * the process lifetime; "not found" is cached until the shared negative TTL
 * elapses so a freshly installed CLI is picked up without a restart.
 *
 * Consumers: opencode service supervisor (spawns `opencode serve`), opencode
 * models provider (`opencode models` probe), opencode auth provider
 * (install detection).
 *
 * @returns Absolute path to the `opencode` binary, or `null` when not installed.
 */
export const tryResolveOpenCodeEnginePath = resolver.tryResolveEnginePath;

/**
 * Returns the cached CLI version (`2.0.31`) once the probe has run, or `null`
 * before that / when the CLI is missing. The probe runs synchronously inside
 * the first call (no eager mode: the service supervisor reads the version
 * during boot to refuse v1 engines, so it must be resolved by then).
 *
 * Consumer: opencode service supervisor.
 */
export const getOpenCodeEngineVersion = resolver.getEngineVersion;
