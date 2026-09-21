import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { VirtualizerHandle } from 'virtua';

/** Viewport distance from the bottom that still counts as parked at the bottom. */
const PIN_BOTTOM_THRESHOLD_PX = 60;

/**
 * How far ahead of the top edge older history starts loading, in viewports.
 * Paging only when the user hits the boundary is what made history arrive in
 * visible lurches; prefetching two screens ahead means the rows are already
 * measured by the time they are scrolled into.
 */
const PREFETCH_VIEWPORTS = 2;

type UseTranscriptViewportOptions = {
  isActive: boolean;
  hasMoreMessages: boolean;
  allMessagesLoaded: boolean;
  /**
   * Changes whenever the transcript's tail grows — row count plus the length
   * of the streaming row. Row count alone misses streaming, where the same
   * last row keeps getting taller.
   */
  tailSignal: number;
  /** Total rendered rows; the index space `scrollToRow` and sticking address. */
  rowCount: number;
  /** Resolves true when older rows actually prepended. */
  onLoadOlder: () => Promise<boolean | void>;
  /**
   * Bumped by the owner whenever the viewport should re-arm its initial stick
   * to the bottom — a session switch, or an explicit New Session. Passed as a
   * signal rather than a callback so the owner can reset from effects declared
   * above this hook's call site.
   */
  resetSignal: number;
};

export type TranscriptViewport = {
  scrollRef: RefObject<HTMLDivElement>;
  virtualizerRef: RefObject<VirtualizerHandle>;
  /** Drives the scroll-to-bottom affordance; the only pin state that renders. */
  isUserScrolledUp: boolean;
  /** True for the commit that prepends older rows, so virtua shifts instead of appends. */
  shiftOnPrepend: boolean;
  handleScroll: (offset: number) => void;
  stickToBottom: () => void;
  /** Centers a row by index. Used by the search jump. */
  scrollToRow: (index: number) => void;
};

/**
 * The transcript's viewport: pin state, sticking to the bottom, prefetching
 * older history, and index-addressed jumps.
 *
 * All of it rides on virtua's virtualizer, which measures every row it mounts
 * and absorbs the difference between an estimated and a real row height by
 * correcting `scrollTop` itself. That is what this hook does NOT have to do,
 * and what the code it replaced spent ~500 lines doing by hand: no rAF
 * settle loops, no height-diff compensation for prepends, no ResizeObserver
 * re-pinning, no boundary hysteresis, no chained paging timers. Verified in a
 * real browser: scrolling up 60 screens through never-measured rows moves the
 * content exactly as far as asked, 0px of visual drift.
 */
export function useTranscriptViewport({
  isActive,
  hasMoreMessages,
  allMessagesLoaded,
  tailSignal,
  rowCount,
  onLoadOlder,
  resetSignal,
}: UseTranscriptViewportOptions): TranscriptViewport {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizerRef = useRef<VirtualizerHandle>(null);

  // Pin state renders only when it flips, because it drives the
  // scroll-to-bottom button; the ref mirror is what scroll-time code reads.
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const isPinnedRef = useRef(true);

  // virtua needs to know a commit prepends rather than appends, so it holds
  // the viewport against the end of the list instead of the start.
  const [shiftOnPrepend, setShiftOnPrepend] = useState(false);

  // A session switch has to land at the bottom even though no scroll event
  // has happened yet; this survives until the first row count arrives.
  const pendingInitialStickRef = useRef(true);

  // Mirrored as state as well as a ref: the ref deduplicates requests within a
  // single scroll burst, while the state edge is what disarms the prepend
  // shift. Keying that off the row count alone would strand `shiftOnPrepend`
  // on true whenever a page came back empty, and the next append would then be
  // compensated as if it were history.
  const olderRequestInFlightRef = useRef(false);
  const [olderRequestInFlight, setOlderRequestInFlight] = useState(false);

  // Latest values for the scroll handler, which must stay referentially stable.
  const isActiveRef = useRef(isActive);
  const loadStateRef = useRef({ hasMoreMessages, allMessagesLoaded });
  const onLoadOlderRef = useRef(onLoadOlder);
  useEffect(() => {
    isActiveRef.current = isActive;
    loadStateRef.current = { hasMoreMessages, allMessagesLoaded };
    onLoadOlderRef.current = onLoadOlder;
  });

  const stickToBottom = useCallback(() => {
    isPinnedRef.current = true;
    setIsUserScrolledUp(false);
    const virtualizer = virtualizerRef.current;
    if (!virtualizer || rowCount === 0) return;
    virtualizer.scrollToIndex(rowCount - 1, { align: 'end' });
  }, [rowCount]);

  const requestOlder = useCallback(() => {
    if (!isActiveRef.current || olderRequestInFlightRef.current) return;
    const { hasMoreMessages: hasMore, allMessagesLoaded: allLoaded } = loadStateRef.current;
    if (!hasMore || allLoaded) return;

    olderRequestInFlightRef.current = true;
    setOlderRequestInFlight(true);
    // Armed before the request so the flag is already committed when the
    // prepended rows arrive; disarmed once that commit has been rendered.
    setShiftOnPrepend(true);
    void Promise.resolve(onLoadOlderRef.current())
      .catch(() => undefined)
      .finally(() => {
        olderRequestInFlightRef.current = false;
        setOlderRequestInFlight(false);
      });
  }, []);

  const handleScroll = useCallback((offset: number) => {
    const virtualizer = virtualizerRef.current;
    if (!virtualizer || !isActiveRef.current) return;

    const distanceFromBottom = virtualizer.scrollSize - offset - virtualizer.viewportSize;
    const pinned = distanceFromBottom <= PIN_BOTTOM_THRESHOLD_PX;
    if (isPinnedRef.current !== pinned) {
      isPinnedRef.current = pinned;
      setIsUserScrolledUp(!pinned);
    }

    if (offset < virtualizer.viewportSize * PREFETCH_VIEWPORTS) {
      requestOlder();
    }
  }, [requestOlder]);

  // Follow the tail while parked at the bottom. virtua holds the position of
  // everything above on its own, so this is the only place that moves the
  // viewport as content arrives.
  useEffect(() => {
    if (!isActive || rowCount === 0) return;
    if (!pendingInitialStickRef.current && !isPinnedRef.current) return;
    pendingInitialStickRef.current = false;
    virtualizerRef.current?.scrollToIndex(rowCount - 1, { align: 'end' });
  }, [tailSignal, rowCount, isActive]);

  // Disarm the prepend shift once the request has settled and its rows have
  // been rendered, so an append landing later is not mistaken for more history.
  useEffect(() => {
    if (!shiftOnPrepend || olderRequestInFlight) return;
    setShiftOnPrepend(false);
  }, [shiftOnPrepend, olderRequestInFlight, rowCount]);

  const scrollToRow = useCallback((index: number) => {
    isPinnedRef.current = false;
    setIsUserScrolledUp(true);
    virtualizerRef.current?.scrollToIndex(index, { align: 'center' });
  }, []);

  // Re-arm the bottom stick for a new transcript.
  useEffect(() => {
    pendingInitialStickRef.current = true;
    isPinnedRef.current = true;
    setIsUserScrolledUp(false);
  }, [resetSignal]);

  return {
    scrollRef,
    virtualizerRef,
    isUserScrolledUp,
    shiftOnPrepend,
    handleScroll,
    stickToBottom,
    scrollToRow,
  };
}
