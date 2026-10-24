import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { OutputAssets } from '@/modules/chat/transcript/OutputAssets';
import { TranscriptRenderContext } from '@/modules/chat/context/TranscriptRenderContext';

vi.mock('@/modules/chat/transcript/ChatMessageImages', () => ({ default: ({ images }: { images: unknown[] }) => <div data-testid="images">{images.length}</div> }));
vi.mock('@/modules/chat/transcript/ChatMessageFiles', () => ({ default: ({ files }: { files: unknown[] }) => <div data-testid="files">{files.length}</div> }));

describe('stored output assets', () => {
  it('loads image previews only after expansion and deduplicates repeated references', () => {
    const image = `/api/assets/images/inline-${'a'.repeat(64)}.png`;
    const file = `/api/assets/files/output-${'b'.repeat(64)}.txt`;
    render(<OutputAssets content={`${image} ${image} ${file}`} />);
    expect(screen.queryByTestId('images')).toBeNull();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByTestId('images').textContent).toBe('1');
    expect(screen.getByTestId('files').textContent).toBe('1');
    fireEvent.click(screen.getByRole('button', { expanded: true }));
    expect(screen.queryByTestId('images')).toBeNull();
  });

  it('does not turn arbitrary external addresses or traversal paths into attachments', () => {
    const { container } = render(<OutputAssets content="https://example.com/image.png /api/assets/images/../secret.png" />);
    expect(container.textContent).toBe('');
  });

  it('exports native expandable attachments with self-contained image and download sources', () => {
    const image = `/api/assets/images/inline-${'a'.repeat(64)}.png`;
    const file = `/api/assets/files/output-${'b'.repeat(64)}.txt`;
    const html = renderToStaticMarkup(<TranscriptRenderContext.Provider value={{ isExporting: true, assetData: { [image]: 'data:image/png;base64,QUJD', [file]: 'data:text/plain;base64,REVG' } }}>
      <OutputAssets content={`${image} ${file}`} />
    </TranscriptRenderContext.Provider>);
    expect(html).toContain('<details');
    expect(html).toContain('src="data:image/png;base64,QUJD"');
    expect(html).toContain('href="data:text/plain;base64,REVG"');
    expect(html).toContain('download=');
  });
});
