import assert from 'node:assert/strict';

import { test } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import MarkdownPreview from '@/modules/code-editor/markdown/MarkdownPreview';

// Pins LaTeX bracket-delimiter support for the markdown file viewer: documents
// write display math as \[...\], which CommonMark would otherwise flatten to
// literal text before remark-math ever sees it.
test('renders display math written with bracket delimiters', () => {
  const html = renderToStaticMarkup(
    React.createElement(MarkdownPreview, { content: '\\[ \\mathcal L_{\\text{sup}} \\]' }),
  );

  assert.ok(html.includes('class="katex"'), html);
});

test('renders inline math written with parenthesis delimiters', () => {
  const html = renderToStaticMarkup(
    React.createElement(MarkdownPreview, { content: 'before \\( a+b \\) after' }),
  );

  assert.ok(html.includes('class="katex"'), html);
});
