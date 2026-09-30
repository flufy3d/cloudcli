import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Markdown } from '@/modules/chat/transcript/Markdown';
import { ThemeProvider } from '@/shared/context/ThemeContext';

const { openFileInEditor } = vi.hoisted(() => ({
  openFileInEditor: vi.fn(),
}));

vi.mock('@/modules/command-palette', () => ({
  usePaletteOps: () => ({ openFileInEditor }),
}));

afterEach(() => {
  openFileInEditor.mockReset();
});

// Markdown's code blocks read the theme for syntax-highlight colors; wrap
// every render in the provider so the components under test see one.
const renderWithTheme = (ui: React.ReactElement) =>
  render(<ThemeProvider>{ui}</ThemeProvider>);


describe('Markdown file links', () => {
  it('opens a percent-escaped non-ASCII href as its real filesystem path', () => {
    const filePath = '/Users/tester/workspaces/game/reports/体验修复批次_2026-09-17/批V3-11/验收报告.md';

    renderWithTheme(<Markdown>{`[验收报告.md](${filePath})`}</Markdown>);
    fireEvent.click(screen.getByRole('link', { name: '验收报告.md' }));

    expect(openFileInEditor).toHaveBeenCalledOnce();
    // The resolver forwards an optional line anchor after the path; the
    // editor opens at that line when one was quoted in the reference.
    expect(openFileInEditor.mock.calls[0][0]).toBe(filePath);
  });
});
