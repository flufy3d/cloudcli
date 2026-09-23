/**
 * Why a swipe over the transcript did nothing.
 *
 * "The message list won't scroll" arrives as a screenshot of a still list,
 * which is the one thing every cause looks like: a virtualized list whose
 * total height collapsed to the viewport height has no scroll room; an
 * invisible layer over the pane means the finger never touches the scroller at
 * all; a blocked main thread leaves the touches queued. The three need
 * opposite fixes and none of them can be told apart after the fact, so this
 * screens every touch that should have scrolled and records the ones that did
 * not, with the few numbers that separate the causes.
 *
 * It costs nothing until a finger is on the pane: passive listeners, two
 * numbers compared per move, and a geometry read only when a verdict is worth
 * recording. Findings survive a reload, because a stuck list is usually
 * reloaded long before anyone thinks to export a report.
 *
 * Consumers: `ChatMessagesPane` (observes its scroll container) and
 * `diagnosticsReport` (folds the findings into the exported report).
 */

/** Finger travel below this is a tap or a jitter, not a scroll attempt. */
const MIN_TRAVEL_PX = 24;

/** Scroll movement at or above this counts as the pane having responded. */
const MOVED_EPSILON_PX = 2;

/** Scroll room at or below this is no room at all, after rounding. */
const NO_ROOM_EPSILON_PX = 4;

/** How many findings to keep. Each one is a separate incident worth reading. */
const MAX_SCREENINGS = 20;

const STORAGE_KEY = 'cloudcli-scroll-screenings-v1';

/**
 * The facts of one touch, gathered while it was happening. Split out from the
 * verdict so the decision itself is a pure function over plain numbers.
 */
export type TouchScrollAttempt = {
  /** Largest vertical distance the finger reached from where it started. */
  travelPx: number;
  /**
   * Which way the content was asked to move: `1` when the finger went up
   * (reveal what is below, `scrollTop` should grow), `-1` for the other way.
   */
  directionSign: 1 | -1 | 0;
  /** Largest change in `scrollTop` seen during the touch. */
  scrollMovedPx: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

/**
 * What the touch proved. Only `stuck` and `no-room` are defects — the first
 * says the pane had room and refused to move, the second says the list never
 * had room to begin with.
 */
export type TouchScrollVerdict = 'ignored' | 'moved' | 'at-edge' | 'no-room' | 'stuck';

/**
 * Reads the verdict off one touch.
 *
 * Consumers: the observer below, and the tests that pin the boundaries.
 */
export function judgeTouchScroll(attempt: TouchScrollAttempt): TouchScrollVerdict {
  if (attempt.travelPx < MIN_TRAVEL_PX || attempt.directionSign === 0) {
    return 'ignored';
  }
  if (attempt.scrollMovedPx >= MOVED_EPSILON_PX) {
    return 'moved';
  }

  const room = attempt.scrollHeight - attempt.clientHeight;
  if (room <= NO_ROOM_EPSILON_PX) {
    return 'no-room';
  }

  // A pane already parked against the edge the finger is pushing toward is
  // behaving correctly, and reporting it would bury the real findings.
  const roomInDirection = attempt.directionSign === 1
    ? room - attempt.scrollTop
    : attempt.scrollTop;
  if (roomInDirection <= MOVED_EPSILON_PX) {
    return 'at-edge';
  }

  return 'stuck';
}

/**
 * The state of the pane at the moment a touch failed, covering each candidate
 * cause: geometry and computed styles for a collapsed or non-scrollable pane,
 * the hit test for a layer sitting over it, and the event lag for a main
 * thread too busy to deliver the touches.
 */
export type ScrollPaneState = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  overflowY: string;
  touchAction: string;
  contain: string;
  /** A transform on the scroller changes what the compositor will scroll. */
  transform: string;
  /** False when the point at the pane's center belongs to something else. */
  hitTestInsidePane: boolean;
  /** What was hit instead, as tag plus class list, when it was not the pane. */
  hitTestTarget?: string;
  /**
   * Longest delay between a touch event being generated and this code seeing
   * it. Large values mean the main thread was blocked, not the scroller.
   */
  maxEventLagMs: number;
};

export type ScrollScreening = {
  /** Milliseconds since this page loaded. */
  at: number;
  wallClock: string;
  verdict: Extract<TouchScrollVerdict, 'stuck' | 'no-room'>;
  attempt: TouchScrollAttempt;
  pane: ScrollPaneState;
};

const screenings: ScrollScreening[] = [];
let restored = false;

function readSessionStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    // Storage access throws outright in some embedded and private-mode browsers.
    return null;
  }
}

function persist(): void {
  const storage = readSessionStorage();
  if (!storage) {
    return;
  }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(screenings));
  } catch {
    // A full quota must never break the app this is only watching.
  }
}

function restoreOnce(): void {
  if (restored) {
    return;
  }
  restored = true;
  const storage = readSessionStorage();
  if (!storage) {
    return;
  }
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) {
      return;
    }
    for (const entry of parsed) {
      if (entry && typeof entry === 'object' && 'verdict' in entry) {
        screenings.push(entry as ScrollScreening);
      }
    }
  } catch {
    // An unreadable buffer is not worth failing a page load over.
  }
}

/**
 * The findings so far, oldest first, including ones from earlier page loads.
 *
 * Consumer: `diagnosticsReport`.
 */
