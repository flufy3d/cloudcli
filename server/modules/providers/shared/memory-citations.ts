/**
 * Memory Citations
 *
 * Single place that lifts an engine's in-prose memory markup out of an
 * assistant reply and turns it into `MemoryCitation[]`.
 *
 * Engines that consult stored memory annotate the reply so the provenance is
 * machine-readable, but the annotation is markup, not prose: left in place it
 * renders as raw tags in the transcript. Each engine spells it differently
 * (Codex appends a trailing block, Claude wraps the sentence it drew on), so
 * the shapes live here together and every provider calls one function. A new
 * engine adds a pattern to this module rather than growing its own copy of the
 * stripping logic.
 *
 * @module memory-citations
 */

import type { LLMProvider, MemoryCitation } from '@/shared/types.js';

/**
 * A reply with its memory markup removed, plus whatever provenance that markup
 * carried. `memoryCitations` is absent — never an empty array — when the reply
 * cited nothing, so callers can spread it into a message without inventing an
 * empty footnote.
 */
export type MemoryCitationLift = {
  text: string;
  memoryCitations?: MemoryCitation[];
};

/**
 * The block Codex appends to a reply that leaned on its memory files. It is
 * always the last thing in the message and is meant for programmatic parsing,
 * so it reads as raw XML when left in the prose.
 */
const CODEX_CITATION_BLOCK = /<oai-mem-citation>([\s\S]*?)<\/oai-mem-citation>\s*$/i;

/**
 * Claude's inline form: the tag wraps the sentence that used the memory, and
 * one reply may carry several. Unlike Codex's trailing block the wrapped text
 * is real prose that has to survive — only the shell comes off. The quoting of
 * `filenames` is not guaranteed, so both quote styles are accepted.
 */
const CLAUDE_CITATION_TAG = /<cc-memory\s+filenames=["']([^"']*)["']\s*>([\s\S]*?)<\/cc-memory>/gi;

/**
 * Lifts Codex's trailing citation block.
 *
 * The block names the memory files and line ranges the answer drew on, which
 * is worth showing — but as a footnote under the reply, not as markup inside
 * it. The trailing `<rollout_ids>` list is dropped: those are handles to
 * earlier rollouts the transcript view has no way to open.
 */
function liftCodexCitations(text: string): MemoryCitationLift {
  const block = CODEX_CITATION_BLOCK.exec(text);
  if (!block) {
    return { text };
  }

  const entries = /<citation_entries>([\s\S]*?)<\/citation_entries>/i.exec(block[1])?.[1] ?? '';
  const memoryCitations: MemoryCitation[] = [];
  for (const line of entries.split('\n')) {
    const entry = line.trim();
    if (!entry) {
      continue;
    }

    const noteMarker = entry.indexOf('|note=');
    const source = (noteMarker === -1 ? entry : entry.slice(0, noteMarker)).trim();
    if (!source) {
      continue;
    }

    const note = noteMarker === -1
      ? ''
      : entry.slice(noteMarker + '|note='.length).trim().replace(/^\[/, '').replace(/\]$/, '').trim();
    memoryCitations.push(note ? { source, note } : { source });
  }

  const prose = text.slice(0, block.index).trimEnd();
  return memoryCitations.length > 0 ? { text: prose, memoryCitations } : { text: prose };
}

/**
 * Unwraps Claude's inline citation tags, keeping the sentences they wrapped.
 *
 * Several tags may name the same file; the footnote lists each file once, in
 * the order it was first cited. Claude names files without line ranges, so
 * these citations carry no note.
 */
function liftClaudeCitations(text: string): MemoryCitationLift {
  CLAUDE_CITATION_TAG.lastIndex = 0;
  if (!CLAUDE_CITATION_TAG.test(text)) {
    return { text };
  }

  const sources: string[] = [];
  CLAUDE_CITATION_TAG.lastIndex = 0;
  const unwrapped = text.replace(CLAUDE_CITATION_TAG, (_match, filenames: string, sentence: string) => {
    for (const name of filenames.split(',')) {
      const source = name.trim();
      if (source && !sources.includes(source)) {
        sources.push(source);
      }
    }
    return sentence;
  });

  return sources.length > 0
    ? { text: unwrapped, memoryCitations: sources.map((source) => ({ source })) }
    : { text: unwrapped };
}

/**
 * Strips `provider`'s memory markup from an assistant reply.
 *
 * Providers without in-prose memory markup get the text back untouched, so
 * every normalizer can call this unconditionally on assistant prose.
 *
 * Consumers: the Codex thread-item renderer and the Claude session normalizer,
 * both of which run it on the single path their live and history rows share.
 */
export function liftMemoryCitations(provider: LLMProvider, text: string): MemoryCitationLift {
  switch (provider) {
    case 'codex':
      return liftCodexCitations(text);
    case 'claude':
      return liftClaudeCitations(text);
    default:
      return { text };
  }
}
