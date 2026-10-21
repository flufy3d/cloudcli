import { appConfigDb, sessionsDb } from '@/modules/database/index.js';
import type { CodexSessionTitleTarget } from '@/shared/index.js';
import { AppError, awaitWithAbort, readObjectRecord, parseFilesInputTag } from '@/shared/index.js';

import { codexAuth } from '../list/codex/codex-auth.provider.js';
import { CodexSessionsProvider } from '../list/codex/codex-sessions.provider.js';
import { generateCodexThreadTitle } from '../list/codex/codex-thread-title.js';
import { createCodexTitleWorker, releaseCodexResidentSession, readCodexResidentMetadata } from '../list/codex/codex-session-manager.js';

const CONFIG_KEY = 'codex_session_titles_enabled';
const jobs = new Map<string, { done: Promise<void>; controller: AbortController }>();
let tail = Promise.resolve();
const history = new CodexSessionsProvider();

function report(target: CodexSessionTitleTarget, stage: string, error: unknown): void {
  const code = error instanceof AppError ? error.code : 'CODEX_TITLE_FAILED';
  console.warn(`[CodexTitle] ${target.appSessionId} ${target.nativeThreadId} ${stage} ${code}`);
}

function eligible(target: CodexSessionTitleTarget, signal: AbortSignal, deadline: number): boolean {
  if (signal.aborted || Date.now() >= deadline || !codexSessionTitleService.getSettings().enabled) return false;
  const row = sessionsDb.getSessionById(target.appSessionId);
  return !!row && row.provider === 'codex' && row.provider_session_id === target.nativeThreadId
    && !row.isArchived && !row.name_locked && !row.forked_from_session_id;
}

function readNative(result: unknown, target: CodexSessionTitleTarget) {
  const thread = readObjectRecord(readObjectRecord(result)?.thread);
  if (thread?.id !== target.nativeThreadId || (thread.name != null && typeof thread.name !== 'string')) {
    throw new AppError('Codex title target is invalid.', { code: 'CODEX_TITLE_TARGET', statusCode: 409 });
  }
  return { name: typeof thread.name === 'string' && thread.name.trim() ? thread.name.trim() : null, modelProvider: thread.modelProvider, model: typeof thread.model === 'string' ? thread.model : null };
}

