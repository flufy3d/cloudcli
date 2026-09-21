import { describe, expect, it } from 'vitest';

import { shouldProxyLocalHref } from '@/modules/chat/utils/localProxyLink';

describe('shouldProxyLocalHref', () => {
  const remoteOrigin = 'http://192.168.1.20:3030';

  it('proxies loopback links when the app is viewed from another machine', () => {
    expect(shouldProxyLocalHref('http://localhost:4174/report.html', remoteOrigin)).toBe(true);
    expect(shouldProxyLocalHref('http://127.0.0.1:5173/', remoteOrigin)).toBe(true);
    expect(shouldProxyLocalHref('http://0.0.0.0:8080/x', remoteOrigin)).toBe(true);
    expect(shouldProxyLocalHref('http://[::1]:8080/x', remoteOrigin)).toBe(true);
  });

  it('leaves links alone when the browser runs on the server itself', () => {
    expect(shouldProxyLocalHref('http://localhost:4174/report.html', 'http://localhost:3001')).toBe(false);
    expect(shouldProxyLocalHref('http://localhost:4174/report.html', 'http://127.0.0.1:3001')).toBe(false);
  });

  it('leaves public and non-http links alone', () => {
    expect(shouldProxyLocalHref('https://example.com/', remoteOrigin)).toBe(false);
    expect(shouldProxyLocalHref('https://localhost:4174/', remoteOrigin)).toBe(false);
    expect(shouldProxyLocalHref('mailto:a@b.c', remoteOrigin)).toBe(false);
    expect(shouldProxyLocalHref('#section', remoteOrigin)).toBe(false);
    expect(shouldProxyLocalHref('/relative/path', remoteOrigin)).toBe(false);
    expect(shouldProxyLocalHref(undefined, remoteOrigin)).toBe(false);
  });

  it('never proxies the cloudcli origin itself', () => {
    expect(shouldProxyLocalHref('http://192.168.1.20:3030/chat', remoteOrigin)).toBe(false);
  });
});
