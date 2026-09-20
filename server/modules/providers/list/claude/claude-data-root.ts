/**
 * Claude Data Root
 *
 * Defines the narrow part of Claude's local data tree that other CloudCLI
 * modules may consume. Provider credentials and settings deliberately stay
 * outside every exported read-only root.
 *
 * @module claude-data-root
 */

import os from 'node:os';
import path from 'node:path';

/**
 * Returns the Claude project directory whose artifacts may be opened read-only
 * by the File Tree module when Claude references them in chat. The wider
 * `~/.claude` directory is intentionally excluded because it also contains
 * credentials and settings.
 */
export function getClaudeExternalReadOnlyRoots(): string[] {
  return [path.join(os.homedir(), '.claude', 'projects')];
}
