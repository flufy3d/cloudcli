import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildClaudeModelsDefinition,
  CLAUDE_PREDEFINED_MODELS,
  CLAUDE_ULTRACODE_EFFORT,
  ClaudeProviderModels,
  extractClaudeEventModel,
  fetchClaudeCliModels,
} from '@/modules/providers/list/claude/claude-models.provider.js';
import { resolveClaudeEffort } from '@/modules/providers/list/claude/claude-runtime.provider.js';

const SESSION_ID = 'session-1';

test('ignores the <synthetic> placeholder Claude Code stamps on synthesized rows', () => {
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { model: '<synthetic>' } },
      SESSION_ID,
    ),
    null,
  );
  assert.equal(
    extractClaudeEventModel({ sessionId: SESSION_ID, model: '<synthetic>' }, SESSION_ID),
    null,
  );
});

test('still surfaces real model ids from message and event fields', () => {
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { model: 'claude-sonnet-5' } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
  assert.equal(
    extractClaudeEventModel({ sessionId: SESSION_ID, model: 'opus' }, SESSION_ID),
    'opus',
  );
});

test('skips a placeholder content part so a later real model tag still wins', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        sessionId: SESSION_ID,
        message: {
          content: [
            { text: '<model><synthetic></model>' },
            { text: '<model>claude-sonnet-5</model>' },
          ],
        },
      },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('a placeholder stdout hit does not shadow a real <model> tag in the same text', () => {
  const text = '<local-command-stdout>Set model to <synthetic></local-command-stdout>'
    + '<model>claude-sonnet-5</model>';
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { content: text } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { content: [{ text }] } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('falls back to the message model when every content hit is a placeholder', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        sessionId: SESSION_ID,
        message: {
          content: '<model><synthetic></model>',
          model: 'claude-sonnet-5',
        },
      },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

// The shape `query().supportedModels()` returns from Claude Code 2.1.303.
const CLI_MODELS = [
  {
    value: 'default',
    displayName: 'Default (recommended)',
    description: 'Opus 5.5 · Best for everyday, complex tasks',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] as const,
  },
  {
    value: 'claude-fable-5-1[1m]',
    displayName: 'Fable',
    description: 'Fable 5.1 · Most capable',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'max'] as const,
  },
  { value: 'haiku', displayName: 'Haiku', description: 'Haiku 5.5 · Fastest' },
];

test('maps the CLI model list one-to-one, in order, with its effort levels', () => {
  const definition = buildClaudeModelsDefinition(CLI_MODELS.map((model) => ({
    ...model,
    supportedEffortLevels: model.supportedEffortLevels ? [...model.supportedEffortLevels] : undefined,
  })));

  assert.equal(definition.DEFAULT, 'default');
  assert.deepEqual(definition.OPTIONS.map((option) => option.value), ['default', 'claude-fable-5-1[1m]', 'haiku']);
  assert.equal(definition.OPTIONS[1].label, 'Fable');
  assert.equal(definition.OPTIONS[1].description, 'Fable 5.1 · Most capable');
  assert.equal(definition.OPTIONS[2].effort, undefined);
});

test('offers ultracode only on models whose CLI effort levels include xhigh', () => {
  const definition = buildClaudeModelsDefinition(CLI_MODELS.map((model) => ({
    ...model,
    supportedEffortLevels: model.supportedEffortLevels ? [...model.supportedEffortLevels] : undefined,
  })));

  const efforts = (index: number) => definition.OPTIONS[index].effort?.values.map((value) => value.value);
  assert.deepEqual(efforts(0), ['low', 'medium', 'high', 'xhigh', 'max', CLAUDE_ULTRACODE_EFFORT]);
  assert.deepEqual(efforts(1), ['low', 'medium', 'high', 'max']);
  assert.equal(definition.OPTIONS[0].effort?.default, 'high');
});

test('drops pinned version ids the CLI appends after its picker entries', () => {
  const definition = buildClaudeModelsDefinition([
    { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: '' },
    { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1', displayName: 'Fable', description: '' },
    { value: 'claude-opus-4-8', resolvedModel: 'claude-opus-4-8', displayName: 'Opus 4.8', description: '' },
  ]);

  assert.deepEqual(definition.OPTIONS.map((option) => option.value), ['opus', 'claude-fable-5-1[1m]']);
  assert.equal(definition.DEFAULT, 'opus');
});

test('rejects an empty or malformed CLI model list', () => {
  assert.throws(() => buildClaudeModelsDefinition([]));
  assert.throws(() => buildClaudeModelsDefinition([{ value: '', displayName: 'x', description: '' }]));
});

test('caches the discovered catalog instead of spawning the CLI per request', async () => {
  let calls = 0;
  const models = new ClaudeProviderModels(async () => {
    calls += 1;
    return [...CLI_MODELS].map((model) => ({ ...model, supportedEffortLevels: undefined }));
  });

  const [first, second] = await Promise.all([models.getSupportedModels(), models.getSupportedModels()]);
  await models.getSupportedModels();

  assert.equal(calls, 1);
  assert.equal(first, second);
  assert.equal(first.OPTIONS.length, 3);
});

const quietly = async (run: () => Promise<void>) => {
  const originalError = console.error;
  console.error = () => {};
  try { await run(); } finally { console.error = originalError; }
};

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a failed first load is an error, so the picker offers a retry instead of a guess', async () => {
  await quietly(async () => {
    const models = new ClaudeProviderModels(async () => {
      throw new Error('claude not installed');
    });
    await assert.rejects(models.getSupportedModels(), /claude not installed/);
    assert.equal((await models.getCurrentActiveModel()).model, CLAUDE_PREDEFINED_MODELS.DEFAULT);
  });
});

