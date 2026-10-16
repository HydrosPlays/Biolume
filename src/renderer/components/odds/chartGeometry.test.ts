import { describe, expect, it } from 'vitest';
import { formatCount } from '@renderer/lib/format';
import {
  areaPath,
  countTicks,
  formatAxisCount,
  labelAnchor,
  linePath,
  niceStep,
  pixelToCount,
  plotArea,
  scrubStep,
  scrubTo,
  tickTarget,
  tooltipLeft,
  tooltipTop,
  visibleLabels,
  xToPixel,
  yToPixel,
} from './chartGeometry';

const MARGINS = { top: 10, right: 20, bottom: 30, left: 40 };
// 640 × 240 with the margins above: a 580 × 200 plot from (40, 10) to (620, 210).
const AREA = plotArea(640, 240, MARGINS);

describe('plotArea', () => {
  it('insets the SVG by the margins', () => {
    expect(AREA).toEqual({ left: 40, right: 620, top: 10, bottom: 210, width: 580, height: 200 });
  });

  it('never collapses, even before the container has been measured', () => {
    const empty = plotArea(0, 0, MARGINS);
    expect(empty.width).toBe(1);
    expect(empty.height).toBe(1);
  });
});

describe('scales', () => {
  it('maps counts and probabilities onto the plot and clamps what falls outside', () => {
    expect(xToPixel(0, 1000, AREA)).toBe(40);
    expect(xToPixel(500, 1000, AREA)).toBe(330);
    expect(xToPixel(1000, 1000, AREA)).toBe(620);
    expect(xToPixel(5000, 1000, AREA)).toBe(620);
    expect(xToPixel(Number.NaN, 1000, AREA)).toBe(40);

    expect(yToPixel(0, AREA)).toBe(210);
    expect(yToPixel(0.5, AREA)).toBe(110);
    expect(yToPixel(1, AREA)).toBe(10);
    expect(yToPixel(1.4, AREA)).toBe(10);
  });

  it('inverts pixels back to whole encounter counts', () => {
    for (const n of [0, 1, 250, 999, 1000]) {
      expect(pixelToCount(xToPixel(n, 1000, AREA), 1000, AREA)).toBe(n);
    }
    expect(pixelToCount(-50, 1000, AREA)).toBe(0);
    expect(pixelToCount(9999, 1000, AREA)).toBe(1000);
    // A degenerate range still yields a finite position.
    expect(pixelToCount(330, 0, AREA)).toBe(1);
    expect(xToPixel(1, Number.NaN, AREA)).toBe(620);
  });
});

describe('paths', () => {
  const curve = [
    { n: 0, probability: 0 },
    { n: 500, probability: 0.5 },
    { n: 1000, probability: 0.75 },
  ];

  it('draws the line through every sample', () => {
    expect(linePath(curve, 1000, AREA)).toBe('M40 210 L330 110 L620 60');
    expect(linePath([], 1000, AREA)).toBe('');
  });

  it('closes the area down to the x axis', () => {
    expect(areaPath(curve, 1000, AREA)).toBe('M40 210 L330 110 L620 60 L620 210 L40 210 Z');
    expect(areaPath([], 1000, AREA)).toBe('');
  });

  it('rounds coordinates to two decimals', () => {
    expect(linePath([{ n: 1, probability: 1 / 3 }], 3, AREA)).toBe('M233.33 143.33');
  });
});

