import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import {
  buildStartupDiagnosticsSection,
  clearStartupDiagnosticsHistory,
  recordStartupDiagnosticsSnapshot,
  readStartupDiagnosticsHistory,
  sanitizeStartupResource,
} from '@/shared/diagnostics/startupDiagnostics';

beforeEach(() => {
  clearStartupDiagnosticsHistory();
});

test('startup resource diagnostics strip API paths, queries and fragments', () => {
  assert.deepEqual(
    sanitizeStartupResource('https://cloudcli.example/api/projects/981?token=secret#fragment', 'https://cloudcli.example'),
    { category: 'api', label: '/api' },
  );
  assert.deepEqual(
    sanitizeStartupResource('https://cloudcli.example/assets/index-aBc123.js?trace=secret', 'https://cloudcli.example'),
    { category: 'asset', label: '/assets/index-aBc123.js' },
  );
  assert.deepEqual(
    sanitizeStartupResource('https://tracker.example/collect?email=user@example.com', 'https://cloudcli.example'),
    { category: 'external', label: 'external' },
  );
  assert.deepEqual(
    sanitizeStartupResource('https://cloudcli.example/plugin-assets/acme/private-id', 'https://cloudcli.example'),
    { category: 'other', label: 'same_origin_other' },
  );
});

test('keeps only the newest startup records for cross-build comparison', () => {
  for (let index = 0; index < 7; index += 1) {
    recordStartupDiagnosticsSnapshot({
      build: `build-${index}`,
      takenAt: `2026-09-22T00:00:0${index}.000Z`,
      metrics: { fcpMs: index },
    });
  }

  assert.deepEqual(readStartupDiagnosticsHistory().map((snapshot) => snapshot.build), [
    'build-2',
    'build-3',
    'build-4',
    'build-5',
    'build-6',
  ]);
});

test('reports unsupported metrics as null instead of manufacturing a zero', () => {
  const section = buildStartupDiagnosticsSection({
    build: 'v2.5.8-abc',
    takenAt: '2026-09-22T00:00:00.000Z',
    navigation: { ttfbMs: 42 },
    metrics: { fcpMs: null, lcpMs: null, cls: null, inpMs: null },
    resources: [],
    longTasks: [],
    pwa: { supported: false },
  });

  assert.equal(section.current.metrics.fcpMs, null);
  assert.equal(section.current.pwa.supported, false);
});
