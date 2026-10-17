import assert from 'node:assert/strict';
import test from 'node:test';

import {
  codexAppServerTransport,
  listCodexThreadTurns,
} from '@/modules/providers/list/codex/codex-app-server.client.js';

test('history reader resumes the requested thread and reads every full page with experimental API', async () => {
  const originalOpen = codexAppServerTransport.open;
  const calls: Array<{ method: string; params: any }> = [];
  let options: any;
  let closed = false;
  codexAppServerTransport.open = async (_handlers, suppliedOptions) => {
    options = suppliedOptions;
    return {
      close: () => { closed = true; },
      call: async (method, params) => {
        calls.push({ method, params: params as Record<string, unknown> });
        if (method === 'thread/resume') return { thread: { id: 'thread-history' } };
        if ((params as Record<string, unknown>).cursor === 'cursor-2') {
          return { data: [{ id: 'turn-2' }], nextCursor: null };
        }
        return { data: [{ id: 'turn-1' }], nextCursor: 'cursor-2' };
      },
    };
  };

  try {
    assert.deepEqual(await listCodexThreadTurns('thread-history'), [{ id: 'turn-1' }, { id: 'turn-2' }]);
    assert.deepEqual(options, { experimentalApi: true });
    assert.deepEqual(calls.map(({ method }) => method), [
      'thread/resume', 'thread/turns/list', 'thread/turns/list',
    ]);
    assert.deepEqual(calls[1].params, {
      threadId: 'thread-history', limit: 100, itemsView: 'full',
    });
    assert.equal(calls[2].params.cursor, 'cursor-2');
    assert.equal(closed, true);
  } finally {
    codexAppServerTransport.open = originalOpen;
  }
});