describe('axis ticks', () => {
  it('picks whole, round steps', () => {
    expect(niceStep(2839, 5)).toBe(1000);
    expect(niceStep(18_861, 5)).toBe(5000);
    expect(niceStep(1100, 5)).toBe(250);
    expect(niceStep(60, 5)).toBe(20);
    expect(niceStep(3, 5)).toBe(1);
    expect(niceStep(12, 5)).toBe(3); // 2.5 rounds up to a whole encounter
  });

  it('lists ticks from zero without overshooting the range', () => {
    expect(countTicks(2839, 5)).toEqual([0, 1000, 2000]);
    expect(countTicks(18_861, 5)).toEqual([0, 5000, 10_000, 15_000]);
    expect(countTicks(4, 5)).toEqual([0, 1, 2, 3, 4]);
    expect(countTicks(0)).toEqual([0, 1]);
  });

  it('asks for more ticks on wider plots, within 2–8', () => {
    expect(tickTarget(120)).toBe(2);
    expect(tickTarget(560)).toBe(5);
    expect(tickTarget(4000)).toBe(8);
  });

  it('abbreviates long counts only', () => {
    expect(formatAxisCount(950, formatCount)).toBe('950');
    expect(formatAxisCount(12_500, formatCount)).toBe('12,500');
    expect(formatAxisCount(120_000, formatCount)).toBe('120k');
    expect(formatAxisCount(1_500_000, formatCount)).toBe('1.5M');
    expect(formatAxisCount(2_000_000, formatCount)).toBe('2M');
  });
});

describe('keyboard scrubbing', () => {
  it('steps by 1 % of the range, 10 % with Shift or the Page keys', () => {
    expect(scrubStep(2839)).toBe(28);
    expect(scrubStep(2839, true)).toBe(284);
    expect(scrubStep(40)).toBe(1);

    expect(scrubTo(1000, 'ArrowRight', false, 2839)).toBe(1028);
    expect(scrubTo(1000, 'ArrowLeft', true, 2839)).toBe(716);
    expect(scrubTo(1000, 'PageUp', false, 2839)).toBe(1284);
    expect(scrubTo(1000, 'PageDown', false, 2839)).toBe(716);
  });

  it('clamps to the range and jumps with Home / End', () => {
    expect(scrubTo(2830, 'ArrowRight', false, 2839)).toBe(2839);
    expect(scrubTo(10, 'ArrowLeft', false, 2839)).toBe(0);
    expect(scrubTo(1000, 'Home', false, 2839)).toBe(0);
    expect(scrubTo(1000, 'End', false, 2839)).toBe(2839);
  });

  it('starts from the origin when nothing is shown yet and ignores other keys', () => {
    expect(scrubTo(null, 'ArrowRight', false, 2839, 500)).toBe(528);
    expect(scrubTo(null, 'ArrowLeft', false, 2839)).toBe(0);
    expect(scrubTo(1000, 'Enter', false, 2839)).toBeNull();
    expect(scrubTo(1000, 'a', false, 2839)).toBeNull();
  });
});

describe('label placement', () => {
  it('keeps the tooltip inside the container', () => {
    expect(tooltipLeft(320, 160, 640)).toBe(240);
    expect(tooltipLeft(20, 160, 640)).toBe(6);
    expect(tooltipLeft(630, 160, 640)).toBe(474);
    // A container narrower than the tooltip pins it to the left padding.
    expect(tooltipLeft(50, 160, 100)).toBe(6);
  });

  it('puts the tooltip below high points and above low ones', () => {
    expect(tooltipTop(30, 60, AREA)).toBe(44);
    expect(tooltipTop(180, 60, AREA)).toBe(106);
    // No room above either: pinned to the top edge.
    expect(tooltipTop(120, 400, AREA)).toBe(0);
  });

  it('drops labels that would overlap their left neighbour', () => {
    expect(visibleLabels([100, 300, 500], 80)).toEqual([true, true, true]);
    expect(visibleLabels([100, 150, 260], 80)).toEqual([true, false, true]);
    // Order of the input does not matter; the leftmost label wins.
    expect(visibleLabels([150, 100], 80)).toEqual([false, true]);
    expect(visibleLabels([Number.NaN, 100], 80)).toEqual([false, true]);
  });

  it('anchors edge labels so they stay inside the plot', () => {
    expect(labelAnchor(60, 80, AREA)).toBe('start');
    expect(labelAnchor(330, 80, AREA)).toBe('middle');
    expect(labelAnchor(610, 80, AREA)).toBe('end');
  });
});
