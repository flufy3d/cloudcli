import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { ChatAttachment } from '@/shared/types';
import { api } from '@/shared/api';
import ChatMessageFiles from '@/modules/chat/transcript/ChatMessageFiles';

vi.mock('@/shared/api', () => ({
  api: { assets: { file: vi.fn() } },
}));

const mockAssetsFile = vi.mocked(api.assets.file);

function stubShareApis(supported: boolean, share: (data: ShareData) => Promise<void> = () => Promise.resolve()): void {
  Object.defineProperty(navigator, 'canShare', {
    configurable: true,
    value: (data?: ShareData) => supported && (data?.files?.length ?? 0) > 0,
  });
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: vi.fn(share),
  });
}

function restoreShareApis(): void {
  Reflect.deleteProperty(navigator, 'canShare');
  Reflect.deleteProperty(navigator, 'share');
}

function stubBlobUrls(): void {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:mock' });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
}

function restoreBlobUrls(): void {
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
}

const fileAttachments: ChatAttachment[] = [
  { name: 'mir-lite-log.txt', path: '/home/x/.cloudcli/assets/123-456-mir-lite-log.txt', mimeType: 'text/plain', size: 10 },
];

// On iOS (the installed PWA especially) an <a download> click navigates the
// webview to the blob URL and returning reloads the app, so a file card must
// hand the download to the Web Share API whenever the platform can share
// files — the same hand-off the transcript export uses.
describe('ChatMessageFiles download hand-off', () => {
  afterEach(() => {
    restoreShareApis();
    restoreBlobUrls();
    vi.restoreAllMocks();
  });

  it('shares the fetched blob as a file instead of navigating', async () => {
    stubShareApis(true);
    stubBlobUrls();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    mockAssetsFile.mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['log-bytes'], { type: 'text/plain' })),
    } as Awaited<ReturnType<typeof api.assets.file>>);

    render(<ChatMessageFiles files={fileAttachments} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download mir-lite-log.txt' }));

    await waitFor(() => {
      expect(navigator.share).toHaveBeenCalledTimes(1);
    });
    const shareData = vi.mocked(navigator.share).mock.calls[0][0];
    expect(shareData?.files?.[0]?.name).toBe('mir-lite-log.txt');
    // The blob link is what navigates iOS away; it must never be created.
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('falls back to the download link when file sharing is unavailable', async () => {
    stubShareApis(false);
    stubBlobUrls();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    mockAssetsFile.mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['log-bytes'], { type: 'text/plain' })),
    } as Awaited<ReturnType<typeof api.assets.file>>);

    render(<ChatMessageFiles files={fileAttachments} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download mir-lite-log.txt' }));

    await waitFor(() => {
      expect(clickSpy).toHaveBeenCalledTimes(1);
    });
    expect(navigator.share).not.toHaveBeenCalled();
  });
});
