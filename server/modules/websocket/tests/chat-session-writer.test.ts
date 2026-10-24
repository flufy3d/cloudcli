import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatSessionWriter } from '@/modules/websocket/services/chat-session-writer.service.js';
import type { NormalizedMessage } from '@/shared/types.js';

type Notified = { userId: string | number | null; provider: string; sessionId: string | null; toolName?: string; requestId: string; sessionName?: string | null };

const makeWriter = (provider: 'claude' | 'zcode' | 'opencode' = 'zcode') => {
  const notified: Notified[] = [];
  const sent: string[] = [];
  const writer = new ChatSessionWriter({
    connection: { readyState: 1, send: (payload: string) => { sent.push(payload); } } as never,
    userId: 7,
    provider,
    providerSessionId: 'native-1',
    onProviderSessionId: () => {},
    // Stands in for the run registry, which stamps the app session id.
    decorateOutboundEvent: (message: NormalizedMessage) => ({ ...message, sessionId: 'app-1', seq: 1 }),
    sessionName: 'Fix the checkout',
    notifyPermissionRequest: (info) => { notified.push(info as Notified); },
  });
  return { writer, notified, sent };
};

test('any engine\'s approval card raises one push notification for the app session', () => {
  for (const provider of ['claude', 'zcode', 'opencode'] as const) {
    const { writer, notified } = makeWriter(provider);
    writer.send({ id: 'm1', kind: 'permission_request', requestId: 'per_1', toolName: 'Bash', input: {}, sessionId: 'native-1', provider, timestamp: '2026-01-01T00:00:00.000Z' });
    assert.deepEqual(notified, [{ userId: 7, provider, sessionId: 'app-1', toolName: 'Bash', requestId: 'per_1', sessionName: 'Fix the checkout' }]);
  }
});

test('other frames raise nothing', () => {
  const { writer, notified } = makeWriter();
  writer.send({ id: 'm1', kind: 'text', role: 'assistant', content: 'hi', sessionId: 'native-1', provider: 'zcode', timestamp: '2026-01-01T00:00:00.000Z' });
  writer.send({ id: 'm2', kind: 'permission_resolved', requestId: 'per_1', sessionId: 'native-1', provider: 'zcode', timestamp: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(notified, []);
});

test('a card the registry drops is not notified', () => {
  const notified: unknown[] = [];
  const writer = new ChatSessionWriter({
    connection: null, userId: 7, provider: 'zcode', providerSessionId: null, onProviderSessionId: () => {},
    decorateOutboundEvent: () => null,
    notifyPermissionRequest: (info) => { notified.push(info); },
  });
  writer.send({ id: 'm1', kind: 'permission_request', requestId: 'per_1', toolName: 'Bash', input: {}, sessionId: 's', provider: 'zcode', timestamp: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(notified, []);
});
