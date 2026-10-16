import { describe, expect, it } from 'vitest';
import { computePosition, type PositionInput } from './position';

const viewport = { width: 1000, height: 700 };

function input(overrides: Partial<PositionInput>): PositionInput {
  return {
    anchor: { top: 100, left: 200, width: 240, height: 34 },
    floating: { width: 240, height: 300 },
    viewport,
    placement: 'bottom',
    align: 'start',
    offset: 6,
    padding: 8,
    ...overrides,
  };
}

describe('computePosition', () => {
  it('places a dropdown under its anchor, start-aligned', () => {
    expect(computePosition(input({}))).toEqual({
      top: 140,
      left: 200,
      placement: 'bottom',
      available: 552,
    });
  });

  it('flips above when there is no room below but more above', () => {
    const result = computePosition(
      input({ anchor: { top: 560, left: 200, width: 240, height: 34 } }),
    );
    expect(result.placement).toBe('top');
    expect(result.top).toBe(560 - 6 - 300);
    expect(result.available).toBe(546);
  });

  it('stays on the preferred side when the other one is even smaller, reporting the room it has', () => {
    const result = computePosition(
      input({
        anchor: { top: 300, left: 200, width: 240, height: 34 },
        floating: { width: 240, height: 500 },
      }),
    );
    expect(result.placement).toBe('bottom');
    expect(result.top).toBe(340);
    // 700 − 334 − 6 − 8: the popup is expected to cap its height to this and scroll.
    expect(result.available).toBe(352);
  });

  it('anchors a clipped popup to the anchor when it opens upward', () => {
    const result = computePosition(
      input({
        anchor: { top: 400, left: 200, width: 240, height: 34 },
        floating: { width: 240, height: 600 },
        placement: 'top',
      }),
    );
    expect(result.placement).toBe('top');
    expect(result.available).toBe(386);
    // Positioned for its capped height, so its bottom edge still touches the anchor's gap.
    expect(result.top).toBe(400 - 6 - 386);
  });

  it('shifts horizontally to stay inside the viewport', () => {
    expect(
      computePosition(input({ anchor: { top: 100, left: 900, width: 80, height: 34 } })).left,
    ).toBe(752);
    expect(
      computePosition(
        input({ anchor: { top: 100, left: -40, width: 80, height: 34 }, align: 'end' }),
      ).left,
    ).toBe(8);
  });

  it('centres and end-aligns along the anchor', () => {
    const anchor = { top: 100, left: 400, width: 100, height: 30 };
    const floating = { width: 60, height: 24 };
    expect(computePosition(input({ anchor, floating, align: 'center' })).left).toBe(420);
    expect(computePosition(input({ anchor, floating, align: 'end' })).left).toBe(440);
  });

  it('handles side placements, flipping and vertical shifting', () => {
    const anchor = { top: 10, left: 20, width: 40, height: 40 };
    const floating = { width: 180, height: 60 };
    const right = computePosition(input({ anchor, floating, placement: 'right', align: 'center' }));
    expect(right).toMatchObject({ placement: 'right', left: 66, top: 8 });

    const flipped = computePosition(
      input({ anchor, floating, placement: 'left', align: 'center' }),
    );
    expect(flipped.placement).toBe('right');

    const nearRightEdge = computePosition(
      input({
        anchor: { top: 300, left: 940, width: 40, height: 40 },
        floating,
        placement: 'right',
      }),
    );
    expect(nearRightEdge).toMatchObject({ placement: 'left', left: 940 - 6 - 180 });
  });

  it('never returns a negative amount of room', () => {
    const result = computePosition(
      input({
        viewport: { width: 300, height: 40 },
        anchor: { top: 10, left: 10, width: 50, height: 30 },
      }),
    );
    expect(result.available).toBe(0);
  });
});
