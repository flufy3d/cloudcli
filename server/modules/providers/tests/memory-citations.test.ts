/**
 * Memory Citation Tests
 *
 * Every engine that consults stored memory annotates the reply with
 * machine-readable markup. Left in the prose it renders as raw tags in the
 * transcript, so one shared module strips it and turns it into citations.
 * These cases pin both engines' shapes and the contract the transcript relies
 * on: prose survives, provenance comes out as data.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { liftMemoryCitations } from '@/modules/providers/shared/memory-citations.js';

test('codex trailing citation block is lifted out of the reply', () => {
  const reply = [
    'Here is the answer.',
    '<oai-mem-citation>',
    '<citation_entries>',
    'MEMORY.md:137-142|note=[used verified container provisioning details]',
    'notes/deploy.md:4-9',
    '</citation_entries>',
    '<rollout_ids>',
    '019eda6d-c2f7-70c1-8b42-bf03c44a1f35',
    '</rollout_ids>',
    '</oai-mem-citation>',
  ].join('\n');

  const { text, memoryCitations } = liftMemoryCitations('codex', reply);

  assert.equal(text, 'Here is the answer.');
  assert.deepEqual(memoryCitations, [
    { source: 'MEMORY.md:137-142', note: 'used verified container provisioning details' },
    { source: 'notes/deploy.md:4-9' },
  ]);
});

test('claude inline citation tags come off but their sentences stay', () => {
  // The tag wraps prose the user must still read — unlike Codex's trailing
  // block, dropping the wrapped text would delete part of the answer.
  const reply = 'Before. <cc-memory filenames="deploy.md">The deploy is yours to run.</cc-memory> After.';

  const { text, memoryCitations } = liftMemoryCitations('claude', reply);

  assert.equal(text, 'Before. The deploy is yours to run. After.');
  assert.deepEqual(memoryCitations, [{ source: 'deploy.md' }]);
});

test('claude citations across several tags are listed once each, in first-cited order', () => {
  const reply = [
    '<cc-memory filenames="b.md, a.md">First claim.</cc-memory>',
    '<cc-memory filenames="a.md">Second claim.</cc-memory>',
  ].join('\n');

  const { text, memoryCitations } = liftMemoryCitations('claude', reply);

  assert.equal(text, 'First claim.\nSecond claim.');
  assert.deepEqual(memoryCitations, [{ source: 'b.md' }, { source: 'a.md' }]);
});

test('a claude tag spanning multiple lines is unwrapped whole', () => {
  const reply = '<cc-memory filenames="notes.md">One line.\nAnd another.</cc-memory>';

  const { text, memoryCitations } = liftMemoryCitations('claude', reply);

  assert.equal(text, 'One line.\nAnd another.');
  assert.deepEqual(memoryCitations, [{ source: 'notes.md' }]);
});

test('a reply without memory markup is returned untouched and uncited', () => {
  // `memoryCitations` must be absent rather than empty: an empty array would
  // render an empty footnote under a reply that cited nothing.
  for (const provider of ['claude', 'codex', 'antigravity', 'zcode'] as const) {
    const { text, memoryCitations } = liftMemoryCitations(provider, 'Plain answer.');
    assert.equal(text, 'Plain answer.', provider);
    assert.equal(memoryCitations, undefined, provider);
  }
});

test('engines without memory markup keep citation-looking text verbatim', () => {
  // Only the engine that produced the markup may have it stripped; otherwise a
  // quoted example in someone else's reply would silently lose its tags.
  const reply = 'Example: <cc-memory filenames="x.md">sample</cc-memory>';

  const { text, memoryCitations } = liftMemoryCitations('antigravity', reply);

  assert.equal(text, reply);
  assert.equal(memoryCitations, undefined);
});
