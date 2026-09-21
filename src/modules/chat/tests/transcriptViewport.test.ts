import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { test, vi } from 'vitest';
import type { VirtualizerHandle } from 'virtua';

import { useTranscriptViewport } from '@/modules/chat/hooks/useTranscriptViewport';

/**
 * Behavior contract for the transcript viewport.
 *
 * The scroll *stabilization* this replaced (rAF settle loops, height-diff
 * compensation, boundary hysteresis) is gone: virtua owns it, and it is
 * verified against a real layout engine by
 * scripts/perf/chat-scroll-up-stability.mjs, not here — jsdom has no layout,
 * so any assertion about pixels would be asserting the mock.
 *
 * What IS this hook's own logic, and is pinned here: when older history is
 * requested, that concurrent requests collapse into one, and when the
 * scroll-to-bottom affordance appears.
 */

/** A virtualizer positioned `offsetFromTop` into a list of `scrollSize` px. */
function fakeVirtualizer(geometry: {
  scrollSize: number;
  viewportSize: number;
}): VirtualizerHandle & { scrollToIndexCalls: Array<[number, unknown]> } {
  const scrollToIndexCalls: Array<[number, unknown]> = [];
  return {
    ...geometry,
    scrollOffset: 0,
    cache: {} as VirtualizerHandle['cache'],
    findItemIndex: () => 0,
    getItemOffset: () => 0,
    getItemSize: () => 0,
    scrollToIndex: (index: number, opts?: unknown) => {
      scrollToIndexCalls.push([index, opts]);
    },
    scrollTo: () => undefined,
    scrollBy: () => undefined,
    scrollToIndexCalls,
  };
}

type ViewportOptions = Parameters<typeof useTranscriptViewport>[0];
type ViewportOverrides = Partial<Omit<ViewportOptions, 'onLoadOlder'>>;
type LoadOlder = ReturnType<typeof vi.fn<() => Promise<boolean>>>;

function setup(overrides: ViewportOverrides & { onLoadOlder?: LoadOlder } = {}) {
  const onLoadOlder: LoadOlder = overrides.onLoadOlder ?? vi.fn(() => Promise.resolve(true));
  const rendered = renderHook((props: ViewportOverrides) =>
    useTranscriptViewport({
      isActive: true,
      hasMoreMessages: true,
      allMessagesLoaded: false,
      tailSignal: 0,
      rowCount: 50,
      resetSignal: 0,
      ...overrides,
      ...props,
      onLoadOlder,
    }),
  { initialProps: {} as ViewportOverrides });

  const virtualizer = fakeVirtualizer({ scrollSize: 10000, viewportSize: 800 });
  // The hook writes to this ref through the Virtualizer's `ref` prop in the app.
  (rendered.result.current.virtualizerRef as { current: VirtualizerHandle | null }).current =
    virtualizer;

  return { ...rendered, onLoadOlder, virtualizer };
}

test('older history is requested two viewports before the top edge, not at it', () => {
  const { result, onLoadOlder } = setup();

  // 2.5 viewports from the top: still reading, nothing to fetch yet.
  act(() => result.current.handleScroll(2000));
  assert.equal(onLoadOlder.mock.calls.length, 0, 'prefetching this early would fetch the whole history');

  // Inside two viewports (1600px): the rows are close enough that they must be
  // loaded and measured before the reader arrives at them.
  act(() => result.current.handleScroll(1500));
  assert.equal(onLoadOlder.mock.calls.length, 1);
});

test('scroll events during an in-flight page do not stack up requests', async () => {
  let resolveLoad: (loaded: boolean) => void = () => undefined;
  const onLoadOlder = vi.fn(() => new Promise<boolean>((resolve) => { resolveLoad = resolve; }));
  const { result } = setup({ onLoadOlder });

  act(() => result.current.handleScroll(100));
  act(() => result.current.handleScroll(80));
  act(() => result.current.handleScroll(60));
  assert.equal(onLoadOlder.mock.calls.length, 1, 'one page per scroll burst');

  await act(async () => { resolveLoad(true); });
});

test('no history is requested once the transcript is fully loaded', () => {
  const { result, onLoadOlder } = setup({ hasMoreMessages: false });
  act(() => result.current.handleScroll(0));
  assert.equal(onLoadOlder.mock.calls.length, 0);

  const loaded = setup({ allMessagesLoaded: true });
  act(() => loaded.result.current.handleScroll(0));
  assert.equal(loaded.onLoadOlder.mock.calls.length, 0);
});

test('the prepend shift is armed with the request and disarmed once rendered', async () => {
  let resolveLoad: (loaded: boolean) => void = () => undefined;
  const onLoadOlder = vi.fn(() => new Promise<boolean>((resolve) => { resolveLoad = resolve; }));
  const { result, rerender } = setup({ onLoadOlder });

  assert.equal(result.current.shiftOnPrepend, false, 'appends must not shift');

  act(() => result.current.handleScroll(0));
  assert.equal(
    result.current.shiftOnPrepend,
    true,
    'must be committed before the rows arrive, or virtua treats the prepend as an append',
  );

  // The page settles and its rows land as a larger row count.
  await act(async () => { resolveLoad(true); });
  rerender({ rowCount: 70 });
  assert.equal(result.current.shiftOnPrepend, false, 'a later append must not be shifted');
});

test('the scroll-to-bottom affordance tracks the pin state', () => {
  const { result, virtualizer } = setup();
  assert.equal(result.current.isUserScrolledUp, false, 'a fresh transcript starts pinned');

  // 10000 - 5000 - 800 = 4200px from the bottom.
  act(() => result.current.handleScroll(5000));
  assert.equal(result.current.isUserScrolledUp, true);

  // Within the 60px threshold of the bottom (10000 - 9160 - 800 = 40).
  act(() => result.current.handleScroll(9160));
  assert.equal(result.current.isUserScrolledUp, false);

  act(() => result.current.stickToBottom());
  assert.equal(result.current.isUserScrolledUp, false);
  assert.deepEqual(
    virtualizer.scrollToIndexCalls.at(-1),
    [49, { align: 'end' }],
    'sticking addresses the last row by index, not a pixel offset',
  );
});

test('a search jump centers the row and releases the bottom pin', () => {
  const { result, virtualizer } = setup();

  act(() => result.current.scrollToRow(12));

  assert.deepEqual(virtualizer.scrollToIndexCalls.at(-1), [12, { align: 'center' }]);
  assert.equal(
    result.current.isUserScrolledUp,
    true,
    'the jump owns the viewport; the next append must not yank it to the bottom',
  );
});