test('a failed first load is not retried inside the back-off', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let calls = 0;
  const models = new ClaudeProviderModels(async () => {
    calls += 1;
    if (calls === 1) throw new Error('hung');
    return [CLI_MODELS[2]] as never;
  });
  await quietly(async () => {
    await assert.rejects(models.getSupportedModels(), /hung/);
    await assert.rejects(models.getSupportedModels(), /hung/);
    assert.equal(calls, 1);
    t.mock.timers.setTime(30_000);
    assert.equal((await models.getSupportedModels()).OPTIONS[0].value, 'haiku');
    assert.equal(calls, 2);
  });
});

test('an expired list is returned at once and refreshed behind it; a failed refresh keeps it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const answers: Array<() => Promise<typeof CLI_MODELS>> = [
    async () => [CLI_MODELS[2]],
    async () => { throw new Error('flaky'); },
    async () => [CLI_MODELS[0], CLI_MODELS[2]],
  ];
  let calls = 0;
  const models = new ClaudeProviderModels(() => answers[calls++]() as never);
  await quietly(async () => {
    const first = await models.getSupportedModels();
    assert.deepEqual(first.OPTIONS.map((option) => option.value), ['haiku']);

    t.mock.timers.setTime(5 * 60_000);
    assert.equal(await models.getSupportedModels(), first, 'stale list served while refreshing');
    await settle();
    assert.equal(calls, 2);
    assert.equal(await models.getSupportedModels(), first, 'a failed refresh keeps the last list');
    assert.equal(calls, 2, 'no retry inside the back-off');

    t.mock.timers.setTime(5 * 60_000 + 30_000);
    await models.getSupportedModels();
    await settle();
    assert.deepEqual((await models.getSupportedModels()).OPTIONS.map((option) => option.value), ['default', 'haiku']);
  });
});

test('keeps the first of duplicate CLI entries', () => {
  const definition = buildClaudeModelsDefinition([
    { value: 'opus', displayName: 'Opus', description: 'first' },
    { value: 'opus', displayName: 'Opus again', description: 'second' },
  ]);
  assert.deepEqual(definition.OPTIONS.map((option) => option.label), ['Opus']);
});

type FakeQueryArgs = Parameters<NonNullable<Parameters<typeof fetchClaudeCliModels>[0]>>[0];

const fakeQuery = (supportedModels: () => Promise<never[]>) => {
  const seen: { args?: FakeQueryArgs; closed: number } = { closed: 0 };
  const create = (args: FakeQueryArgs) => {
    seen.args = args;
    return { supportedModels, close: () => { seen.closed += 1; } };
  };
  return { create, seen };
};

test('the model query starts no hooks or MCP servers and always closes the process', async () => {
  const ok = fakeQuery(async () => []);
  await fetchClaudeCliModels(ok.create as never);
  assert.equal(ok.seen.closed, 1);
  assert.equal(ok.seen.args?.options?.strictMcpConfig, true);
  assert.deepEqual(ok.seen.args?.options?.mcpServers, {});
  assert.deepEqual(ok.seen.args?.options?.settings, { disableAllHooks: true });

  const failing = fakeQuery(async () => { throw new Error('init failed'); });
  await assert.rejects(fetchClaudeCliModels(failing.create as never), /init failed/);
  assert.equal(failing.seen.closed, 1);

  const hanging = fakeQuery(() => new Promise<never[]>(() => {}));
  await assert.rejects(fetchClaudeCliModels(hanging.create as never, 10), /within 10ms/);
  assert.equal(hanging.seen.closed, 1);
});

test('the built-in list mirrors the CLI picker: no 1M variants, no extra aliases', () => {
  assert.deepEqual(
    CLAUDE_PREDEFINED_MODELS.OPTIONS.map((option) => option.value),
    ['default', 'opus', 'fable', 'sonnet', 'haiku'],
  );
});

test('effort for a saved model the catalog no longer lists', () => {
  // An older session's 1M alias is checked against its base entry, so ultracode survives.
  assert.equal(resolveClaudeEffort('opus[1m]', CLAUDE_ULTRACODE_EFFORT, CLAUDE_PREDEFINED_MODELS), CLAUDE_ULTRACODE_EFFORT);
  // With no entry at all, a plain CLI level passes through and anything else is dropped.
  assert.equal(resolveClaudeEffort('opusplan', 'medium', CLAUDE_PREDEFINED_MODELS), 'medium');
  assert.equal(resolveClaudeEffort('opusplan', CLAUDE_ULTRACODE_EFFORT, CLAUDE_PREDEFINED_MODELS), undefined);
  // A listed model without tiers still drops the effort.
  assert.equal(resolveClaudeEffort('haiku', 'high', CLAUDE_PREDEFINED_MODELS), undefined);
});
