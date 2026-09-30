import { act, renderHook } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useShellConnection } from '@/modules/shell/hooks/useShellConnection';
import type { Project, ProjectSession } from '@/shared/types';

vi.mock('@/modules/shell/utils/socket', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getShellWebSocketUrl: () => 'ws://localhost/shell',
}));

class FakeSocket {
  static instances: FakeSocket[] = [];

  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor() {
    FakeSocket.instances.push(this);
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  simulateFailure() {
    this.readyState = 3;
    this.onerror?.();
    this.onclose?.();
  }
}

const ref = <T,>(value: T): MutableRefObject<T> => ({ current: value });

describe('shell auto-connect loop prevention', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('attempts to connect once when autoConnect is true and stops on failure without tight retry loop', () => {
    const clearTerminalScreen = vi.fn();
    const closeSocket = vi.fn();
    const wsRef = ref<WebSocket | null>(null);

    const view = renderHook(() =>
      useShellConnection({
        wsRef,
        terminalRef: ref({ write: vi.fn(), cols: 80, rows: 24 } as unknown as Terminal | null),
        fitAddonRef: ref({ fit: vi.fn() } as unknown as FitAddon | null),
        selectedProjectRef: ref<Project | null | undefined>({
          fullPath: '/tmp/project',
          path: '/tmp/project',
        } as Project),
        selectedSessionRef: ref<ProjectSession | null | undefined>(null),
        initialCommandRef: ref<string | null | undefined>(null),
        isPlainShellRef: ref(false),
        bypassPermissionsRef: ref(false),
        onProcessCompleteRef: ref(null),
        isInitialized: true,
        autoConnect: true,
        closeSocket,
        clearTerminalScreen,
      }),
    );

    // Initial mount with autoConnect should have spawned exactly 1 socket
    expect(FakeSocket.instances.length).toBe(1);
    expect(view.result.current.isConnecting).toBe(true);
    expect(view.result.current.isConnected).toBe(false);

    // Simulate connection failure (e.g. proxy rejects /shell handshake)
    act(() => {
      FakeSocket.instances[0].simulateFailure();
    });

    // It must NOT have immediately spawned a second socket in a 0ms infinite retry loop!
    expect(FakeSocket.instances.length).toBe(1);
    expect(view.result.current.isConnecting).toBe(false);
    expect(view.result.current.isConnected).toBe(false);
  });

  it('allows manual reconnection via connectToShell after auto-connect failure', () => {
    const clearTerminalScreen = vi.fn();
    const closeSocket = vi.fn();
    const wsRef = ref<WebSocket | null>(null);

    const view = renderHook(() =>
      useShellConnection({
        wsRef,
        terminalRef: ref({ write: vi.fn(), cols: 80, rows: 24 } as unknown as Terminal | null),
        fitAddonRef: ref({ fit: vi.fn() } as unknown as FitAddon | null),
        selectedProjectRef: ref<Project | null | undefined>({
          fullPath: '/tmp/project',
          path: '/tmp/project',
        } as Project),
        selectedSessionRef: ref<ProjectSession | null | undefined>(null),
        initialCommandRef: ref<string | null | undefined>(null),
        isPlainShellRef: ref(false),
        bypassPermissionsRef: ref(false),
        onProcessCompleteRef: ref(null),
        isInitialized: true,
        autoConnect: true,
        closeSocket,
        clearTerminalScreen,
      }),
    );

    expect(FakeSocket.instances.length).toBe(1);

    act(() => {
      FakeSocket.instances[0].simulateFailure();
    });

    expect(FakeSocket.instances.length).toBe(1);
    expect(view.result.current.isConnecting).toBe(false);

    // User explicitly clicks "Connect / Retry"
    act(() => {
      view.result.current.connectToShell();
    });

    // Should now spawn the second socket on manual user intent
    expect(FakeSocket.instances.length).toBe(2);
    expect(view.result.current.isConnecting).toBe(true);
  });
});
