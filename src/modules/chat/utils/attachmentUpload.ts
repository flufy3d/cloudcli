import { authenticatedFetch, uploadChatAttachments } from '@/shared/api';
import { createClientRequestId } from '@/shared/utils';

type UploadAttachmentOptions = {
  maxRetries?: number;
  retryDelayMs?: number;
  fetchFn?: typeof authenticatedFetch;
};

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const formatHttpErrorMessage = (status: number, statusText?: string): string => {
  if (status >= 500) {
    const text = statusText ? ` ${statusText}` : '';
    return `Server error (${status}${text})`;
  }
  const text = statusText ? `: ${statusText}` : '';
  return `Upload failed with status ${status}${text}`;
};

/**
 * Uploads attached files to `/api/assets/files` with automatic retries for transient
 * gateway/network glitches (such as 502 Bad Gateway from reverse proxy keep-alive race conditions).
 */
export async function uploadAttachmentFiles(
  files: File[],
  options: UploadAttachmentOptions = {},
): Promise<unknown[]> {
  if (files.length === 0) {
    return [];
  }

  const {
    maxRetries = 2,
    retryDelayMs = 300,
    fetchFn = authenticatedFetch,
  } = options;

  const requestId = createClientRequestId();
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(retryDelayMs * Math.pow(2, attempt - 1));
    }

    const formData = new FormData();
    files.forEach((file) => formData.append('files', file));

    let response: Response;
    let result: unknown;
    try {
      response = await uploadChatAttachments(formData, requestId, fetchFn);
      if (response.ok) result = await response.json();
    } catch (error) {
      // Only transport failures enter this branch; HTTP errors and invalid payloads are handled outside.
      if (error instanceof TypeError && attempt < maxRetries) {
        lastError = error;
        continue;
      }
      throw error;
    }

    if (!response.ok) {
      let errorMessage: string | null = null;
      try {
        const body: unknown = await response.json();
        if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string') {
          errorMessage = body.error;
        }
      } catch {
        // A proxy may return HTML; the HTTP status remains the failure signal.
      }
      const resolvedError = new Error(
        errorMessage || formatHttpErrorMessage(response.status, response.statusText),
      );
      if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < maxRetries) {
        lastError = resolvedError;
        continue;
      }
      throw resolvedError;
    }

    if (typeof result !== 'object' || result === null || !('attachments' in result)
      || !Array.isArray(result.attachments) || result.attachments.length !== files.length) {
      throw new Error('File upload returned an incomplete result');
    }
    return result.attachments;
  }

  throw lastError instanceof Error ? lastError : new Error('Failed to upload files after retries');
}
