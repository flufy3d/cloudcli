import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Markdown } from '@/modules/chat/transcript/Markdown';
import { ThemeProvider } from '@/shared/context/ThemeContext';
import {
  transformSafariRegexLookbehind,
  findUnguardedLookbehinds,
} from '@/modules/chat/utils/safariRegexCompat';

const renderWithTheme = (ui: React.ReactElement) =>
  render(<ThemeProvider>{ui}</ThemeProvider>);

describe('Safari Lookbehind Compatibility', () => {
  it('transforms lookbehind regex in mdast-util-gfm-autolink-literal to WebKit-compatible form', () => {
    const inputCode = `
      findAndReplace(
        tree,
        [
          [/(https?:\\/\\/|www(?=\\.))([-.\\w]+)([^ \\t\\r\\n]*)/gi, findUrl],
          [/(?<=^|\\s|\\p{P}|\\p{S})([-.\\w+]+)@([-\\w]+(?:\\.[-\\w]+)+)/gu, findEmail]
        ],
        {ignore: ['link', 'linkReference']}
      )
    `;

    const transformed = transformSafariRegexLookbehind(inputCode);
    expect(transformed).not.toContain('(?<=');
    expect(transformed).toContain('([-.\\w+]+)@([-\\w]+(?:\\.[-\\w]+)+)');

    // In WebKit < 16.4, /(?<=...)/ throws SyntaxError: Invalid regular expression: invalid group.
    // The transformed regex must be compilable even if lookbehind is forbidden.
    const regexMatch = transformed.match(/\/([^\/]+)\/([gimsuy]*)/);
    expect(regexMatch).toBeTruthy();
  });

  it('detects unguarded lookbehinds in code snippets', () => {
    const brokenSnippet = 'const r = new RegExp("(?<=^|\\\\s)([-.\\\\w+]+)@test");';
    const violations = findUnguardedLookbehinds(brokenSnippet);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].pattern).toContain('(?<=');

    const guardedSnippet = 'try { return !!new RegExp("(?<=1)(?<!1)"); } catch { return false; }';
    const guardedViolations = findUnguardedLookbehinds(guardedSnippet);
    expect(guardedViolations.length).toBe(0);
  });

  it('renders email autolinks cleanly in Markdown component without lookbehind runtime error', () => {
    renderWithTheme(<Markdown>{'Contact us at support@example.com for help.'}</Markdown>);

    const emailLink = screen.getByRole('link', { name: 'support@example.com' });
    expect(emailLink).toBeTruthy();
    expect(emailLink.getAttribute('href')).toBe('mailto:support@example.com');
  });
});
