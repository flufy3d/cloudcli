import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import QueuedMessageCard from '@/modules/chat/composer/QueuedMessageCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => {
      if (options?.defaultValue) return options.defaultValue;
      return key;
    },
  }),
}));

describe('QueuedMessageCard', () => {
  it('renders queued message and triggers edit and delete', () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();

    render(
      <QueuedMessageCard
        content="hello queued message"
        onEdit={onEdit}
        onDelete={onDelete}
      />,
    );

    expect(screen.getByText('hello queued message')).toBeTruthy();
    expect(screen.getByText(/Will send when this finishes/)).toBeTruthy();

    const editBtn = screen.getByTitle('Edit queued message');
    fireEvent.click(editBtn);
    expect(onEdit).toHaveBeenCalledTimes(1);

    const deleteBtn = screen.getByTitle('Delete queued message');
    fireEvent.click(deleteBtn);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('renders force send button and custom hint when waiting for background tasks', () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const onForceSend = vi.fn();

    render(
      <QueuedMessageCard
        content="run now please"
        onEdit={onEdit}
        onDelete={onDelete}
        onForceSend={onForceSend}
        isWaitingForBackgroundTasks={true}
      />,
    );

    expect(screen.getByText(/后台任务完成后将自动发送/)).toBeTruthy();

    const forceSendBtn = screen.getByTitle('立即发送并中断后台任务');
    expect(forceSendBtn).toBeTruthy();

    fireEvent.click(forceSendBtn);
    expect(onForceSend).toHaveBeenCalledTimes(1);
  });
});
