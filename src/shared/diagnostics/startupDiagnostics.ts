import { APP_VERSION, BUILD_INFO } from '@/shared/constants';

const HISTORY_STORAGE_KEY = 'cloudcli-startup-diagnostics-v1';
const MAX_HISTORY_ENTRIES = 5;
const MAX_LONG_TASKS = 20;
const MAX_RESOURCE_SAMPLES = 12;

type StartupMetricValues = {
  fcpMs: number | null;
  lcpMs: number | null;
  cls: number | null;
  inpMs: number | null;
};

type StartupNavigationValues = {
  ttfbMs: number | null;
  domInteractiveMs: number | null;
  domContentLoadedMs: number | null;
  loadMs: number | null;
};

type StartupResource = {
  category: 'api' | 'asset' | 'external' | 'other';
  label: string;
  durationMs: number;
  transferBytes: number | null;
  decodedBytes: number | null;
  cacheStatus: 'network' | 'cache_or_timing_restricted' | 'unknown';
};

type StartupLongTask = {
  startMs: number;
  durationMs: number;
};

type StartupPwaState = {
  supported: boolean;
  standalone: boolean;
  controlled: boolean | null;
  registration: {
    scope: string;
    installing: string | null;
    waiting: string | null;
    active: string | null;
  } | null;
  caches: Array<{ name: string; entries: number }>;
  readError: string | null;
};

type StartupSnapshot = {
  build: string;
  takenAt: string;
  metrics: Partial<StartupMetricValues>;
};

type StartupReportInput = {
  build: string;
  takenAt: string;
  navigation: Partial<StartupNavigationValues>;
  metrics: StartupMetricValues;
  resources: StartupResource[];
  longTasks: StartupLongTask[];
  pwa: Partial<StartupPwaState>;
};

type StartupDiagnosticsReport = {
  schemaVersion: 1;
  current: StartupReportInput & {
    environment: {
      userAgent: string;
      viewport: { width: number; height: number; devicePixelRatio: number } | null;
      online: boolean | null;
      connection: { effectiveType: string | null; rttMs: number | null; downlinkMbps: number | null };
    };
    milestones: Record<string, number>;
  };
  history: StartupSnapshot[];
  privacy: {
    includesChatContent: false;
    includesCredentials: false;
    resourceUrlsAreSanitized: true;
  };
};

type ConnectionInformation = {
  effectiveType?: unknown;
  rtt?: unknown;
  downlink?: unknown;
};

type PerformanceEntryLike = PerformanceEntry & {
  transferSize?: unknown;
  decodedBodySize?: unknown;
  responseStart?: unknown;
  domInteractive?: unknown;
  domContentLoadedEventEnd?: unknown;
  loadEventEnd?: unknown;
  value?: unknown;
  duration?: number;
};

const milestones: Record<string, number> = {};
const resourceEntries: StartupResource[] = [];
const observedResourceKeys = new Set<string>();
const longTasks: StartupLongTask[] = [];
let fcpMs: number | null = null;
let lcpMs: number | null = null;
let cls: number | null = null;
let inpMs: number | null = null;
let started = false;
let persistedCurrentPage = false;

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readStorageHistory(): StartupSnapshot[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is StartupSnapshot => (
      Boolean(entry)
      && typeof entry === 'object'
      && typeof (entry as StartupSnapshot).build === 'string'
      && typeof (entry as StartupSnapshot).takenAt === 'string'
      && typeof (entry as StartupSnapshot).metrics === 'object'
    )).slice(-MAX_HISTORY_ENTRIES);
  } catch {
    return [];
  }
}

function writeStorageHistory(history: StartupSnapshot[]): void {
  try {
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history.slice(-MAX_HISTORY_ENTRIES)));
  } catch {
    // Storage can be disabled in private browsing. Exporting the current page still works.
  }
}

/** Removes only locally persisted startup diagnostics, never account or conversation data. */
export function clearStartupDiagnosticsHistory(): void {
  try {
    window.localStorage.removeItem(HISTORY_STORAGE_KEY);
  } catch {
    // Same private-browsing fallback as writes.
  }
}

/** Returns previous startup summaries retained for cross-build comparison. */
export function readStartupDiagnosticsHistory(): StartupSnapshot[] {
  return readStorageHistory();
}

