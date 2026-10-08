const UPLOAD_REPLAY_TTL_MS = 10 * 60 * 1000;
const MAX_UPLOAD_REPLAY_ENTRIES = 1000;

/** Used by the assets routes to reject new uploads without evicting a live retry identity. */
export class UploadReplayCapacityError extends Error {
  constructor() {
    super('Upload retry cache is full. Please try again later.');
  }
}

/**
 * Used by the assets routes to share in-flight work and successful upload results.
 * Scope must contain the authenticated user and endpoint; failures release their
 * slot. Completed entries expire, but pending uploads never expire or get evicted.
 * This cache belongs to one server process and does not survive a restart.
 */
export function createUploadReplayService<T>(options: {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
} = {}) {
  const { ttlMs = UPLOAD_REPLAY_TTL_MS, maxEntries = MAX_UPLOAD_REPLAY_ENTRIES, now = Date.now } = options;
  const entries = new Map<string, { result: Promise<T>; expiresAt: number | null }>();

  return {
    run(scope: string, requestId: string, upload: () => Promise<T>): Promise<T> {
      const time = now();
      for (const [key, entry] of entries) {
        if (entry.expiresAt !== null && entry.expiresAt <= time) entries.delete(key);
      }
      const key = JSON.stringify([scope, requestId]);
      const existing = entries.get(key);
      if (existing) return existing.result;
      if (entries.size >= maxEntries) return Promise.reject(new UploadReplayCapacityError());

      // Register before starting asynchronous I/O so concurrent repeats join this promise.
      const entry: { result: Promise<T>; expiresAt: number | null } = {
        result: Promise.resolve().then(upload), expiresAt: null,
      };
      entry.result = entry.result.then(
        (result) => {
          entry.expiresAt = now() + ttlMs;
          return result;
        },
        (error: unknown) => {
          entries.delete(key);
          throw error;
        },
      );
      entries.set(key, entry);
      return entry.result;
    },
  };
}
