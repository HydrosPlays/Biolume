import { describe, expect, it } from 'vitest';
import {
  clamp,
  EMPTY_VALUE,
  formatCount,
  formatDateTime,
  formatDuration,
  formatOdds,
  formatOddsDenominator,
  formatPercent,
  formatRelativeTime,
  formatSigned,
  titleCase,
} from './format';

describe('formatCount', () => {
  it('adds thousands separators', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(999)).toBe('999');
    expect(formatCount(4096)).toBe('4,096');
    expect(formatCount(12_345_678)).toBe('12,345,678');
  });

  it('rounds fractions and handles negatives', () => {
    expect(formatCount(1234.6)).toBe('1,235');
    expect(formatCount(-1500)).toBe('-1,500');
  });

  it('renders unusable numbers as a dash', () => {
    expect(formatCount(Number.NaN)).toBe(EMPTY_VALUE);
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe(EMPTY_VALUE);
  });
});

describe('formatSigned', () => {
  it('prefixes a sign', () => {
    expect(formatSigned(5)).toBe('+5');
    expect(formatSigned(-1200)).toBe('−1,200');
    expect(formatSigned(0)).toBe('0');
    expect(formatSigned(Number.NaN)).toBe(EMPTY_VALUE);
  });
});

describe('formatOdds', () => {
  it('prints whole denominators for exact odds', () => {
    expect(formatOdds(1 / 4096)).toBe('1 in 4,096');
    expect(formatOdds(1 / 8192)).toBe('1 in 8,192');
    expect(formatOdds(1 / 512)).toBe('1 in 512');
    expect(formatOdds(1)).toBe('1 in 1');
  });

  it('prints one decimal when the denominator is not whole', () => {
    expect(formatOdds(1 / 512.44)).toBe('1 in 512.4');
    expect(formatOdds(3 / 4096)).toBe('1 in 1,365.3');
    // Shiny Charm in SV: three rolls at 1/4096.
    expect(formatOdds(1 - (1 - 1 / 4096) ** 3)).toBe('1 in 1,365.7');
  });

  it('absorbs floating-point noise around whole denominators', () => {
    expect(formatOdds(1 / (4096 + 1e-9))).toBe('1 in 4,096');
    expect(formatOdds(0.1 + 0.2 - 0.2)).toBe('1 in 10');
  });

  it('drops decimals for very long odds', () => {
    expect(formatOdds(1 / 1_234_567.8)).toBe('1 in 1,234,568');
  });

  it('renders impossible and unusable probabilities as a dash', () => {
    expect(formatOdds(0)).toBe(EMPTY_VALUE);
    expect(formatOdds(-0.5)).toBe(EMPTY_VALUE);
    expect(formatOdds(Number.NaN)).toBe(EMPTY_VALUE);
    expect(formatOddsDenominator(0)).toBe(EMPTY_VALUE);
  });

  it('caps certain events at 1 in 1', () => {
    expect(formatOdds(1.7)).toBe('1 in 1');
    expect(formatOddsDenominator(1 / 4096)).toBe('4,096');
  });
});

describe('formatPercent', () => {
  it('adapts precision to magnitude', () => {
    expect(formatPercent(0.0002)).toBe('0.02 %');
    expect(formatPercent(0.034)).toBe('3.4 %');
    expect(formatPercent(0.63)).toBe('63 %');
    expect(formatPercent(0.5)).toBe('50 %');
    expect(formatPercent(0.0999)).toBe('10 %');
    expect(formatPercent(0.00244)).toBe('0.24 %');
  });

  it('never rounds a near-certainty up to 100 % or a sliver down to 0 %', () => {
    expect(formatPercent(0.997)).toBe('99.7 %');
    expect(formatPercent(0.9996)).toBe('99.96 %');
    expect(formatPercent(0.999_999)).toBe('>99.99 %');
    expect(formatPercent(0.000_000_1)).toBe('<0.01 %');
  });

  it('handles the bounds and bad input', () => {
    expect(formatPercent(0)).toBe('0 %');
    expect(formatPercent(1)).toBe('100 %');
    expect(formatPercent(1.4)).toBe('100 %');
    expect(formatPercent(-0.2)).toBe('0 %');
    expect(formatPercent(Number.NaN)).toBe(EMPTY_VALUE);
  });
});

