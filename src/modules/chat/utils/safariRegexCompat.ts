/**
 * Safari < 16.4 (iOS/iPadOS 15, 16.0-16.3) Compatibility Utilities
 *
 * WebKit prior to 16.4 does NOT support RegExp Lookbehind assertions `(?<=...)` or `(?<!...)`.
 * When WebKit encounters them in regular expressions, it throws:
 *   "SyntaxError: Invalid regular expression: invalid group"
 *
 * Consumed by:
 * - `safariCompat.test.tsx` to verify lookbehind elimination and bundle safety.
 * - `vite.config.js` (via `safariRegexCompatPlugin`) to transform `mdast-util-gfm-autolink-literal`
 *   and block any unguarded lookbehind from reaching client distribution chunks.
 */

import type { Plugin } from 'vite';

/**
 * Transforms the lookbehind regex pattern found in `mdast-util-gfm-autolink-literal` (v2.0.1+)
 * into a WebKit < 16.4 compatible regex (identical to v2.0.0).
 */
export function transformSafariRegexLookbehind(code: string): string {
  if (typeof code !== 'string') return code;

  // 1. Literal form:
  // [/(?<=^|\s|\p{P}|\p{S})([-.\w+]+)@([-\w]+(?:\.[-\w]+)+)/gu, findEmail]
  // -> [/([-.\w+]+)@([-\w]+(?:\.[-\w]+)+)/g, findEmail]
  let result = code.replace(
    /\/\(\?<=[^/]*?\)\(([^/]+@[^/]+)\)\/gu?/g,
    '/($1)/g',
  );

  // 2. String / RegExp constructor form:
  // new RegExp("(?<=^|\\s|\\p{P}|\\p{S})([-.\\w+]+)@([-\\w]+(?:\\.[-\\w]+)+)", "gu")
  // -> new RegExp("([-.\\w+]+)@([-\\w]+(?:\\.[-\\w]+)+)", "g")
  result = result.replace(
    /new RegExp\("(?:\\[\s\S]|[^"])*?\(\?<=[^"]*?\)\(([^"]+@[^"]+)\)",\s*"[a-z]*"\)/g,
    'new RegExp("($1)", "g")',
  );

  // 3. Catch-all for standalone string pattern if embedded without new RegExp
  result = result.replace(
    /"(?:\\[\s\S]|[^"])*?\(\?<=[^"]*?\)\(([^"]+@[^"]+)\)"/g,
    '"($1)"',
  );

  return result;
}

/**
 * Checks if a lookbehind match index in `code` is protected by a try-catch block
 * or conditional feature-detection ternary (e.g. `isSupported ? "(?<!...)" : fallback`).
 */
function isGuarded(code: string, matchIndex: number): boolean {
  const windowBefore = code.slice(Math.max(0, matchIndex - 120), matchIndex);
  const windowAfter = code.slice(matchIndex, Math.min(code.length, matchIndex + 120));

  // 1. Inside try-catch block
  const hasTryBefore = /try\s*\{[^}]*$/.test(windowBefore);
  const hasCatchAfter = /^[^{]*\}\s*catch/.test(windowAfter);
  if (hasTryBefore && hasCatchAfter) {
    return true;
  }

  // 2. Inside ternary branch guarded by feature flag: e.g. B1 ? "(?<!`)()" : "(^^|[^`])"
  if (/\?\s*["'`][^"'`]*$/.test(windowBefore) && /^[^{};]*:\s*["'`]/.test(windowAfter)) {
    return true;
  }

  return false;
}

export type LookbehindViolation = {
  index: number;
  pattern: string;
  snippet: string;
};

/**
 * Identifies any unguarded RegExp lookbehind assertions `(?<=` or `(?<!` in JavaScript code.
 * Returns an array of violations found.
 */
export function findUnguardedLookbehinds(code: string): LookbehindViolation[] {
  if (typeof code !== 'string') return [];

  const violations: LookbehindViolation[] = [];
  const lookbehindPattern = /\(\?<[=!]/g;
  let match: RegExpExecArray | null;

  while ((match = lookbehindPattern.exec(code)) !== null) {
    const idx = match.index;
    if (isGuarded(code, idx)) {
      continue;
    }

    const snippetStart = Math.max(0, idx - 40);
    const snippetEnd = Math.min(code.length, idx + 60);
    const snippet = code.slice(snippetStart, snippetEnd).replace(/\n/g, ' ');

    violations.push({
      index: idx,
      pattern: match[0],
      snippet,
    });
  }

  return violations;
}

/**
 * Vite plugin for Safari < 16.4 RegExp lookbehind compatibility.
 */
export function safariRegexCompatPlugin(): Plugin {
  return {
    name: 'safari-regex-compat',
    enforce: 'pre',
    transform(code: string, id: string) {
      if (
        id.includes('mdast-util-gfm-autolink-literal') ||
        code.includes('(?<=^|\\s|\\p{P}|\\p{S})')
      ) {
        const transformed = transformSafariRegexLookbehind(code);
        if (transformed !== code) {
          return {
            code: transformed,
            map: null,
          };
        }
      }
      return null;
    },
    generateBundle(_, bundle) {
      const allViolations: { fileName: string; violations: LookbehindViolation[] }[] = [];
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (fileName.endsWith('.js') && 'code' in chunk && typeof chunk.code === 'string') {
          const violations = findUnguardedLookbehinds(chunk.code);
          if (violations.length > 0) {
            allViolations.push({ fileName, violations });
          }
        }
      }

      if (allViolations.length > 0) {
        const details = allViolations
          .map((v) => `${v.fileName}: ${v.violations.map((vi) => vi.snippet).join('; ')}`)
          .join('\n');
        this.error(
          `[safari-regex-compat] Detected unguarded RegExp lookbehind assertion(s) in client bundle.\n` +
          `Older WebKit / Safari (< 16.4) will throw SyntaxError on these:\n${details}`,
        );
      }
    },
  };
}
