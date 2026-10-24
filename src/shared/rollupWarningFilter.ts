/**
 * Rollup warning filter for the client build.
 *
 * The `virtua` package ships its ESM build with PURE-annotation comments
 * placed on their own line, one line above a `return` statement. Rollup only
 * recognises a PURE annotation when it directly precedes the call it marks,
 * so it reports every one of them as `INVALID_ANNOTATION` and strips the
 * comment. The published package is the only source of these warnings.
 *
 * Moving the annotation next to the call is not an option: on the `return
 * c(...)` statements of `Virtualizer` the call produces the React element the
 * component renders, and marking it PURE lets Rollup drop that render path
 * as dead code. The build then ships a `Virtualizer` without its scroll
 * container. The warnings are therefore silenced while the published code
 * stays untouched.
 *
 * Consumed by `vite.config.js` as the build's `onwarn` handler.
 */

/** The subset of Rollup's warning object this filter inspects. */
export type RollupWarning = {
  /** Rollup's machine-readable warning code, e.g. `INVALID_ANNOTATION`. */
  code: string;
  /** Absolute path of the module the warning refers to, when it has one. */
  id?: string;
};

/**
 * Matches the `virtua` package directory inside a `node_modules` path.
 * Both separators are accepted so the filter works on Windows checkouts too.
 */
const VIRTUA_MODULE_PATH = /(^|[\\/])node_modules[\\/]virtua[\\/]/;

/**
 * Decides whether a Rollup warning should be dropped from the build log.
 *
 * Only `INVALID_ANNOTATION` warnings raised by `virtua` are suppressed. Every
 * other warning — including an `INVALID_ANNOTATION` raised by this project's
 * own code — is reported as usual.
 *
 * @param warning The warning Rollup raised.
 * @returns True when the warning must not be printed.
 */
export function shouldSuppressRollupWarning(warning: RollupWarning): boolean {
  if (warning.code !== 'INVALID_ANNOTATION') return false;
  if (!warning.id) return false;
  return VIRTUA_MODULE_PATH.test(warning.id);
}

/**
 * Reports a Rollup warning unless it is one of the suppressed ones.
 *
 * Warnings that are not suppressed are handed to `defaultHandler`, which is
 * Vite's own handler. It still applies Vite's ignore list, so the warnings
 * Vite hides by default (CIRCULAR_DEPENDENCY, THIS_IS_UNDEFINED) stay hidden
 * and genuine problems keep reaching the build log.
 *
 * @param warning The warning Rollup raised.
 * @param defaultHandler Vite's handler for warnings that are not suppressed.
 */
export function reportRollupWarning(
  warning: RollupWarning,
  defaultHandler: (warning: RollupWarning) => void,
): void {
  if (shouldSuppressRollupWarning(warning)) return;
  defaultHandler(warning);
}
