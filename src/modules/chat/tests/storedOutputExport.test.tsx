import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildTranscriptExport } from '@/modules/chat/utils/chatExport';
import { api } from '@/shared/api';
import type { ChatMessage } from '@/shared/types';

const image = `/api/assets/images/inline-${'a'.repeat(64)}.png`;
const file = `/api/assets/files/output-${'b'.repeat(64)}.txt`;

afterEach(() => { vi.unstubAllGlobals(); localStorage.removeItem('auth-token'); });

describe('offline output assets', () => {
  it('embeds stored images and full text through authenticated reads for HTML and JSON', async () => {
    localStorage.setItem('auth-token', 'opaque-test-token');
    const fetch = vi.fn(async (url: string, _options?: RequestInit) => ({
      ok: true,
      headers: new Headers(),
      blob: async () => new Blob([url.includes('/images/') ? 'ABC' : 'complete output'], { type: url.includes('/images/') ? 'image/png' : 'text/plain' }),
    }) as Response);
    vi.stubGlobal('fetch', fetch);
    const input = {
      messages: [{ type: 'assistant', isToolUse: true, toolName: 'Read', toolId: 'tool', toolInput: {}, toolResult: { content: `${image}\n${file}`, isError: false }, timestamp: new Date() }] as unknown as ChatMessage[],
      provider: 'opencode' as const,
      sessionTitle: 'Images',
      createDiff: () => [],
    };
    const html = await buildTranscriptExport('html', input, new Date());
    expect(html).toContain('src="data:image/png;base64,QUJD"');
    expect(html).toContain('href="data:text/plain;base64,');
    expect(html).toContain('<details');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer opaque-test-token');
    const json = JSON.parse(await buildTranscriptExport('json', input, new Date()));
    expect(json.assets[image]).toBe('data:image/png;base64,QUJD');
    expect(json.assets[file]).toContain('data:text/plain;base64,');
  });

  it('rejects missing or invalid assets instead of exporting an incomplete record', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, headers: new Headers() }) as Response));
    await expect(api.assets.embedForExport([image])).rejects.toThrow('404');
    await expect(api.assets.embedForExport(['/api/assets/images/../secret'])).rejects.toThrow('Invalid');
  });
});
