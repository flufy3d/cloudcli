import { useEffect, useState } from 'react';

import type { MarkdownImageContext } from '@/shared/types';
import { api, readExternalFileContent } from '@/shared/api';
import { UnifiedImageViewer } from '@/shared/ui';
import { resolveMarkdownImageTarget } from '@/modules/code-editor/utils/markdownImagePath';

type MarkdownPreviewImageProps = {
  node?: unknown;
  src?: string;
  alt?: string;
  title?: string;
  context: MarkdownImageContext;
};

// Keyed by the request, so a source change reads as "loading" until the new
// fetch settles rather than showing the previous image.
type LoadedImage = { key: string; url: string | null; failed: boolean };

/**
 * `img` renderer for the code editor's markdown preview. Workspace images are
 * fetched with the auth header and handed to `<img>` as object URLs, web images
 * pass straight through, and anything unresolvable falls back to its
 * alternative text instead of a broken-image placeholder. Clicking a resolved
 * image opens the shared image viewer.
 *
 * Used by code-editor's MarkdownPreview, which serves the code editor's file
 * viewer and the PRD editor; chat renders markdown through its own Markdown
 * component instead.
 */
export default function MarkdownPreviewImage({ src, alt, title, context }: MarkdownPreviewImageProps) {
  const source = src ?? '';
  const { projectId } = context;
  // Cheap string work, so it is redone per render rather than memoized on a
  // context object whose identity the caller does not guarantee.
  const target = resolveMarkdownImageTarget(source, context);
  // The bytes fetched for the current target; null while they are in flight.
  const [loaded, setLoaded] = useState<LoadedImage | null>(null);
  // Controls the viewer only after a resolved image is clicked: closing it must
  // keep the image in the document, so it cannot be derived from the URL.
  const [expanded, setExpanded] = useState(false);

  const targetKind = target.kind;
  const targetPath = targetKind === 'file' ? target.path : '';
  const targetIsExternal = targetKind === 'file' ? target.external : false;
  const key = `${targetKind}:${targetIsExternal ? 'external' : 'project'}:${targetPath}:${source}`;

  useEffect(() => {
    if (targetKind !== 'file') {
      return;
    }

    let objectUrl: string | null = null;
    const controller = new AbortController();

    const load = async () => {
      try {
        // A bare <img src> cannot carry the auth header the files routes
        // require, so the bytes are fetched here and exposed as an object URL.
        const response = targetIsExternal
          ? await readExternalFileContent(targetPath, { signal: controller.signal }, projectId)
          : await api.readFileBlob(projectId!, targetPath, { signal: controller.signal });
        if (!response.ok) {
          setLoaded({ key, url: null, failed: true });
          return;
        }
        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        setLoaded({ key, url: objectUrl, failed: false });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return;
        }
        setLoaded({ key, url: null, failed: true });
      }
    };

    void load();

    return () => {
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [key, targetKind, targetIsExternal, targetPath, projectId]);

  const label = alt || source;

  if (targetKind === 'browser') {
    return (
      <img
        src={target.src}
        alt={alt ?? ''}
        title={title}
        loading="lazy"
        decoding="async"
        className="my-2 rounded-lg"
      />
    );
  }

  const current = loaded && loaded.key === key ? loaded : null;

  if (targetKind !== 'file' || current?.failed) {
    // No route can serve this path; the alternative text keeps the document
    // readable without a broken-image icon.
    return <span className="text-xs italic text-muted-foreground">{label}</span>;
  }

  if (!current?.url) {
    return <span aria-hidden="true" className="my-2 block h-40 max-w-md animate-pulse rounded-lg bg-muted" />;
  }

  return (
    <>
      <img
        src={current.url}
        alt={alt ?? ''}
        title={title}
        loading="lazy"
        decoding="async"
        onClick={() => setExpanded(true)}
        className="my-2 cursor-zoom-in rounded-lg"
      />
      {expanded && (
        <UnifiedImageViewer
          src={current.url}
          alt={label}
          title={title || label}
          filePath={targetPath}
          onClose={() => setExpanded(false)}
        />
      )}
    </>
  );
}
