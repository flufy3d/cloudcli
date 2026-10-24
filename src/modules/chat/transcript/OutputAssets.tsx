import { useContext, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import ChatMessageImages from '@/modules/chat/transcript/ChatMessageImages';
import ChatMessageFiles from '@/modules/chat/transcript/ChatMessageFiles';
import { TranscriptRenderContext } from '@/modules/chat/context/TranscriptRenderContext';
import { collectStoredOutputAssets } from '@/shared/utils';

/** MessageComponent exposes stored tool media and full text without eagerly loading images. */
export function OutputAssets({ content }: { content: string }) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);
  const { isExporting, assetData } = useContext(TranscriptRenderContext);
  const assets = useMemo(() => {
    const references = collectStoredOutputAssets(content);
    return {
      images: [...references].filter((ref) => ref.startsWith('/api/assets/images/')).map((ref) => ({ path: ref })),
      files: [...references].filter((ref) => ref.startsWith('/api/assets/files/')).map((ref) => ({ path: ref, name: t('misc.fullOutput', { defaultValue: 'Full output.txt' }) })),
    };
  }, [content, t]);
  const count = assets.images.length + assets.files.length;
  if (count === 0) return null;
  const label = t('misc.outputAssets', { count, defaultValue: 'Output attachments ({{count}})' });
  if (isExporting) {
    return <details className="mt-2 max-w-full">
      <summary>{label}</summary>
      {assets.images.map((image) => <a key={image.path} href={assetData?.[image.path]} download={image.path.split('/').pop()}>
        <img src={assetData?.[image.path]} alt={image.path.split('/').pop()} className="max-w-full" />
      </a>)}
      {assets.files.map((file) => <a key={file.path} href={assetData?.[file.path]} download={file.name}>{file.name}</a>)}
    </details>;
  }

  return (
    <div className="mt-2 max-w-full">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted focus-visible:outline focus-visible:outline-2">
        {label}
      </button>
      {expanded && <div className="mt-2 flex flex-wrap gap-2">
        {assets.images.length > 0 && <ChatMessageImages images={assets.images} />}
        {assets.files.length > 0 && <ChatMessageFiles files={assets.files} />}
      </div>}
    </div>
  );
}