function userText(value: string): string | null {
  const text = parseFilesInputTag(value).text.trim();
  // These are injected context records, not the user's task. Never forward
  // their instruction bodies or tool/host envelopes to the title model.
  if (!text || /^(?:# (?:AGENTS\.md|.*instructions for)|<environment_context>|<INSTRUCTIONS>|<user_instructions>|<system|<tool_|<task_notification>|<turn_aborted>)/iu.test(text)) return null;
  return text;
}

async function findPrompt(target: CodexSessionTitleTarget, signal: AbortSignal): Promise<string | null> {
  if (target.initialPrompt !== undefined) return userText(target.initialPrompt);
  const first = await awaitWithAbort(history.fetchHistory(target.appSessionId, { limit: 1 }), signal);
  let consumed = 0;
  while (consumed < first.total) {
    const limit = Math.min(50, first.total - consumed);
    const page = await awaitWithAbort(history.fetchHistory(target.appSessionId, { limit, offset: Math.max(0, first.total - consumed - limit) }), signal);
    for (const message of page.messages) {
      if (message.role === 'user' && message.kind === 'text' && typeof message.content === 'string') {
        const prompt = userText(message.content);
        if (prompt) return prompt;
      }
    }
    consumed += limit;
  }
  return null;
}

async function apply(target: CodexSessionTitleTarget, name: string, signal: AbortSignal, deadline: number): Promise<void> {
  if (!eligible(target, signal, deadline)) return;
  if (sessionsDb.applyAutomaticSessionName(target.appSessionId, 'codex', target.nativeThreadId, name)) {
    await awaitWithAbort(import('@/modules/websocket/index.js').then(({ broadcastSessionUpserted }) => broadcastSessionUpserted(target.appSessionId, { metadataOnly: true })), signal);
  }
}

async function execute(target: CodexSessionTitleTarget, controller: AbortController, deadline: number): Promise<void> {
  if (!eligible(target, controller.signal, deadline)) return;
  const native = readNative(await awaitWithAbort(readCodexResidentMetadata({ ...target, appSessionId: target.residentKey ?? target.appSessionId, method: 'thread/read', timeoutMs: Math.max(1, deadline - Date.now()) }), controller.signal), target);
  if (native.name) { await apply(target, native.name, controller.signal, deadline); return; }
  if (typeof native.modelProvider !== 'string' || !native.modelProvider.trim()) throw new AppError('Codex title provider is unknown.', { code: 'CODEX_TITLE_PROVIDER', statusCode: 502 });
  const prompt = await findPrompt(target, controller.signal);
  if (!prompt || !eligible(target, controller.signal, deadline)) return;
  const auth = await awaitWithAbort(codexAuth.getStatus(), controller.signal);
  if (!eligible(target, controller.signal, deadline)) return;
  const luna = native.modelProvider === 'openai' && auth.authenticated && auth.method === 'credentials_file'
    && target.models.OPTIONS.some((option) => option.value === 'gpt-5.6-luna');
  const model = luna ? 'gpt-5.6-luna' : native.model ?? target.model;
  const supported = target.models.OPTIONS.find((option) => option.value === model)?.effort?.values ?? [];
  const effort = luna ? 'low' : ['minimal', 'low', 'none'].find((value) => supported.some((option) => option.value === value));
  await generateCodexThreadTitle({ target, prompt, model, modelProvider: native.modelProvider, effort, deadline, signal: controller.signal }, async (title, call) => {
    if (!eligible(target, controller.signal, deadline)) return;
    const latest = readNative(await call('thread/read', { threadId: target.nativeThreadId }), target);
    if (latest.name) { await apply(target, latest.name, controller.signal, deadline); return; }
    if (!eligible(target, controller.signal, deadline)) return;
    let saved = title;
    try { await call('thread/name/set', { threadId: target.nativeThreadId, name: title }); }
    catch (error) {
      if (!eligible(target, controller.signal, deadline)) return;
      report(target, 'native_save_recheck', error);
      const recovered = readNative(await call('thread/read', { threadId: target.nativeThreadId }), target);
      if (!recovered.name) throw new AppError('Codex title save was not confirmed.', { code: 'CODEX_TITLE_SAVE_UNKNOWN', statusCode: 502 });
      saved = recovered.name;
    }
    await apply(target, saved, controller.signal, deadline);
  });
}

/**
 * Codex runtime enqueues after successful normal turns; provider routes manage
 * the persisted switch. Jobs serialize in process and never join chat's run
 * registry. Each returned promise settles even on failure, so callers can
 * submit without making a completed chat wait for naming.
 */
export const codexSessionTitleService = {
  getSettings(): { enabled: boolean } {
    const raw = appConfigDb.get(CONFIG_KEY);
    if (raw == null) return { enabled: true };
    if (raw !== 'true' && raw !== 'false') throw new AppError('Invalid Codex title setting.', { code: 'CODEX_TITLE_CONFIG', statusCode: 500 });
    return { enabled: raw === 'true' };
  },
  updateSettings(enabled: boolean): { enabled: boolean } {
    appConfigDb.set(CONFIG_KEY, String(enabled));
    if (!enabled) for (const job of jobs.values()) job.controller.abort(new AppError('Codex title generation disabled.', { code: 'CODEX_TITLE_DISABLED', statusCode: 409 }));
    return { enabled };
  },
  enqueue(target: CodexSessionTitleTarget, knownNativeName?: string | null): Promise<void> {
    const key = JSON.stringify([target.appSessionId, target.nativeThreadId]);
    const pending = jobs.get(key);
    if (pending) return pending.done;
    const controller = new AbortController();
    const deadline = Date.now() + 30_000;
    try {
      if (!eligible(target, controller.signal, deadline)) return Promise.resolve();
      if (knownNativeName && sessionsDb.getSessionById(target.appSessionId)?.custom_name === knownNativeName) return Promise.resolve();
    } catch (error) { report(target, 'eligibility', error); return Promise.resolve(); }
    const timer = setTimeout(() => controller.abort(new AppError('Codex title deadline expired.', { code: 'CODEX_TITLE_TIMEOUT', statusCode: 504 })), Math.max(1, deadline - Date.now()));
    timer.unref?.();
    const snapshot = { ...target };
    const done = tail.then(async () => {
      if (snapshot.generation > 0) { await execute(snapshot, controller, deadline); return; }
      if (!eligible(snapshot, controller.signal, deadline)) return;
      const pendingWorker = createCodexTitleWorker(snapshot, deadline, controller.signal);
      let worker: Awaited<typeof pendingWorker> | undefined;
      try {
        worker = await awaitWithAbort(pendingWorker, controller.signal);
        await execute({ ...snapshot, generation: worker.generation, residentKey: worker.key }, controller, deadline);
      } finally {
        if (worker) releaseCodexResidentSession(worker.key, { dispose: true, generation: worker.generation });
        else void pendingWorker.then((late) => releaseCodexResidentSession(late.key, { dispose: true, generation: late.generation })).catch((error) => report(snapshot, 'worker_start', error));
      }
    }).catch((error) => report(snapshot, 'execute', error)).finally(() => {
      clearTimeout(timer);
      jobs.delete(key);
    });
    jobs.set(key, { done, controller });
    tail = done;
    return done;
  },
};
