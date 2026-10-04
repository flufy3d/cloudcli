import { authenticatedFetch } from '@/shared/api';

export type UploadAttachmentOptions = {
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

  let lastError: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(retryDelayMs * Math.pow(2, attempt - 1));
    }

    try {
      const formData = new FormData();
      files.forEach((file) => {
        formData.append('files', file);
      });

      const response = await fetchFn('/api/assets/files', {
        method: 'POST',
        headers: {},
        body: formData,
      });

      if (!response.ok) {
        let errorMessage: string | null = null;
        try {
          const body = (await response.json()) as { error?: string } | null;
          if (body?.error && typeof body.error === 'string') {
            errorMessage = body.error;
          }
        } catch {
          // Response body is not JSON (e.g. Cloudflare / Nginx 502 HTML error page)
        }

        const isRetryable = RETRYABLE_STATUS_CODES.has(response.status);
        const resolvedError = new Error(
          errorMessage || formatHttpErrorMessage(response.status, response.statusText),
        );

        if (isRetryable && attempt < maxRetries) {
          lastError = resolvedError;
          continue;
        }

        throw resolvedError;
      }

      const result = (await response.json()) as { attachments?: unknown[] };
      if (!Array.isArray(result.attachments) || result.attachments.length !== files.length) {
        throw new Error('File upload returned an incomplete result');
      }

      return result.attachments;
    } catch (error) {
      // Re-throw if already finalized or non-retryable
      if (
        error instanceof Error &&
        !RETRYABLE_STATUS_CODES.has(502) // type guard placeholder
      ) {
        // Handled below
      }

      const isNetworkError =
        error instanceof TypeError ||
        (error instanceof Error &&
          (error.message.includes('fetch') || error.message.includes('network')));

      if (isNetworkError && attempt < maxRetries) {
        lastError = error;
        continue;
      }

      lastError = error;
      throw lastError;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Failed to upload files after retries');
}
