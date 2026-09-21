import { isLocalMachineHost } from '@shared/networkHosts.js';

/**
 * Decides whether a chat link points at a service on the server's machine that
 * this browser cannot reach on its own.
 *
 * Assistants routinely print links to things they started next to the server —
 * a preview server on :4174, a dev server on :5173. Those only resolve for a
 * browser running on that same machine, so when the app is opened from anywhere
 * else the link has to go through the server's local proxy instead.
 *
 * When cloudcli itself is being viewed over loopback the browser already is on
 * that machine, so the link works as-is and is left untouched.
 */
export function shouldProxyLocalHref(href: string | undefined, pageOrigin: string): boolean {
  if (!href) {
    return false;
  }

  let target: URL;
  let page: URL;
  try {
    // A relative href resolves against the page, which then fails the
    // same-origin check below — exactly the wanted outcome.
    target = new URL(href, pageOrigin);
    page = new URL(pageOrigin);
  } catch {
    return false;
  }

  if (target.protocol !== 'http:') {
    return false;
  }
  if (target.origin === page.origin) {
    return false;
  }
  return isLocalMachineHost(target.hostname) && !isLocalMachineHost(page.hostname);
}
