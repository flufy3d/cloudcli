import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookMarked, ChevronRight } from 'lucide-react';

import type { MemoryCitation } from '@/shared/types';
import { cn } from '@/shared/utils';

/**
 * Footnote listing the stored memory an assistant reply drew on.
 *
 * Engines annotate a memory-derived reply with machine-readable markup — Codex
 * appends a trailing block, Claude wraps the sentence it used — which reads as
 * stray tags in the prose. The backend lifts it out (see the providers'
 * `memory-citations` module) and the reply keeps the provenance here instead:
 * collapsed to a single line, expandable to the sources and what each
 * contributed.
 *
 * Rendered by chat's MessageComponent under any assistant message whose
 * provider reported citations.
 */
export const MemoryCitations = memo(({ citations }: { citations: MemoryCitation[] }) => {
  const { t } = useTranslation('chat');
  const [isOpen, setIsOpen] = useState(false);

  if (citations.length === 0) {
    return null;
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((previous) => !previous)}
        className="flex items-center gap-1.5 rounded-md border border-border/50 bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <BookMarked className="h-3 w-3 flex-shrink-0" />
        <span>{t('memory.used', { count: citations.length })}</span>
        <ChevronRight className={cn('h-3 w-3 flex-shrink-0 transition-transform duration-150', isOpen && 'rotate-90')} />
      </button>

      {isOpen && (
        <ul className="mt-1 space-y-1 border-l border-border/60 pl-2.5">
          {citations.map((citation) => (
            <li key={citation.source} className="text-[11px] leading-snug">
              <span className="font-mono text-muted-foreground">{citation.source}</span>
              {citation.note && (
                <span className="ml-1.5 text-muted-foreground/70">{citation.note}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
MemoryCitations.displayName = 'MemoryCitations';
