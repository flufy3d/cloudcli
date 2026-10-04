import { describe, expect, it, vi } from 'vitest';

import { uploadAttachmentFiles } from './attachmentUpload';

describe('uploadAttachmentFiles', () => {
  const createFile = (name: string, content = 'dummy') =>
    new File([content], name, { type: 'image/png' });

  it('returns empty array when files is empty without making network calls', async () => {
    const fetchFn = vi.fn();
    const result = await uploadAttachmentFiles([], { fetchFn });
    expect(result).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('successfully uploads files on first attempt', async () => {
    const mockAttachments = [{ id: '1', name: 'img1.png', path: '/assets/img1.png' }];
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ attachments: mockAttachments }),
    });

    const file = createFile('img1.png');
    const result = await uploadAttachmentFiles([file], { fetchFn });

    expect(result).toEqual(mockAttachments);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('/api/assets/files');
    expect(init.method).toBe('POST');
    expect(init.body instanceof FormData).toBe(true);
  });

  it('retries on 502 Bad Gateway and succeeds on subsequent attempt', async () => {
    const mockAttachments = [{ id: '1', name: 'img1.png' }];
    const fetchFn = vi
      .fn()
      // First attempt: Cloudflare 502 Bad Gateway returning HTML
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
      })
      // Second attempt: succeeds
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ attachments: mockAttachments }),
      });

    const file = createFile('img1.png');
    const result = await uploadAttachmentFiles([file], {
      fetchFn,
      maxRetries: 2,
      retryDelayMs: 10,
    });

    expect(result).toEqual(mockAttachments);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('retries on network failure (Failed to fetch) and succeeds', async () => {
    const mockAttachments = [{ id: '1', name: 'img1.png' }];
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ attachments: mockAttachments }),
      });

    const file = createFile('img1.png');
    const result = await uploadAttachmentFiles([file], {
      fetchFn,
      maxRetries: 2,
      retryDelayMs: 10,
    });

    expect(result).toEqual(mockAttachments);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on 4xx client errors (e.g. 400 Bad Request)', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ error: 'Invalid file type. Only JPEG and PNG are allowed.' }),
    });

    const file = createFile('bad.exe');
    await expect(
      uploadAttachmentFiles([file], { fetchFn, maxRetries: 2, retryDelayMs: 10 }),
    ).rejects.toThrow('Invalid file type. Only JPEG and PNG are allowed.');

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('throws descriptive error with HTTP status when 502 retries are exhausted without JSON body', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    });

    const file = createFile('img1.png');
    await expect(
      uploadAttachmentFiles([file], { fetchFn, maxRetries: 1, retryDelayMs: 10 }),
    ).rejects.toThrow('Server error (502 Bad Gateway)');

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('throws error when upload response returns incomplete attachments array', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ attachments: [{ id: '1' }] }), // Expected 2
    });

    const files = [createFile('img1.png'), createFile('img2.png')];
    await expect(
      uploadAttachmentFiles(files, { fetchFn, maxRetries: 0 }),
    ).rejects.toThrow('File upload returned an incomplete result');
  });

  it('retries on 500 and uses server json error when retries are exhausted', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({ error: 'Disk space exhausted on server' }),
    });

    const file = createFile('img1.png');
    await expect(
      uploadAttachmentFiles([file], { fetchFn, maxRetries: 1, retryDelayMs: 10 }),
    ).rejects.toThrow('Disk space exhausted on server');

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('throws network error when network retries are exhausted', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const file = createFile('img1.png');
    await expect(
      uploadAttachmentFiles([file], { fetchFn, maxRetries: 1, retryDelayMs: 10 }),
    ).rejects.toThrow('Failed to fetch');

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
