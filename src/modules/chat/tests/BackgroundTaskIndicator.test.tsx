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
});
