import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { calculateResultDigest } from '@/modules/task-continuations/services/task-continuation-state.service.js';
import { AppError } from '@/shared/utils.js';

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled']);
export const MAX_TASK_RESULT_BYTES = 1_000_000;
const MAX_SUMMARY_LENGTH = 16_000;

export type NormalizedTaskResult = {
  status: 'completed' | 'failed' | 'cancelled';
  exitCode: number | null;
  resultSummary: string | null;
  resultJson: string;
  resultDigest: string;
};

/** Reads one task result from its expected task directory and applies the HTTP result parser. */
export async function readAndNormalizeTaskResultFromDisk(input: {
  taskId: string;
  tasksRootDir: string;
  resultFilePath: string;
}): Promise<NormalizedTaskResult> {
  if (!input.taskId || path.basename(input.taskId) !== input.taskId) {
    throw new AppError('Task result id is invalid.', { code: 'INVALID_TASK_RESULT', statusCode: 400 });
  }

  const rootPath = path.resolve(input.tasksRootDir);
  const expectedDirectoryPath = path.join(rootPath, input.taskId);
  const expectedResultPath = path.join(expectedDirectoryPath, 'result.json');
  if (path.resolve(input.resultFilePath) !== expectedResultPath) {
    throw new AppError('Task result path is outside its expected task directory.', {
      code: 'INVALID_TASK_RESULT_PATH',
      statusCode: 400,
    });
  }

  const resolvedRootPath = await realpath(rootPath);
  const directoryInfo = await lstat(expectedDirectoryPath);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw new AppError('Task result directory must be a real directory.', {
      code: 'INVALID_TASK_RESULT_PATH',
      statusCode: 400,
    });
  }
  const resolvedDirectoryPath = await realpath(expectedDirectoryPath);
  if (!resolvedDirectoryPath.startsWith(`${resolvedRootPath}${path.sep}`)) {
    throw new AppError('Task result directory escapes the task root.', {
      code: 'INVALID_TASK_RESULT_PATH',
      statusCode: 400,
    });
  }

  const resultInfo = await lstat(expectedResultPath);
  if (resultInfo.isSymbolicLink() || !resultInfo.isFile()) {
    throw new AppError('Task result file must be a regular file, not a symbolic link.', {
      code: 'INVALID_TASK_RESULT_PATH',
      statusCode: 400,
    });
  }
  if (resultInfo.size > MAX_TASK_RESULT_BYTES) {
    throw new AppError(`Task result file exceeds ${MAX_TASK_RESULT_BYTES} bytes.`, {
      code: 'INVALID_TASK_RESULT',
      statusCode: 400,
    });
  }
  const resolvedResultPath = await realpath(expectedResultPath);
  if (path.dirname(resolvedResultPath) !== resolvedDirectoryPath) {
    throw new AppError('Task result file escapes its task directory.', {
      code: 'INVALID_TASK_RESULT_PATH',
      statusCode: 400,
    });
  }

  const resultJson = await readFile(resolvedResultPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    return invalidTaskResult('Task result payload must contain valid JSON.');
  }
  if (!isRecord(parsed)) {
    return invalidTaskResult('Task result must be a JSON object.');
  }
  return normalizeTaskResult({
    taskId: input.taskId,
    status: parsed.status,
    exitCode: parsed.exitCode,
    resultSummary: parsed.summary,
    resultJson,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalizeJson(value[key])]),
  );
}

function invalidTaskResult(message: string): never {
  throw new AppError(message, {
    code: 'INVALID_TASK_RESULT',
    statusCode: 400,
  });
}

/**
 * Parses HTTP or disk task results into one size-limited, canonical payload.
 * The task module's callback and recovery services use this same boundary so
 * status, identity, and digest rules cannot differ between transports.
 */
export function normalizeTaskResult(input: {
  taskId: string;
  status: unknown;
  exitCode: unknown;
  resultSummary?: unknown;
  resultJson?: unknown;
}): NormalizedTaskResult {
  if (typeof input.taskId !== 'string' || !input.taskId.trim()) {
    return invalidTaskResult('Task result requires a task id.');
  }
  if (typeof input.status !== 'string' || !TERMINAL_TASK_STATUSES.has(input.status)) {
    return invalidTaskResult('Task result status must be completed, failed, or cancelled.');
  }
  if (input.exitCode !== null && input.exitCode !== undefined
    && (!Number.isInteger(input.exitCode) || typeof input.exitCode !== 'number')) {
    return invalidTaskResult('Task result exit code must be an integer or null.');
  }
  if (input.resultSummary !== null && input.resultSummary !== undefined
    && (typeof input.resultSummary !== 'string' || input.resultSummary.length > MAX_SUMMARY_LENGTH)) {
    return invalidTaskResult('Task result summary is invalid or too long.');
  }

  let payload: Record<string, unknown>;
  if (input.resultJson !== undefined && input.resultJson !== null) {
    if (typeof input.resultJson !== 'string' || Buffer.byteLength(input.resultJson, 'utf8') > MAX_TASK_RESULT_BYTES) {
      return invalidTaskResult('Task result payload is invalid or too large.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.resultJson);
    } catch {
      return invalidTaskResult('Task result payload must contain valid JSON.');
    }
    if (!isRecord(parsed)
      || parsed.version !== 1
      || parsed.taskId !== input.taskId
      || parsed.status !== input.status
      || (parsed.exitCode ?? null) !== (input.exitCode ?? null)) {
      return invalidTaskResult('Task result payload identity or terminal fields do not match the request.');
    }
    if (typeof parsed.summary !== 'string' || parsed.summary.length > MAX_SUMMARY_LENGTH) {
      return invalidTaskResult('Task result payload summary is invalid or too long.');
    }
    if (input.resultSummary !== undefined && input.resultSummary !== parsed.summary) {
      return invalidTaskResult('Task result summaries do not match.');
    }
    payload = parsed;
  } else {
    payload = {
      version: 1,
      taskId: input.taskId,
      status: input.status,
      exitCode: input.exitCode ?? null,
      summary: input.resultSummary ?? '',
    };
  }

  const resultJson = JSON.stringify(canonicalizeJson(payload));
  return {
    status: input.status as NormalizedTaskResult['status'],
    exitCode: input.exitCode === undefined ? null : input.exitCode as number | null,
    resultSummary: typeof payload.summary === 'string' ? payload.summary : null,
    resultJson,
    resultDigest: calculateResultDigest(resultJson),
  };
}