export function readScrollScreenings(): ScrollScreening[] {
  restoreOnce();
  return screenings;
}

/** Consumer: the tests, between cases. */
export function resetScrollScreenings(): void {
  restored = true;
  screenings.length = 0;
  readSessionStorage()?.removeItem(STORAGE_KEY);
}

function describeElement(element: Element | null): string | undefined {
  if (!element) {
    return undefined;
  }
  const classes = typeof element.className === 'string' ? element.className.trim() : '';
  return classes ? `${element.tagName.toLowerCase()}.${classes.split(/\s+/).join('.')}` : element.tagName.toLowerCase();
}

function readPaneState(pane: HTMLElement, maxEventLagMs: number): ScrollPaneState {
  const style = typeof window !== 'undefined' && window.getComputedStyle
    ? window.getComputedStyle(pane)
    : null;
  const rect = pane.getBoundingClientRect();
  const hit = typeof document !== 'undefined' && document.elementFromPoint
    ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    : null;
  const hitTestInsidePane = hit ? pane.contains(hit) : false;

  return {
    scrollTop: pane.scrollTop,
    scrollHeight: pane.scrollHeight,
    clientHeight: pane.clientHeight,
    overflowY: style?.overflowY ?? '',
    touchAction: style?.touchAction ?? '',
    contain: style?.contain ?? '',
    transform: style?.transform ?? '',
    hitTestInsidePane,
    hitTestTarget: hitTestInsidePane ? undefined : describeElement(hit),
    maxEventLagMs,
  };
}

function record(verdict: 'stuck' | 'no-room', attempt: TouchScrollAttempt, pane: ScrollPaneState): void {
  restoreOnce();
  screenings.push({
    at: Math.round(performance.now()),
    wallClock: new Date().toISOString(),
    verdict,
    attempt,
    pane,
  });
  if (screenings.length > MAX_SCREENINGS) {
    screenings.splice(0, screenings.length - MAX_SCREENINGS);
  }
  persist();
}

/**
 * Watches one scroll container and records the touches that should have
 * scrolled it but did not. Returns the teardown.
 *
 * Consumer: `ChatMessagesPane`, for the transcript's scroll container.
 */
export function observeScrollStuck(pane: HTMLElement): () => void {
  let touchId: number | null = null;
  let startY = 0;
  let startScrollTop = 0;
  let travelPx = 0;
  let directionSign: 1 | -1 | 0 = 0;
  let scrollMovedPx = 0;
  let maxEventLagMs = 0;

  const eventLag = (event: TouchEvent): number => {
    const lag = performance.now() - event.timeStamp;
    // A negative or absurd lag means the event clock is not the performance
    // clock on this engine; a lag that cannot be trusted is not recorded.
    return Number.isFinite(lag) && lag >= 0 && lag < 60_000 ? lag : 0;
  };

  const handleTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) {
      touchId = null;
      return;
    }
    const [touch] = event.touches;
    if (!touch) {
      return;
    }
    touchId = touch.identifier;
    startY = touch.clientY;
    startScrollTop = pane.scrollTop;
    travelPx = 0;
    directionSign = 0;
    scrollMovedPx = 0;
    maxEventLagMs = 0;
  };

  const handleTouchMove = (event: TouchEvent) => {
    if (touchId === null) {
      return;
    }
    const touch = Array.from(event.touches).find((candidate) => candidate.identifier === touchId);
    if (!touch) {
      return;
    }
    const deltaY = startY - touch.clientY;
    if (Math.abs(deltaY) > travelPx) {
      travelPx = Math.abs(deltaY);
      directionSign = deltaY > 0 ? 1 : -1;
    }
    scrollMovedPx = Math.max(scrollMovedPx, Math.abs(pane.scrollTop - startScrollTop));
    maxEventLagMs = Math.max(maxEventLagMs, eventLag(event));
  };

  const handleTouchEnd = () => {
    if (touchId === null) {
      return;
    }
    touchId = null;
    scrollMovedPx = Math.max(scrollMovedPx, Math.abs(pane.scrollTop - startScrollTop));

    const attempt: TouchScrollAttempt = {
      travelPx: Math.round(travelPx),
      directionSign,
      scrollMovedPx: Math.round(scrollMovedPx),
      scrollTop: Math.round(pane.scrollTop),
      scrollHeight: Math.round(pane.scrollHeight),
      clientHeight: Math.round(pane.clientHeight),
    };
    const verdict = judgeTouchScroll(attempt);
    if (verdict !== 'stuck' && verdict !== 'no-room') {
      return;
    }
    record(verdict, attempt, readPaneState(pane, Math.round(maxEventLagMs)));
  };

  pane.addEventListener('touchstart', handleTouchStart, { passive: true });
  pane.addEventListener('touchmove', handleTouchMove, { passive: true });
  pane.addEventListener('touchend', handleTouchEnd, { passive: true });
  pane.addEventListener('touchcancel', handleTouchEnd, { passive: true });

  return () => {
    pane.removeEventListener('touchstart', handleTouchStart);
    pane.removeEventListener('touchmove', handleTouchMove);
    pane.removeEventListener('touchend', handleTouchEnd);
    pane.removeEventListener('touchcancel', handleTouchEnd);
  };
}
