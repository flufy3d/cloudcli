import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TerminalIcon, Square } from 'lucide-react';

import type { ActiveBackgroundTask } from '@/shared/types';

type BackgroundTaskIndicatorProps = {
  tasks: ActiveBackgroundTask[];
  onAbort?: () => void;
  /** A message sent now is queued; without it the strip says a message can go out at once. */
  queuesInput?: boolean;
  /** A reply is streaming, so a queued message goes out when this turn ends. */
  isReplyInFlight?: boolean;
};

function formatElapsed(elapsedSeconds: number): string {
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  if (minutes < 1) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

/** Used by ChatComposer to display running background tasks. */
export default function BackgroundTaskIndicator({ tasks, onAbort, queuesInput = true, isReplyInFlight = false }: BackgroundTaskIndicatorProps) {
  const { t } = useTranslation('chat');
  const [, setTick] = useState(0);

  // Periodically refresh elapsed time every second while tasks are running
  useEffect(() => {
    if (tasks.length === 0) return;
    const interval = setInterval(() => {
      setTick((tick) => tick + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [tasks.length]);

  if (!tasks || tasks.length === 0) {
    return null;
  }

  return (
    <div
      className="settings-content-enter mx-auto mb-2 max-w-[54.25rem] rounded-xl border border-sky-500/25 bg-sky-500/[0.04] px-3 py-2 text-xs"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-2 border-b border-sky-500/15 pb-1.5">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-sky-500" />
          </span>
          <span className="font-medium text-foreground">
            {t('composer.backgroundTasks.title', {
              count: tasks.length,
              defaultValue: '后台任务运行中 ({{count}})',
            })}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground/80">
            <span className="hidden sm:inline">
              {isReplyInFlight
                ? t('composer.backgroundTasks.hintTurn', { defaultValue: 'Messages are queued and sent when this turn ends' })
                : queuesInput
                  ? t('composer.backgroundTasks.hint', { defaultValue: 'Messages are queued and sent when the tasks finish' })
                  : t('composer.backgroundTasks.hintContinue', { defaultValue: 'Send anytime; background tasks keep running' })}
            </span>
            <span className="sm:hidden">
              {isReplyInFlight
                ? t('composer.backgroundTasks.hintTurnShort', { defaultValue: 'Sent after this turn' })
                : queuesInput
                  ? t('composer.backgroundTasks.hintShort', { defaultValue: 'Sending queues' })
                  : t('composer.backgroundTasks.hintContinueShort', { defaultValue: 'Send anytime' })}
            </span>
          </span>
          {onAbort && (
            <button
              type="button"
              onClick={onAbort}
              aria-label={t('composer.backgroundTasks.abort', { defaultValue: '中止后台任务' })}
              title={t('composer.backgroundTasks.abort', { defaultValue: '中止后台任务' })}
              className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/10"
            >
              <Square className="h-2.5 w-2.5 fill-current" />
              <span>{t('composer.backgroundTasks.abortButton', { defaultValue: '中止' })}</span>
            </button>
          )}
        </div>
      </div>

      <div className="mt-1.5 max-h-36 space-y-1 overflow-y-auto">
        {tasks.map((task) => {
          const elapsedSeconds = Math.max(
            0,
            Math.floor((Date.now() - (task.startedAt || Date.now())) / 1000),
          );
          const taskDetail = task.command || task.description || task.id;

          return (
            <div
              key={task.id}
              className="flex items-center justify-between gap-2 rounded-md bg-background/50 px-2 py-1 text-[11px]"
            >
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <TerminalIcon className="h-3 w-3 shrink-0 text-sky-500/80" />
                <span className="shrink-0 font-medium text-sky-600 dark:text-sky-400">
                  {task.toolName}:
                </span>
                <span className="truncate font-mono text-muted-foreground" title={taskDetail}>
                  {taskDetail}
                </span>
              </div>
              <span className="shrink-0 tabular-nums text-muted-foreground/70">
                {formatElapsed(elapsedSeconds)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
