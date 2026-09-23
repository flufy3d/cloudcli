/**
 * The screening exists to tell three identical-looking failures apart, so what
 * matters is that it separates a pane that refused to move from one that was
 * never scrollable, and that it stays quiet for the touches that behaved.
 */

import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import {
  judgeTouchScroll,
  observeScrollStuck,
  readScrollScreenings,
  resetScrollScreenings,
} from '@/shared/diagnostics/scrollScreening';
import type { TouchScrollAttempt } from '@/shared/diagnostics/scrollScreening';

beforeEach(() => {
  resetScrollScreenings();
});

function attempt(overrides: Partial<TouchScrollAttempt> = {}): TouchScrollAttempt {
  return {
    travelPx: 120,
    directionSign: 1,
    scrollMovedPx: 0,
    scrollTop: 400,
    scrollHeight: 4000,
    clientHeight: 800,
    ...overrides,
  };
}

test('a long swipe over a scrollable pane that did not move is stuck', () => {
  assert.equal(judgeTouchScroll(attempt()), 'stuck');
});

test('a pane whose content is no taller than its viewport had no room to scroll', () => {
  // The collapsed-virtualizer case: the list is there, the scroll range is not.
  assert.equal(judgeTouchScroll(attempt({ scrollHeight: 802, clientHeight: 800, scrollTop: 0 })), 'no-room');
});

test('a pane parked against the edge the finger pushes toward is not a finding', () => {
  assert.equal(judgeTouchScroll(attempt({ scrollTop: 3200 })), 'at-edge');
  assert.equal(judgeTouchScroll(attempt({ directionSign: -1, scrollTop: 0 })), 'at-edge');
});

test('a pane that moved, and a touch too short to be a scroll, are both quiet', () => {
  assert.equal(judgeTouchScroll(attempt({ scrollMovedPx: 60 })), 'moved');
  assert.equal(judgeTouchScroll(attempt({ travelPx: 8 })), 'ignored');
  assert.equal(judgeTouchScroll(attempt({ travelPx: 200, directionSign: 0 })), 'ignored');
});

/**
 * A pane stub with the geometry the real one has when it is stuck: the
 * jsdom element has no layout, so the dimensions are defined outright.
 */
function createPane(geometry: { scrollHeight: number; clientHeight: number; scrollTop?: number }): HTMLElement {
  const pane = document.createElement('div');
  Object.defineProperty(pane, 'scrollHeight', { value: geometry.scrollHeight, configurable: true });
  Object.defineProperty(pane, 'clientHeight', { value: geometry.clientHeight, configurable: true });
  pane.scrollTop = geometry.scrollTop ?? 400;
  document.body.appendChild(pane);
  return pane;
}

function touchEvent(type: string, clientY: number): Event {
  const event = new Event(type, { bubbles: true });
  const touch = { identifier: 1, clientY, clientX: 100 };
  const list = type === 'touchend' ? [] : [touch];
  Object.defineProperties(event, {
    touches: { value: list },
    changedTouches: { value: [touch] },
  });
  return event;
}

test('the observer records the swipe the pane ignored, with the state that explains it', () => {
  const pane = createPane({ scrollHeight: 4000, clientHeight: 800 });
  const stop = observeScrollStuck(pane);

  pane.dispatchEvent(touchEvent('touchstart', 500));
  pane.dispatchEvent(touchEvent('touchmove', 400));
  pane.dispatchEvent(touchEvent('touchmove', 300));
  pane.dispatchEvent(touchEvent('touchend', 300));
  stop();

  const screenings = readScrollScreenings();
  assert.equal(screenings.length, 1);
  assert.equal(screenings[0]?.verdict, 'stuck');
  assert.equal(screenings[0]?.attempt.travelPx, 200);
  assert.equal(screenings[0]?.attempt.scrollMovedPx, 0);
  // Which of the three causes it was is exactly what these fields carry.
  assert.equal(typeof screenings[0]?.pane.hitTestInsidePane, 'boolean');
  assert.equal(typeof screenings[0]?.pane.maxEventLagMs, 'number');
});

test('the observer stays quiet when the pane scrolled with the finger', () => {
  const pane = createPane({ scrollHeight: 4000, clientHeight: 800 });
  const stop = observeScrollStuck(pane);

  pane.dispatchEvent(touchEvent('touchstart', 500));
  pane.scrollTop = 560;
  pane.dispatchEvent(touchEvent('touchmove', 340));
  pane.dispatchEvent(touchEvent('touchend', 340));
  stop();

  assert.deepEqual(readScrollScreenings(), []);
});

test('teardown stops the screening', () => {
  const pane = createPane({ scrollHeight: 4000, clientHeight: 800 });
  observeScrollStuck(pane)();

  pane.dispatchEvent(touchEvent('touchstart', 500));
  pane.dispatchEvent(touchEvent('touchmove', 300));
  pane.dispatchEvent(touchEvent('touchend', 300));

  assert.deepEqual(readScrollScreenings(), []);
});
