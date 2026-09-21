export function isWildcardHost(host) {
  return host === '0.0.0.0' || host === '::';
}

export function isLoopbackHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

export function normalizeLoopbackHost(host) {
  if (!host) {
    return host;
  }
  return isLoopbackHost(host) ? 'localhost' : host;
}

// Use localhost for connectable loopback and wildcard addresses in browser-facing URLs.
export function getConnectableHost(host) {
  if (!host) {
    return 'localhost';
  }
  return isWildcardHost(host) || isLoopbackHost(host) ? 'localhost' : host;
}

// A hostname that resolves to this machine: every loopback spelling, the
// wildcard addresses a server prints when it binds all interfaces, and the
// `*.localhost` names some dev servers hand out. Shared by the frontend (which
// decides whether a chat link needs the local proxy) and the server's
// local-proxy module (which refuses to forward anywhere else).
export function isLocalMachineHost(host) {
  if (!host) {
    return false;
  }
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    isLoopbackHost(normalized) ||
    isWildcardHost(normalized) ||
    normalized.endsWith('.localhost') ||
    /^127\./.test(normalized)
  );
}
