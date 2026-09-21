/**
 * Ordering and provider-key reconciliation for the session message store.
 *
 * What used to live here — reconstructing which turn a live row belonged to
 * and matching replies by their text — is gone: every engine now derives a
 * transcript row's id from its own record, so the live copy and the persisted
 * copy of a row are recognised by id. What remains is the ordering of rows no
 * anchor covers, and the one reconciliation that is still identity-based:
 * a provider row key whose two transports disagree on how much of the body
 * they carry.
 *
 * Pure functions only — this module must stay free of Vite/environment
 * dependencies so it is importable from node:test, mirroring
 * sessionMessagePagination.ts / sessionMessageReconciliation.ts.
 */

import type { NormalizedMessage } from '@/shared/types';

export function readMessageTime(m: NormalizedMessage): number | null {
  const time = Date.parse(m.timestamp);
  return Number.isFinite(time) ? time : null;
}

export function compareMessagesChronologically(a: NormalizedMessage, b: NormalizedMessage): number {
  const timeA = readMessageTime(a) ?? 0;
  const timeB = readMessageTime(b) ?? 0;
  if (timeA !== timeB) {
    return timeA - timeB;
  }
  return 0;
}

type ProviderRowTextReconciliation = {
  winner: 'server' | 'realtime' | 'distinct';
  serverMessageId?: string;
};

/**

/**
 * Chooses which transport owns a uniquely keyed provider row. The provider
 * identity is the proof; body text is never normalized or compared. A complete
 * history row wins, while a complete realtime body may replace an explicitly
 * truncated history body. Ambiguous keys remain visible.
 */
export function reconcileProviderRowText(
  realtimeMessage: NormalizedMessage,
  serverMessages: NormalizedMessage[],
): ProviderRowTextReconciliation {
  if (!realtimeMessage.providerRowKey) {
    return { winner: 'distinct' };
  }

  const keyedServerRows = serverMessages.filter((serverMessage) =>
    serverMessage.provider === realtimeMessage.provider
    && serverMessage.kind === 'text'
    && serverMessage.role === 'assistant'
    && Boolean(serverMessage.providerRowKey),
  );
  if (keyedServerRows.length === 0) {
    return { winner: 'distinct' };
  }

  const matchingRows = keyedServerRows.filter(
    (serverMessage) => serverMessage.providerRowKey === realtimeMessage.providerRowKey,
  );
  if (matchingRows.length !== 1) {
    return { winner: 'distinct' };
  }

  const serverMessage = matchingRows[0];
  const result = (winner: 'server' | 'realtime'): ProviderRowTextReconciliation => ({
    winner,
    serverMessageId: serverMessage.id,
  });

  const serverCompleteness = serverMessage.contentCompleteness ?? 'complete';
  const realtimeCompleteness = realtimeMessage.contentCompleteness ?? 'complete';
  if (serverCompleteness === 'complete') {
    return result('server');
  }
  if (realtimeCompleteness === 'complete') {
    return result('realtime');
  }
  return (serverMessage.content || '').length >= (realtimeMessage.content || '').length
    ? result('server')
    : result('realtime');
}

/** The user row that opened this live row's turn, by arrival order alone. */
