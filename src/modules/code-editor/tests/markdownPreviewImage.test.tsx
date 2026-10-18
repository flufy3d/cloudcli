import assert from 'node:assert/strict';

import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, it, vi } from 'vitest';

import type { MarkdownImageContext } from '@/shared/types';
import MarkdownPreview from '@/modules/code-editor/markdown/MarkdownPreview';
import {
  imageBaseDirFromFilePath,
  resolveDocumentRelativePath,
  resolveMarkdownImageTarget,
} from '@/modules/code-editor/utils/markdownImagePath';

const readFileBlob = vi.fn();
const readExternalFileContent = vi.fn();
vi.mock('@/shared/api', () => ({
  api: {
    readFileBlob: (...args: unknown[]) => readFileBlob(...args),
  },
  readExternalFileContent: (...args: unknown[]) => readExternalFileContent(...args),
}));

/**
 * A markdown preview that shows `![](../images/x.png)` has to resolve the path
 * against the document's own directory and fetch the bytes through the
 * authenticated files route: a bare <img src> resolves against the page URL and
 * 404s, and the route needs an auth header an <img> cannot carry.
 */

const OBJECT_URL = 'blob:mock-image';
// jsdom has no object URLs at all, so these are stubbed for the whole file.
const createObjectURL = vi.fn(() => OBJECT_URL);
const revokeObjectURL = vi.fn();
URL.createObjectURL = createObjectURL;
URL.revokeObjectURL = revokeObjectURL;

const okResponse = () => ({ ok: true, blob: async () => new Blob(['png']) });
const failedResponse = () => ({ ok: false, blob: async () => new Blob() });

beforeEach(() => {
  readFileBlob.mockReset();
  readExternalFileContent.mockReset();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
});

const projectContext: MarkdownImageContext = {
  projectId: 'project-1',
  baseDir: '/repo/docs',
  isExternal: false,
};

describe('resolveDocumentRelativePath', () => {
  it('climbs out of the document directory for ../ references', () => {
    assert.equal(resolveDocumentRelativePath('/repo/docs', '../public/a.png'), '/repo/public/a.png');
  });

  it('keeps the document directory for plain relative references', () => {
    assert.equal(resolveDocumentRelativePath('/repo/docs', 'images/a.png'), '/repo/docs/images/a.png');
    assert.equal(resolveDocumentRelativePath('/repo/docs', './a.png'), '/repo/docs/a.png');
  });

  it('treats a leading slash as absolute and ignores the document directory', () => {
    assert.equal(resolveDocumentRelativePath('/repo/docs', '/other/a.png'), '/other/a.png');
    assert.equal(resolveDocumentRelativePath('/repo/docs', '/other/../a.png'), '/a.png');
  });

  it('never climbs above the filesystem root', () => {
    assert.equal(resolveDocumentRelativePath('/repo/docs', '../../../../a.png'), '/a.png');
  });
});

describe('imageBaseDirFromFilePath', () => {
  it('returns the document directory', () => {
    assert.equal(imageBaseDirFromFilePath('/repo/docs/README.md'), '/repo/docs');
    assert.equal(imageBaseDirFromFilePath('/README.md'), '/');
  });

  it('normalizes windows separators', () => {
    assert.equal(imageBaseDirFromFilePath('C:/repo/docs/a.md'), 'C:/repo/docs');
  });

  it('returns undefined when the path carries no directory', () => {
    assert.equal(imageBaseDirFromFilePath('README.md'), undefined);
  });
});

describe('resolveMarkdownImageTarget', () => {
  it('lets the browser load web, data and blob sources', () => {
    assert.deepEqual(
      resolveMarkdownImageTarget('https://example.com/a.png', projectContext),
      { kind: 'browser', src: 'https://example.com/a.png' },
    );
    assert.deepEqual(
      resolveMarkdownImageTarget('data:image/png;base64,AA', projectContext),
      { kind: 'browser', src: 'data:image/png;base64,AA' },
    );
  });

  it('decodes escaped characters before building a workspace path', () => {
    assert.deepEqual(
      resolveMarkdownImageTarget('my%20im%C3%A1genes/gato.png', projectContext),
      { kind: 'file', path: '/repo/docs/my imágenes/gato.png', external: false },
    );
  });

  it('resolves a relative path against the document directory', () => {
    assert.deepEqual(
      resolveMarkdownImageTarget('../public/a.png', projectContext),
      { kind: 'file', path: '/repo/public/a.png', external: false },
    );
  });

  it('passes an absolute path through on the project route', () => {
    assert.deepEqual(
      resolveMarkdownImageTarget('/repo/images/a.png', projectContext),
      { kind: 'file', path: '/repo/images/a.png', external: false },
    );
    assert.deepEqual(
      resolveMarkdownImageTarget('file:///repo/images/a.png', projectContext),
      { kind: 'file', path: '/repo/images/a.png', external: false },
    );
  });

  it('routes an external document through the read-only route', () => {
    assert.deepEqual(
      resolveMarkdownImageTarget('images/a.png', { baseDir: '/ext/docs', isExternal: true }),
      { kind: 'file', path: '/ext/docs/images/a.png', external: true },
    );
    assert.deepEqual(
      resolveMarkdownImageTarget('/ext/images/a.png', { isExternal: true }),
      { kind: 'file', path: '/ext/images/a.png', external: true },
    );
  });

  it('falls back to the project root when the caller has no document directory', () => {
    assert.deepEqual(
      resolveMarkdownImageTarget('images/a.png', { projectId: 'project-1', isExternal: false }),
      { kind: 'file', path: 'images/a.png', external: false },
    );
  });

  it('is unresolved without a route to read from', () => {
    assert.deepEqual(resolveMarkdownImageTarget('', projectContext), { kind: 'unresolved' });
    assert.deepEqual(
      resolveMarkdownImageTarget('images/a.png', { isExternal: false }),
      { kind: 'unresolved' },
    );
    assert.deepEqual(
      resolveMarkdownImageTarget('images/a.png', { isExternal: true }),
      { kind: 'unresolved' },
    );
  });
});

