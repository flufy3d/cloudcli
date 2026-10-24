/**
 * Shared decision for which session name a synchronizer write may land.
 *
 * Engines keep their own session titles (Claude's ai-title, Codex's
 * thread_name, the `title` column of the shared SQLite stores). A synchronizer
 * rescan sees the engine's current title on every pass, and the rule below
 * decides what belongs in `sessions.custom_name`:
 *
 * - a user rename (`name_locked`) is final — no engine title overwrites it;
 * - an engine-generated title follows the engine, replacing even an earlier
 *   synced name;
 * - a content-derived name (first user prompt, rotating last prompt) only
 *   fills a nameless or placeholder row — following it would drift the title
 *   on every turn.
 */

export type DerivedSessionTitle = {
  /** Best title visible right now; null when the engine offers none. */
  name: string | null;
  /** True when the engine generated the title itself (its own naming). */
  generated: boolean;
};

export function resolveSessionTitle(input: {
  nameLocked: boolean;
  existingName: string | null | undefined;
  fallbackTitle: string;
  derived: DerivedSessionTitle;
}): string | null {
  if (input.nameLocked) {
    return input.existingName ?? null;
  }

  if (input.derived.generated && input.derived.name) {
    return input.derived.name;
  }

  const existingName = input.existingName ?? null;
  if (existingName && existingName !== input.fallbackTitle) {
    return existingName;
  }

  return input.derived.name ?? input.fallbackTitle;
}
