#!/usr/bin/env node
/**
 * Real-engine probe for the Claude resident process (docs/design/Claude会话常驻.md).
 *
 * Runs in a throwaway project directory and never touches a real session. It
 * keeps one CLI process alive across turns, as the runtime does, and checks:
 *   1. what the process writes to its transcript while idle between turns;
 *   2. whether it sees a CLAUDE.md written while it was idle;
 *   3. where a terminal `claude -p --resume` of the same session writes;
 *   4. whether the uuids the stream reports are the uuids of the transcript's
 *      user and assistant lines, so the runtime can tell its own lines apart.
 * The transcript directory it creates is removed at the end.
 *
 * Usage: node scripts/probe/claude-resident.probe.mjs [path-to-terminal-claude]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const terminalClaude = process.argv[2] ?? path.join(os.homedir(), '.local/bin/claude');
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-resident-probe-')));
const projectDir = path.join(os.homedir(), '.claude/projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const queue = [];
let wake = null;
let closed = false;
const push = (text) => {
  queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' });
  wake?.();
};
async function* input() {
  for (;;) {
    while (queue.length) yield queue.shift();
    if (closed) return;
    await new Promise((resolve) => { wake = resolve; });
  }
}

const turns = [];
const streamUuids = new Set();
let pendingTurn = null;
let sessionId = null;
const run = query({ prompt: input(), options: { cwd, model: 'haiku', settingSources: ['user', 'project'] } });
const loop = (async () => {
  let text = '';
  for await (const message of run) {
    if (message.type === 'system' && message.subtype === 'init') sessionId = message.session_id;
    if (typeof message.uuid === 'string') streamUuids.add(message.uuid);
    if (message.type === 'assistant') {
      for (const block of message.message.content) if (block.type === 'text') text += block.text;
    }
    if (message.type === 'result') {
      turns.push(text);
      text = '';
      pendingTurn?.();
    }
  }
})();
const turn = (prompt) => new Promise((resolve) => { pendingTurn = resolve; push(prompt); });

const transcript = () => path.join(projectDir, `${sessionId}.jsonl`);
// Offsets are bytes (`stat().size`), so slice the buffer, not the decoded text.
const linesAfter = (offset) => fs.readFileSync(transcript()).subarray(offset).toString('utf8').split('\n').filter(Boolean)
  .map((line) => JSON.parse(line));
const findElsewhere = (id) => {
  const root = path.join(os.homedir(), '.claude/projects');
  const since = Date.now() - 120_000;
  const hits = [];
  for (const dir of fs.readdirSync(root)) {
    const full = path.join(root, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const name of fs.readdirSync(full)) {
      const file = path.join(full, name);
      if (!name.endsWith('.jsonl') || file === transcript() || fs.statSync(file).mtimeMs < since) continue;
      if (fs.readFileSync(file, 'utf8').includes(id)) hits.push(path.relative(root, file));
    }
  }
  return hits;
};
const touchedSince = (since) => {
  const root = path.join(os.homedir(), '.claude');
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!['debug', 'plugins', 'statsig', 'shell-snapshots'].includes(entry.name)) walk(full, depth + 1); }
      else if ((fs.statSync(full, { throwIfNoEntry: false })?.mtimeMs ?? 0) >= since) hits.push(path.relative(root, full));
    }
  };
  walk(root, 0);
  return hits;
};
const describe = (entry) => `${entry.type}${entry.entrypoint ? `(${entry.entrypoint})` : ''}`;

try {
  await turn('只回复一个字：好');
  const offset = fs.statSync(transcript()).size;
  await sleep(8000);
  console.log('1. idle lines:', linesAfter(offset).map(describe).join(', ') || '(none)');

  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '每次回复都必须以「喵」字开头。\n');
  await turn('只回复一个字：好');
  console.log('2. reply after CLAUDE.md was written while idle:', JSON.stringify(turns.at(-1)));

  const ownLines = linesAfter(0).filter((entry) => entry.type === 'user' || entry.type === 'assistant');
  const unseen = ownLines.filter((entry) => !streamUuids.has(entry.uuid));
  console.log(`4. own user/assistant lines: ${ownLines.length}, not reported on the stream: ${unseen.length}`,
    unseen.map((entry) => `${entry.type}:${JSON.stringify(entry.message?.content).slice(0, 60)}`).join(' | '));

  const beforeTerminal = fs.statSync(transcript()).size;
  const filesBefore = new Set(fs.readdirSync(projectDir));
  const terminalStart = Date.now();
  let terminalOutput;
  try {
    terminalOutput = execFileSync(terminalClaude, ['-p', '--model', 'haiku', '--resume', sessionId, '只回复一个字：好'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    terminalOutput = `exit ${error.status}: ${error.stdout}${error.stderr}`;
  }
  console.log('3. terminal output:', JSON.stringify(terminalOutput.trim().slice(0, 300)));
  const newFiles = fs.readdirSync(projectDir).filter((name) => !filesBefore.has(name));
  console.log('3. terminal resume wrote to the same file:', linesAfter(beforeTerminal).map(describe).join(', ') || '(none)');
  console.log('   new files:', newFiles.join(', ') || '(none)');
  console.log('   transcripts elsewhere naming the session:', findElsewhere(sessionId).join(', ') || '(none)');
  console.log('   files under ~/.claude the terminal touched:', touchedSince(terminalStart).join(', ') || '(none)');

  // Control for 2: a fresh process resuming the session reads CLAUDE.md.
  const fresh = query({ prompt: '只回复一个字：好', options: { cwd, model: 'haiku', resume: sessionId, settingSources: ['user', 'project'] } });
  let freshText = '';
  for await (const message of fresh) {
    if (message.type === 'assistant') for (const block of message.message.content) if (block.type === 'text') freshText += block.text;
  }
  console.log('2b. reply from a fresh resumed process:', JSON.stringify(freshText));
} finally {
  closed = true;
  wake?.();
  await loop.catch(() => {});
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
}
