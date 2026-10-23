import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Markdown } from '@/modules/chat/transcript/Markdown';
import { ThemeProvider } from '@/shared/context/ThemeContext';

/**
 * Pins the parse budget: micromark resolves emphasis in quadratic time over
 * one inline run, so a degenerate model output — a single 190KB line of
 * `**`/「 fragments — froze the tab for a minute. Text whose longest inline
 * run exceeds the budget renders verbatim instead; ordinary markdown, and long
 * code blocks or tables (parsed per line/cell), still render as markdown.
 */

vi.mock('@/modules/command-palette', () => ({
  usePaletteOps: () => ({ openFileInEditor: vi.fn(), openDirectory: vi.fn() }),
}));

const renderWithTheme = (ui: React.ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>);

// Shape of the real degenerate output: emphasis fragments on one huge line.
const degenerateLine = '——**「面前无对象」**——**FF96=0**'.repeat(800);

describe('Markdown parse budget', () => {
  it('renders an over-budget inline run as plain text without parsing it', () => {
    const started = performance.now();
    const { container } = renderWithTheme(<Markdown>{`# Heading\n\n${degenerateLine}`}</Markdown>);

    expect(performance.now() - started).toBeLessThan(2000);
    expect(container.querySelector('strong')).toBeNull();
    expect(container.querySelector('h1')).toBeNull();
    expect(container.textContent).toContain('**「面前无对象」**');
    expect(container.textContent).toContain('# Heading');
  });

  it('keeps rendering ordinary markdown', () => {
    const { container } = renderWithTheme(<Markdown>{'# Heading\n\nSome **bold** text.'}</Markdown>);

    expect(container.querySelector('h1')?.textContent).toBe('Heading');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
  });

  it('does not count fenced code toward the inline budget', () => {
    const code = Array.from({ length: 1500 }, (_, i) => `const value${i} = ${i};`).join('\n');
    const { container } = renderWithTheme(<Markdown>{`Some **bold** text.\n\n\`\`\`\n${code}\n\`\`\``}</Markdown>);

    expect(container.querySelector('strong')?.textContent).toBe('bold');
  });

  it('measures table rows one line at a time', () => {
    const rows = Array.from({ length: 600 }, (_, i) => `| row ${i} | value ${i} |`).join('\n');
    const { container } = renderWithTheme(<Markdown>{`| a | b |\n| --- | --- |\n${rows}`}</Markdown>);

    expect(container.querySelector('table')).not.toBeNull();
  });
});
