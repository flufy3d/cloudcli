import type { ChatMessage } from '@/shared/types';
import { isToolGroupItem } from '@/modules/chat/utils/toolGrouping';
import type { MessageListItem } from '@/modules/chat/utils/toolGrouping';

/**
 * Locates the row a sidebar search result points at, against the loaded
 * transcript rather than the rendered DOM.
 *
 * The jump used to render the entire transcript and then scan `.chat-message`
 * textContent for the snippet, retrying fifteen times before giving up
 * silently. Resolving the index from the data means the caller can hand it
 * straight to the virtualizer, and a miss is knowable instead of being papered
 * over by the nearest-timestamp fallback.
 *
 * The index is into the *grouped* rows the transcript actually renders, not
 * into the flat message list: grouping folds consecutive tool calls into one
 * row and drops hidden ones, so the two index spaces do not line up.
 */

/** Shorter fragments match too many messages to identify one. */
const MIN_SNIPPET_LENGTH = 10;

/** The sidebar sends an elided fragment; only the leading part is reliable. */
const MAX_SNIPPET_LENGTH = 80;

export type SearchTarget = {
  snippet?: string;
  timestamp?: string;
};

/** Every field of a message that ends up as rendered text. */
function getSearchableText(message: ChatMessage): string {
  const parts = [message.displayText, message.content];

  if (typeof message.toolInput === 'string') {
    parts.push(message.toolInput);
  }
  const toolResultContent = message.toolResult?.content;
  if (typeof toolResultContent === 'string') {
    parts.push(toolResultContent);
  }

  return parts.filter(Boolean).join('\n').toLowerCase();
}

function normalizeSearchSnippet(snippet: string): string {
  return snippet
    .replace(/^\.{3}/, '')
    .replace(/\.{3}$/, '')
    .trim()
    .slice(0, MAX_SNIPPET_LENGTH)
    .toLowerCase()
    .trim();
}

/** Every message a rendered row covers — a tool group carries several. */
function getRowMessages(item: MessageListItem): ChatMessage[] {
  return isToolGroupItem(item) ? item.messages : [item];
}

/**
 * Returns the index of the best-matching rendered row, or -1 when the target
 * is not in the loaded transcript. The snippet is authoritative; the timestamp
 * only breaks a tie when no snippet matched, mirroring what the previous DOM
 * scan did.
 */
export function findSearchTargetIndex(
  items: MessageListItem[],
  target: SearchTarget,
): number {
  if (target.snippet) {
    const phrase = normalizeSearchSnippet(target.snippet);
    if (phrase.length >= MIN_SNIPPET_LENGTH) {
      const matchIndex = items.findIndex((item) =>
        getRowMessages(item).some((message) => getSearchableText(message).includes(phrase)),
      );
      if (matchIndex >= 0) {
        return matchIndex;
      }
    }
  }

  if (target.timestamp) {
    const targetTime = new Date(target.timestamp).getTime();
    if (Number.isFinite(targetTime)) {
      let closestIndex = -1;
      let closestDistance = Infinity;

      for (const [index, item] of items.entries()) {
        for (const message of getRowMessages(item)) {
          const messageTime = new Date(message.timestamp).getTime();
          if (!Number.isFinite(messageTime)) {
            continue;
          }

          const distance = Math.abs(messageTime - targetTime);
          if (distance < closestDistance) {
            closestDistance = distance;
            closestIndex = index;
          }
        }
      }

      return closestIndex;
    }
  }

  return -1;
}