/** Adds a compact startup summary to the bounded browser-local history. */
export function recordStartupDiagnosticsSnapshot(snapshot: StartupSnapshot): void {
  writeStorageHistory([...readStorageHistory(), snapshot]);
}

/** Redacts dynamic endpoints and URL parameters before resource timing leaves the browser. */
export function sanitizeStartupResource(rawUrl: string, origin: string): Pick<StartupResource, 'category' | 'label'> {
  try {
    const url = new URL(rawUrl, origin);
    if (url.origin !== origin) return { category: 'external', label: 'external' };
    if (url.pathname.startsWith('/api/')) return { category: 'api', label: '/api' };
    if (url.pathname.startsWith('/assets/')) return { category: 'asset', label: url.pathname };
    return { category: 'other', label: 'same_origin_other' };
  } catch {
    return { category: 'other', label: 'unparseable' };
  }
}

function readResourceEntry(entry: PerformanceResourceTiming): StartupResource {
  const sanitized = sanitizeStartupResource(entry.name, window.location.origin);
  const transferBytes = asFiniteNumber(entry.transferSize);
  const decodedBytes = asFiniteNumber(entry.decodedBodySize);
  return {
    ...sanitized,
    durationMs: round(entry.duration),
    transferBytes,
    decodedBytes,
    cacheStatus: transferBytes === null
      ? 'unknown'
      : transferBytes === 0 ? 'cache_or_timing_restricted' : 'network',
  };
}

function addResourceEntry(entry: PerformanceResourceTiming): void {
  const key = `${entry.name}\u0000${entry.startTime}\u0000${entry.duration}`;
  if (observedResourceKeys.has(key)) return;
  observedResourceKeys.add(key);
  resourceEntries.push(readResourceEntry(entry));
  resourceEntries.sort((left, right) => right.durationMs - left.durationMs);
  resourceEntries.splice(MAX_RESOURCE_SAMPLES);
}

function observe(type: string, onEntries: (entries: PerformanceEntryList) => void): void {
  if (typeof PerformanceObserver === 'undefined') return;
  try {
    const observer = new PerformanceObserver((list) => onEntries(list.getEntries()));
    observer.observe({ type, buffered: true } as PerformanceObserverInit);
  } catch {
    // Safari and older embedded browsers expose different PerformanceObserver subsets.
  }
}

function observeStartupMetrics(): void {
  observe('paint', (entries) => {
    for (const entry of entries) {
      if (entry.name === 'first-contentful-paint') fcpMs = round(entry.startTime);
    }
  });
  observe('largest-contentful-paint', (entries) => {
    const entry = entries.at(-1);
    if (entry) lcpMs = round(entry.startTime);
  });
  observe('layout-shift', (entries) => {
    for (const entry of entries) {
      const value = asFiniteNumber((entry as PerformanceEntryLike).value);
      if (value !== null && !(entry as PerformanceEntryLike & { hadRecentInput?: boolean }).hadRecentInput) {
        cls = round((cls ?? 0) + value);
      }
    }
  });
  observe('event', (entries) => {
    for (const entry of entries) {
      const duration = asFiniteNumber(entry.duration);
      if (duration !== null) inpMs = Math.max(inpMs ?? 0, round(duration));
    }
  });
  observe('longtask', (entries) => {
    for (const entry of entries) {
      if (longTasks.length >= MAX_LONG_TASKS) return;
      longTasks.push({ startMs: round(entry.startTime), durationMs: round(entry.duration) });
    }
  });
  observe('resource', (entries) => {
    for (const entry of entries) addResourceEntry(entry as PerformanceResourceTiming);
  });
}

/** Marks an application lifecycle boundary relative to this navigation start. */
export function markStartupMilestone(name: string): void {
  if (typeof performance === 'undefined') return;
  if (milestones[name] === undefined) milestones[name] = round(performance.now());
}

function readNavigation(): StartupNavigationValues {
  const entry = performance.getEntriesByType('navigation')[0] as PerformanceEntryLike | undefined;
  return {
    ttfbMs: round(asFiniteNumber(entry?.responseStart) ?? 0) || null,
    domInteractiveMs: round(asFiniteNumber(entry?.domInteractive) ?? 0) || null,
    domContentLoadedMs: round(asFiniteNumber(entry?.domContentLoadedEventEnd) ?? 0) || null,
    loadMs: round(asFiniteNumber(entry?.loadEventEnd) ?? 0) || null,
  };
}

