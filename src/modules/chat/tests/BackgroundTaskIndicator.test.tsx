import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { ActiveBackgroundTask } from '@/shared/types';
import BackgroundTaskIndicator from '@/modules/chat/composer/BackgroundTaskIndicator';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; count?: number }) => {
      if (options?.defaultValue) return options.defaultValue;
      return key;
    },
  }),
}));

describe('BackgroundTaskIndicator', () => {
  it('renders nothing when task list is empty', () => {
    const { container } = render(<BackgroundTaskIndicator tasks={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders active background tasks with command and toolName', () => {
    const tasks: ActiveBackgroundTask[] = [
      {
        id: 'task-1',
        toolName: 'Bash',
        command: 'pnpm run build',
        startedAt: Date.now() - 5000,
      },
    ];

    render(<BackgroundTaskIndicator tasks={tasks} />);

    expect(screen.getByText(/pnpm run build/)).toBeTruthy();
    expect(screen.getByText(/Bash/)).toBeTruthy();
  });

  it('renders description or taskId when command is not present', () => {
    const tasks: ActiveBackgroundTask[] = [
      {
        id: 'subagent-abc',
        toolName: 'Task',
        description: 'Searching codebase',
        startedAt: Date.now() - 10000,
      },
    ];

    render(<BackgroundTaskIndicator tasks={tasks} />);

    expect(screen.getByText(/Searching codebase/)).toBeTruthy();
    expect(screen.getByText(/Task/)).toBeTruthy();
  });

  it('triggers onAbort when abort button is clicked', () => {
    const onAbort = vi.fn();
    const tasks: ActiveBackgroundTask[] = [
      {
        id: 'task-1',
        toolName: 'Bash',
        command: 'pnpm run test',
        startedAt: Date.now(),
      },
    ];

    render(<BackgroundTaskIndicator tasks={tasks} onAbort={onAbort} />);

    const abortButton = screen.getByTitle('中止后台任务');
    expect(abortButton).toBeTruthy();
    abortButton.click();
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  const runningBash: ActiveBackgroundTask[] = [{ id: 'task-1', toolName: 'Bash', command: 'npm run dev', startedAt: Date.now() }];

  it('says a message waits for the tasks when the background work holds the input back', () => {
    render(<BackgroundTaskIndicator tasks={runningBash} queuesInput />);
    expect(screen.getByText('Messages are queued and sent when the tasks finish')).toBeTruthy();
  });

  it('says a message waits for the turn while a reply is streaming', () => {
    render(<BackgroundTaskIndicator tasks={runningBash} queuesInput isReplyInFlight />);
    expect(screen.getByText('Messages are queued and sent when this turn ends')).toBeTruthy();
  });

  it('says a message can go out now when the background work does not hold the input back', () => {
    render(<BackgroundTaskIndicator tasks={runningBash} queuesInput={false} />);
    expect(screen.getByText('Send anytime; background tasks keep running')).toBeTruthy();
    expect(screen.queryByText(/queued/)).toBeNull();
  });
});
