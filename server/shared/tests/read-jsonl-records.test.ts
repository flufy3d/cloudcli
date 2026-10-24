import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as sharedUtils from '@/shared/utils.js';

test('JSONL scanning keeps valid records in order and tolerates a partial tail', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jsonl-scan-'));
  try {
    const filename = path.join(directory, 'records.jsonl');
    await writeFile(filename, '{"id":1}\n\n{"id":2}\n{"unfinished":');
    const records = [];
    for await (const record of sharedUtils.readJsonlRecords(filename)) records.push(record);
    assert.deepEqual(records, [{ id: 1 }, { id: 2 }]);
    await assert.rejects(async () => { for await (const _record of sharedUtils.readJsonlRecords(path.join(directory, 'missing'))) { /* consume */ } }, /ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
