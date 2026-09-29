import { assert } from 'vitest';

// Vitest executes client tests in jsdom, where Vite externalizes Node's assert
// module. Tests import `node:assert/strict`, so the shim must be strict too:
// chai's `equal`/`deepEqual` are `==` and loose deep equality, which quietly
// turned every frontend assertion into a weaker one than the import promised
// (`assert.equal(2, '2')` passed).
const strict = {
  ...assert,
  equal: assert.strictEqual,
  deepEqual: assert.deepStrictEqual,
  notEqual: assert.notStrictEqual,
  notDeepEqual: assert.notDeepStrictEqual,
};

// chai's assert ships `match` but no `doesNotMatch`; implement it off match so
// `node:assert/strict` imports keep their full surface.
const doesNotMatch = (value: unknown, regexp: RegExp, message?: string): void => {
  let matched = false;
  try {
    match(value, regexp);
    matched = true;
  } catch {
    matched = false;
  }
  if (matched) {
    throw new Error(message || `Expected ${String(value)} not to match ${regexp}`);
  }
};

// chai's assert on vitest also lacks `rejects`/`throws` for async assertions
// against promise-returning functions; provide the narrow form tests use —
// an async function (or promise) plus an expected message regex.
const rejects = async (
  subject: unknown,
  expected?: RegExp | string | { message?: string } | (Error & { message?: string }),
  message?: string,
): Promise<void> => {
  const attempt = typeof subject === 'function' ? (subject as () => Promise<unknown>)() : (subject as Promise<unknown>);
  let error: unknown = null;
  try {
    await attempt;
  } catch (caught) {
    error = caught;
  }
  if (error === null) {
    throw new Error(message || 'Expected promise to reject, but it resolved');
  }
  if (expected === undefined) {
    return;
  }
  // node:assert's three shapes: a RegExp on the message, a message string, or
  // a validation object ({ message }) compared against the rejection.
  if (expected instanceof RegExp) {
    if (!expected.test(error instanceof Error ? error.message : String(error))) {
      throw new Error(message || `Expected rejection to match ${expected}, got "${error instanceof Error ? error.message : String(error)}"`);
    }
    return;
  }
  if (typeof expected === 'string') {
    if (!(error instanceof Error) || error.message !== expected) {
      throw new Error(message || `Expected rejection message "${expected}", got "${error instanceof Error ? error.message : String(error)}"`);
    }
    return;
  }
  const validation = expected as { message?: string };
  if (validation.message !== undefined) {
    const actual = error instanceof Error ? error.message : String(error);
    if (actual !== validation.message) {
      throw new Error(message || `Expected rejection message "${validation.message}", got "${actual}"`);
    }
  }
};

const strictWithExtras = { ...strict, doesNotMatch, rejects };

export default strictWithExtras;
export const {
  equal,
  strictEqual,
  deepEqual,
  deepStrictEqual,
  ok,
  match,
  throws,
  notEqual,
  notDeepEqual,
} = strictWithExtras;
export { doesNotMatch };
