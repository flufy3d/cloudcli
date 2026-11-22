import { memo } from 'react';
import { ActivityIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { formatByteSize, readContextUsage } from '@/modules/chat/utils/contextUsage';
import { formatTokenCount } from '@/modules/chat/composer/tokenUsage';

type TokenUsageSummaryProps = {
  usage: Record<string, unknown> | null;
  onClick?: () => void;
};

/**
 * Rendered by chat's ChatComposer to show the session's current context size
 * and open the detailed token breakdown on click. On phones it collapses to the
 * bare token count (no icon/percentage) so it never overflows the tool row;
 * from `sm` up it also carries the window percentage. The window *fill* itself
 * is drawn by ContextUsageBar on the composer's top edge.
 *
 * Right after a compaction the token count does not exist yet, so the badge
 * shows the size of the summary that replaced the conversation instead of
 * dropping to "0".
 */
function TokenUsageSummary({ usage, onClick }: TokenUsageSummaryProps) {
  const { t } = useTranslation();
  const { used, total, percent, summaryBytes } = readContextUsage(usage);

  // The engine has no occupancy to report right after a compaction, but the
  // summary that replaced the conversation does have a size — show that rather
  // than a meaningless "0".
  const compacted = used <= 0 && percent === null && summaryBytes > 0;

  // Nothing to report at all: no payload (`null` is how a just-compacted
  // session used to be signalled) or a snapshot with no numbers in it.
  if (used <= 0 && percent === null && !compacted) {
    return null;
  }

  // The button measures the context window's current occupancy, not the
  // session's spend; the tooltip names the window it is measured against so
  // the number cannot be read as a total.
  const title = compacted
    ? t('chat:misc.compactedSummarySize', { size: formatByteSize(summaryBytes) })
    : total > 0
      ? t('chat:misc.contextTokensUsed', {
        used: formatTokenCount(used),
        total: formatTokenCount(total),
        defaultValue: 'Current context: {{used}} / {{total}} tokens',
      })
      : t('chat:misc.tokensUsed', { count: used });

  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 items-center gap-1 rounded-lg border border-border/70 bg-background/70 px-1.5 text-xs text-muted-foreground shadow-sm transition-colors hover:border-primary/25 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:gap-2 sm:px-2.5"
      title={title}
      aria-label={t('chat:misc.showTokenUsage')}
    >
      <span className="hidden h-5 w-5 place-items-center rounded-md bg-primary/10 text-primary sm:grid">
        <ActivityIcon className="h-3.5 w-3.5" />
      </span>
      {compacted ? (
        <span className="font-medium text-foreground">{formatByteSize(summaryBytes)}</span>
      ) : (
        <>
          <span className="font-medium text-foreground">{formatTokenCount(used)}</span>
          {percent !== null && (
            <span className="hidden font-semibold text-foreground/80 sm:inline">{percent}%</span>
          )}
          <span className="hidden text-muted-foreground/70 sm:inline">
            {t('chat:misc.tokensLabel', { count: used })}
          </span>
        </>
      )}
    </button>
  );
}

/** Memoized: the composer re-renders on every keystroke and this row's numbers only move when a turn ends. */
export default memo(TokenUsageSummary);
