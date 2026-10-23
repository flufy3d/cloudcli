import assert from 'node:assert/strict';
import test from 'node:test';

import { readCompactCommand } from '@/shared/utils.js';

test('a bare /compact is a compaction request without instructions', () => {
  assert.deepEqual(readCompactCommand('/compact'), { instructions: '' });
  assert.deepEqual(readCompactCommand('  /compact  \n'), { instructions: '' });
});

test('text after /compact is carried as its instructions, line breaks included', () => {
  assert.deepEqual(readCompactCommand('/compact keep the API notes'), { instructions: 'keep the API notes' });
  assert.deepEqual(readCompactCommand('/compact\nfirst\nsecond '), { instructions: 'first\nsecond' });
});

test('anything that is not exactly the /compact command is an ordinary message', () => {
  assert.equal(readCompactCommand('/compacted'), null);
  assert.equal(readCompactCommand('/compact-now'), null);
  assert.equal(readCompactCommand('please /compact'), null);
  assert.equal(readCompactCommand('/Compact'), null);
  assert.equal(readCompactCommand(''), null);
  assert.equal(readCompactCommand(undefined), null);
  assert.equal(readCompactCommand(42), null);
});
