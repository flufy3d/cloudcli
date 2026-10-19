import { describe, expect, it } from 'vitest';

import { findCatalogModelOption } from '@/modules/chat/utils/catalogModel';

const options = [
  { value: 'default', label: 'Default (recommended)' },
  { value: 'opus', label: 'Opus 5.5' },
  { value: 'sonnet', label: 'Sonnet 5.5' },
];

describe('findCatalogModelOption', () => {
  it('matches the exact id first', () => {
    expect(findCatalogModelOption(options, 'opus')?.label).toBe('Opus 5.5');
  });

  it('maps a saved 1M alias onto its base entry once the catalog no longer lists it', () => {
    expect(findCatalogModelOption(options, 'opus[1m]')?.value).toBe('opus');
    expect(findCatalogModelOption(options, 'sonnet[1m]')?.value).toBe('sonnet');
  });

  it('keeps a 1M entry the catalog still lists', () => {
    const withFable = [...options, { value: 'claude-fable-5-1[1m]', label: 'Fable' }];
    expect(findCatalogModelOption(withFable, 'claude-fable-5-1[1m]')?.label).toBe('Fable');
  });

  it('finds nothing for an unlisted id or an empty choice', () => {
    expect(findCatalogModelOption(options, 'opusplan')).toBeNull();
    expect(findCatalogModelOption(options, 'haiku[1m]')).toBeNull();
    expect(findCatalogModelOption(options, '')).toBeNull();
    expect(findCatalogModelOption(options, null)).toBeNull();
  });
});
