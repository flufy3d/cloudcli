import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { ChatMessageImage } from '@/modules/chat/transcript/ChatMessageImages';
import { api } from '@/shared/api';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('loads a stored reference in the legacy data field through the authenticated asset API', async () => {
  const filename = `inline-${'a'.repeat(64)}.png`;
  const image = vi.spyOn(api.assets, 'image').mockResolvedValue({ ok: true, blob: async () => new Blob(['image']) } as Response);
  const createObjectURL = vi.fn(() => 'blob:authenticated-image');
  const revokeObjectURL = vi.fn();
  vi.stubGlobal('URL', class extends URL { static createObjectURL = createObjectURL; static revokeObjectURL = revokeObjectURL; });
  const view = render(<ChatMessageImage image={{ data: `/api/assets/images/${filename}`, name: 'screenshot' }} />);
  await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe('blob:authenticated-image'));
  expect(image).toHaveBeenCalledWith(filename, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(createObjectURL).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:authenticated-image');
});

it('keeps existing inline images usable without an API request', () => {
  const image = vi.spyOn(api.assets, 'image');
  render(<ChatMessageImage image={{ data: 'data:image/png;base64,QUJD', name: 'inline' }} />);
  expect(screen.getByRole('img').getAttribute('src')).toBe('data:image/png;base64,QUJD');
  expect(image).not.toHaveBeenCalled();
});