function readResources(): StartupResource[] {
  const existing = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  for (const entry of existing) addResourceEntry(entry);
  return [...resourceEntries]
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, MAX_RESOURCE_SAMPLES);
}

async function readPwaState(): Promise<StartupPwaState> {
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches === true
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (!('serviceWorker' in navigator)) {
    return { supported: false, standalone, controlled: null, registration: null, caches: [], readError: null };
  }

  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const cacheNames = typeof caches === 'undefined'
      ? []
      : await caches.keys();
    const cloudcliCaches = await Promise.all(cacheNames
      .filter((name) => name.startsWith('cloudcli-'))
      .map(async (name) => {
        const cache = await caches.open(name);
        const entries = await cache.keys();
        return { name, entries: entries.length };
      }));
    return {
      supported: true,
      standalone,
      controlled: Boolean(navigator.serviceWorker.controller),
      registration: registration
        ? {
          scope: registration.scope,
          installing: registration.installing?.state ?? null,
          waiting: registration.waiting?.state ?? null,
          active: registration.active?.state ?? null,
        }
        : null,
      caches: cloudcliCaches,
      readError: null,
    };
  } catch (error) {
    return {
      supported: true,
      standalone,
      controlled: Boolean(navigator.serviceWorker.controller),
      registration: null,
      caches: [],
      readError: error instanceof Error ? error.name : 'unknown',
    };
  }
}

function readEnvironment(): StartupDiagnosticsReport['current']['environment'] {
  const connection = (navigator as Navigator & { connection?: ConnectionInformation }).connection;
  return {
    userAgent: navigator.userAgent,
    viewport: typeof window === 'undefined' ? null : {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    },
    online: typeof navigator.onLine === 'boolean' ? navigator.onLine : null,
    connection: {
      effectiveType: typeof connection?.effectiveType === 'string' ? connection.effectiveType : null,
      rttMs: asFiniteNumber(connection?.rtt),
      downlinkMbps: asFiniteNumber(connection?.downlink),
    },
  };
}

/** Builds the serializable report shape. Exported so tests pin privacy guarantees. */
export function buildStartupDiagnosticsReport(input: StartupReportInput): StartupDiagnosticsReport {
  return {
    schemaVersion: 1,
    current: {
      ...input,
      environment: readEnvironment(),
      milestones: { ...milestones },
    },
    history: readStartupDiagnosticsHistory(),
    privacy: {
      includesChatContent: false,
      includesCredentials: false,
      resourceUrlsAreSanitized: true,
    },
  };
}

function currentSnapshot(): StartupSnapshot {
  return {
    build: BUILD_INFO.describe || `${APP_VERSION}-${BUILD_INFO.commit}`,
    takenAt: new Date().toISOString(),
    metrics: { fcpMs, lcpMs, cls, inpMs },
  };
}

/** Starts zero-network browser-local startup sampling once per page load. */
export function startStartupDiagnostics(): void {
  if (started || typeof window === 'undefined' || typeof performance === 'undefined') return;
  started = true;
  markStartupMilestone('diagnostics_ready');
  observeStartupMetrics();

  const persist = () => {
    if (persistedCurrentPage) return;
    persistedCurrentPage = true;
    recordStartupDiagnosticsSnapshot(currentSnapshot());
  };
  window.addEventListener('pagehide', persist, { once: true });
  window.addEventListener('load', () => window.setTimeout(persist, 5_000), { once: true });
}

/** Reads the live page, including the asynchronous service-worker and cache state. */
export async function createStartupDiagnosticsReport(): Promise<StartupDiagnosticsReport> {
  const pwa = await readPwaState();
  return buildStartupDiagnosticsReport({
    build: BUILD_INFO.describe || `${APP_VERSION}-${BUILD_INFO.commit}`,
    takenAt: new Date().toISOString(),
    navigation: readNavigation(),
    metrics: { fcpMs, lcpMs, cls, inpMs },
    resources: readResources(),
    longTasks: [...longTasks],
    pwa,
  });
}

/** Downloads the privacy-scoped startup and PWA report for manual sharing. */
export async function downloadStartupDiagnosticsReport(): Promise<void> {
  const report = await createStartupDiagnosticsReport();
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `cloudcli-startup-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
