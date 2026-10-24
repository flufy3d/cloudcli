import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/shared/ui/Collapsible';

/**
 * Pins lazy content: a folded body is not mounted until first opened. A long
 * transcript holds hundreds of folded thinking blocks and tool outputs, and
 * mounting them all parsed every body's markdown just to hide it. Once opened
 * the body stays mounted so the fold animates closed; the native <details>
 * variant (exported documents) keeps the body in the DOM for the browser.
 */

const renderFold = (props: { defaultOpen?: boolean; nativeDetails?: boolean } = {}) =>
  render(
    <Collapsible {...props}>
      <CollapsibleTrigger>toggle</CollapsibleTrigger>
      <CollapsibleContent>
        <p>folded body</p>
      </CollapsibleContent>
    </Collapsible>,
  );

describe('CollapsibleContent lazy mount', () => {
  it('does not mount the body while it has never been opened', () => {
    renderFold();

    expect(screen.queryByText('folded body')).toBeNull();
  });

  it('mounts the body on first open and keeps it mounted after closing', () => {
    renderFold();

    fireEvent.click(screen.getByText('toggle'));
    expect(screen.getByText('folded body')).toBeTruthy();

    fireEvent.click(screen.getByText('toggle'));
    expect(screen.getByText('folded body')).toBeTruthy();
  });

  it('mounts the body immediately when it starts open', () => {
    renderFold({ defaultOpen: true });

    expect(screen.getByText('folded body')).toBeTruthy();
  });

  it('keeps the native details body in the DOM while closed', () => {
    renderFold({ nativeDetails: true });

    expect(screen.getByText('folded body')).toBeTruthy();
  });
});