describe('formatDuration', () => {
  it('uses the two most significant units', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(12 * 60_000 + 5_000)).toBe('12m 05s');
    expect(formatDuration(2 * 3_600_000 + 7 * 60_000 + 59_000)).toBe('2h 07m');
    expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe('3d 4h');
  });

  it('floors partial seconds and guards bad input', () => {
    expect(formatDuration(999)).toBe('0s');
    expect(formatDuration(-5000)).toBe('0s');
    expect(formatDuration(Number.NaN)).toBe('0s');
  });
});

describe('formatRelativeTime', () => {
  const now = new Date('2026-10-13T12:00:00.000Z');
  const ago = (ms: number): Date => new Date(now.getTime() - ms);

  it('describes the past', () => {
    expect(formatRelativeTime(ago(10_000), now)).toBe('just now');
    expect(formatRelativeTime(ago(3 * 60_000), now)).toBe('3 minutes ago');
    expect(formatRelativeTime(ago(59 * 60_000 + 40_000), now)).toBe('59 minutes ago');
    expect(formatRelativeTime(ago(2 * 3_600_000), now)).toBe('2 hours ago');
    expect(formatRelativeTime(ago(26 * 3_600_000), now)).toBe('yesterday');
    expect(formatRelativeTime(ago(5 * 86_400_000), now)).toBe('5 days ago');
    expect(formatRelativeTime(ago(70 * 86_400_000), now)).toBe('2 months ago');
    expect(formatRelativeTime(ago(800 * 86_400_000), now)).toBe('2 years ago');
  });

  it('describes the future', () => {
    expect(formatRelativeTime(new Date(now.getTime() + 2 * 3_600_000), now)).toBe('in 2 hours');
  });

  it('accepts ISO strings and timestamps, and rejects garbage', () => {
    expect(formatRelativeTime('2026-10-13T11:55:00.000Z', now)).toBe('5 minutes ago');
    expect(formatRelativeTime(now.getTime() - 120_000, now.getTime())).toBe('2 minutes ago');
    expect(formatRelativeTime('not a date', now)).toBe(EMPTY_VALUE);
  });
});

describe('formatDateTime', () => {
  it('formats a date with and without the time', () => {
    const iso = '2026-10-13T18:04:11.000Z';
    const full = formatDateTime(iso, { locale: 'en-US' });
    expect(full).toContain('2026');
    expect(full).toMatch(/\d{1,2}:\d{2}/);
    const dateOnly = formatDateTime(iso, { locale: 'en-US', time: false });
    expect(dateOnly).toContain('2026');
    expect(dateOnly).not.toMatch(/\d{1,2}:\d{2}/);
    expect(formatDateTime(iso, { locale: 'en-US', seconds: true })).toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });

  it('renders invalid dates as a dash', () => {
    expect(formatDateTime('nope')).toBe(EMPTY_VALUE);
    expect(formatDateTime(Number.NaN)).toBe(EMPTY_VALUE);
  });
});

describe('titleCase', () => {
  it('turns slugs into labels', () => {
    expect(titleCase('self-destruct')).toBe('Self Destruct');
    expect(titleCase('vulpix-alola')).toBe('Vulpix Alola');
    expect(titleCase('item_drop')).toBe('Item Drop');
    expect(titleCase('FIRE')).toBe('Fire');
    expect(titleCase('double--edge ')).toBe('Double Edge');
    expect(titleCase('')).toBe('');
  });
});

describe('clamp', () => {
  it('limits a value to a range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(Number.NaN, 2, 10)).toBe(2);
  });
});