describe('MarkdownPreview images', () => {
  it('fetches a document-relative image and shows the blob', async () => {
    readFileBlob.mockResolvedValue(okResponse());

    const { findByRole } = render(
      <MarkdownPreview content={'![gato](../public/gato.png)'} imageContext={projectContext} />,
    );

    const img = (await findByRole('img')) as HTMLImageElement;
    assert.equal(img.getAttribute('src'), OBJECT_URL);
    assert.deepEqual(readFileBlob.mock.calls[0].slice(0, 2), ['project-1', '/repo/public/gato.png']);
  });

  it('keeps a file:// image source through the default url transform', async () => {
    // ReactMarkdown's default urlTransform blanks `file:` URLs, so the preview
    // has to pass markdownUrlTransform explicitly or this never reaches a route.
    readFileBlob.mockResolvedValue(okResponse());

    const { findByRole } = render(
      <MarkdownPreview content={'![gato](file:///repo/images/gato.png)'} imageContext={projectContext} />,
    );

    await findByRole('img');
    assert.deepEqual(readFileBlob.mock.calls[0].slice(0, 2), ['project-1', '/repo/images/gato.png']);
  });

  it('leaves web images to the browser', () => {
    const { getByRole } = render(
      <MarkdownPreview content={'![logo](https://example.com/logo.png)'} imageContext={projectContext} />,
    );

    const img = getByRole('img') as HTMLImageElement;
    assert.equal(img.getAttribute('src'), 'https://example.com/logo.png');
    assert.equal(readFileBlob.mock.calls.length, 0);
  });

  it('reads an external document image through the external route', async () => {
    readExternalFileContent.mockResolvedValue(okResponse());

    const { findByRole } = render(
      <MarkdownPreview
        content={'![plan](img/plan.png)'}
        imageContext={{ baseDir: '/ext/docs', isExternal: true }}
      />,
    );

    await findByRole('img');
    assert.equal(readExternalFileContent.mock.calls[0][0], '/ext/docs/img/plan.png');
    assert.equal(readFileBlob.mock.calls.length, 0);
  });

  it('shows the alt text instead of a broken image when the read fails', async () => {
    readFileBlob.mockResolvedValue(failedResponse());

    const { findByText, queryByRole } = render(
      <MarkdownPreview content={'![gato](images/gato.png)'} imageContext={projectContext} />,
    );

    await findByText('gato');
    assert.equal(queryByRole('img'), null);
  });

  it('shows the alt text when no context can resolve the path', async () => {
    const { findByText } = render(<MarkdownPreview content={'![gato](images/gato.png)'} />);

    await findByText('gato');
    assert.equal(readFileBlob.mock.calls.length, 0);
  });

  it('opens the shared image viewer when the resolved image is clicked', async () => {
    readFileBlob.mockResolvedValue(okResponse());

    const { findByRole, queryByRole } = render(
      <MarkdownPreview content={'![gato](images/gato.png)'} imageContext={projectContext} />,
    );

    const img = await findByRole('img');
    assert.equal(queryByRole('dialog'), null);

    fireEvent.click(img);
    await waitFor(() => assert.ok(queryByRole('dialog')));

    fireEvent.click(queryByRole('dialog')!.querySelector('[aria-label="关闭图片预览"]')!);
    await waitFor(() => assert.equal(queryByRole('dialog'), null));
  });

  it('revokes the object URL when the preview unmounts', async () => {
    readFileBlob.mockResolvedValue(okResponse());

    const { findByRole, unmount } = render(
      <MarkdownPreview content={'![gato](images/gato.png)'} imageContext={projectContext} />,
    );
    await findByRole('img');
    unmount();

    await waitFor(() => assert.equal(revokeObjectURL.mock.calls[0]?.[0], OBJECT_URL));
  });
});
