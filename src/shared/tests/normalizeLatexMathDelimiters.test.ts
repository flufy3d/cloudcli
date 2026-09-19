import assert from 'node:assert/strict';

import { test } from 'vitest';

import { normalizeLatexMathDelimiters } from '@/shared/utils';

test('rewrites display-math bracket delimiters into the dollar form remark-math parses', () => {
  assert.equal(
    normalizeLatexMathDelimiters('\\[ \\mathcal L_{\\text{sup}} \\]'),
    '$$ \\mathcal L_{\\text{sup}} $$',
  );
});

test('rewrites inline-math bracket delimiters', () => {
  assert.equal(normalizeLatexMathDelimiters('before \\( a+b \\) after'), 'before $$ a+b $$ after');
});

test('keeps a multi-line display formula intact', () => {
  assert.equal(
    normalizeLatexMathDelimiters('\\[\nE = mc^2\n\\]'),
    '$$\nE = mc^2\n$$',
  );
});

test('leaves fenced code blocks untouched, including closing with a longer fence', () => {
  const source = '```latex\n\\[ x \\]\n````\n\n\\[ y \\]';
  assert.equal(
    normalizeLatexMathDelimiters(source),
    '```latex\n\\[ x \\]\n````\n\n$$ y $$',
  );
});

test('leaves tilde fences untouched', () => {
  const source = '~~~\n\\( a \\)\n~~~';
  assert.equal(normalizeLatexMathDelimiters(source), source);
});

test('leaves inline code spans untouched', () => {
  assert.equal(
    normalizeLatexMathDelimiters('use `\\[ x \\]` for display, \\( y \\) for inline'),
    'use `\\[ x \\]` for display, $$ y $$ for inline',
  );
});

test('returns text without bracket delimiters unchanged', () => {
  const source = 'plain $5 and $$block$$ text';
  assert.equal(normalizeLatexMathDelimiters(source), source);
});
