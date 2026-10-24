import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

const auth = vi.hoisted(() => ({ token: 'first', user: { id: 1 }, isLoading: false }));
vi.mock('@/modules/auth', () => ({ useAuth: () => auth }));
vi.mock('@/shared/utils', () => ({ IS_PLATFORM: true }));

import { WebSocketProvider, useWebSocket } from '@/shared/context/WebSocketContext';

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor() { Socket.instances.push(this); }
  close() {}
  send() {}
}

afterEach(() => { vi.unstubAllGlobals(); Socket.instances = []; auth.token = 'first'; });

test('late callbacks from a replaced websocket cannot dispatch frames or change the current connection', () => {
  vi.stubGlobal('WebSocket', Socket);
  const { result, rerender, unmount } = renderHook(() => useWebSocket(), { wrapper: WebSocketProvider });
  const first = Socket.instances[0];
  const lateMessage = first.onmessage!;
  const lateOpen = first.onopen!;
  act(() => first.onopen!());
  const received: unknown[] = [];
  result.current.subscribe(event => received.push(event));
  auth.token = 'second';
  rerender();
  const second = Socket.instances[1];
  act(() => {
    lateMessage({ data: JSON.stringify({ kind: 'text', sessionId: 'session', content: 'obsolete' }) });
    lateOpen();
  });
  assert.equal(received.length, 0);
  act(() => second.onopen!());
  assert.equal(result.current.ws, second);
  unmount();
});
