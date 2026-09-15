import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { Markdown } from '@/modules/chat/transcript/Markdown';
import type * as sharedApi from '@/shared/api';

/**
 * Pins the local-image resolution contract for chat markdown: Antigravity
 * embeds verification snapshots as bare absolute filesystem paths (or
 * `file://` URLs), which no browser can load as plain <img> src. They must be
 * fetched through the allowlisted read-only endpoint into blob URLs; refused
 * paths fall back to the raw src, and remote images never touch the endpoint.
 */

const { readExternalFileContent } = vi.hoisted(() => ({
  readExternalFileContent: vi.fn(),
}));

vi.mock('@/shared/api', async (importOriginal) => ({
  ...((await importOriginal()) as typeof sharedApi),
  readExternalFileContent,
}));

// jsdom lacks the blob URL APIs; stub them once for the file (component
// cleanups may run after afterEach, so the stubs must never disappear).
Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:mock-image' });
Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });

const BRAIN_SNAPSHOT = '/Users/azrael/.gemini/antigravity-cli/brain/47b517a6/gallery_npc_section_perfect.jpg';

const imageBySrc = (src: string): HTMLElement | undefined =>
  screen.queryAllByRole('img').find((img) => img.getAttribute('src') === src);

afterEach(() => {
  readExternalFileContent.mockReset();
});

describe('Markdown local image resolution', () => {
  it('resolves a bare absolute filesystem path through the read-only endpoint', async () => {
    readExternalFileContent.mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['jpeg-bytes'], { type: 'image/jpeg' }),
    });

    render(<Markdown>{`![NPC 对话窗口重构效果](${BRAIN_SNAPSHOT})`}</Markdown>);

    await waitFor(() => {
      expect(imageBySrc('blob:mock-image')).toBeDefined();
    });
    expect(readExternalFileContent).toHaveBeenCalledWith(BRAIN_SNAPSHOT, expect.anything());
  });

  it('converts a file:// image URL to its filesystem path', async () => {
    readExternalFileContent.mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['png-bytes'], { type: 'image/png' }),
    });

    render(<Markdown>{'![snap](file:///Users/azrael/brain/snap.png)'}</Markdown>);

    await waitFor(() => {
      expect(imageBySrc('blob:mock-image')).toBeDefined();
    });
    expect(readExternalFileContent).toHaveBeenCalledWith('/Users/azrael/brain/snap.png', expect.anything());
  });

  it('falls back to the raw src when the endpoint refuses the path', async () => {
    readExternalFileContent.mockResolvedValue({ ok: false, status: 403 });

    render(<Markdown>{`![snap](${BRAIN_SNAPSHOT})`}</Markdown>);

    await waitFor(() => {
      expect(imageBySrc(BRAIN_SNAPSHOT)).toBeDefined();
    });
  });

  it('leaves remote images untouched', () => {
    render(<Markdown>{'![remote](https://example.com/hero.png)'}</Markdown>);

    expect(imageBySrc('https://example.com/hero.png')).toBeDefined();
    expect(readExternalFileContent).not.toHaveBeenCalled();
  });

  it('leaves web-relative static paths untouched without querying external files', () => {
    render(<Markdown>{'![logo](/logo.png) ![assets](/assets/banner.png)'}</Markdown>);

    expect(imageBySrc('/logo.png')).toBeDefined();
    expect(imageBySrc('/assets/banner.png')).toBeDefined();
    expect(readExternalFileContent).not.toHaveBeenCalled();
  });
});
