/**
 * Display formatting shared by every view. All functions are pure and never
 * throw: unusable input (NaN, Infinity, invalid dates) renders as an em dash.
 */

/** Placeholder for values that cannot be shown. */
export const EMPTY_VALUE = '—';

const LOCALE = 'en-US';
const integerFormat = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const oneDecimalFormat = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** Encounter counts and other integers with thousands separators: `12345` → `12,345`. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return EMPTY_VALUE;
  return integerFormat.format(Math.round(value));
}

/** Signed delta with a real minus sign: `5` → `+5`, `-3` → `−3`, `0` → `0`. */
export function formatSigned(value: number): string {
  if (!Number.isFinite(value)) return EMPTY_VALUE;
  const rounded = Math.round(value);
  if (rounded === 0) return '0';
  return `${rounded > 0 ? '+' : '−'}${integerFormat.format(Math.abs(rounded))}`;
}

/**
 * The denominator of "1 in N" for a probability: whole when N is (nearly) an
 * integer or large, one decimal otherwise — `4,096`, `512.4`, `1,365.3`.
 */
export function formatOddsDenominator(probability: number): string {
  if (!Number.isFinite(probability) || probability <= 0) return EMPTY_VALUE;
  if (probability >= 1) return '1';
  const denominator = 1 / probability;
  const nearest = Math.round(denominator);
  // Tolerate float noise from 1 − (1 − 1/D)^rolls style maths, and drop decimals once they stop mattering.
  if (Math.abs(denominator - nearest) < 0.05 || denominator >= 100_000) {
    return integerFormat.format(nearest);
  }
  return oneDecimalFormat.format(denominator);
}

/** A per-encounter probability (0–1) as odds: `1 / 4096` → `1 in 4,096`, `0.00195…` → `1 in 512.4`. */
export function formatOdds(probability: number): string {
  const denominator = formatOddsDenominator(probability);
  return denominator === EMPTY_VALUE ? EMPTY_VALUE : `1 in ${denominator}`;
}

function trimFixed(value: number, decimals: number): string {
  return value.toFixed(decimals);
}

/**
 * A probability (0–1) as a percentage with precision that adapts to magnitude:
 * `0.0002` → `0.02 %`, `0.034` → `3.4 %`, `0.63` → `63 %`. Values very close to
 * 0 or 1 keep enough digits not to read as impossible / certain
 * (`<0.01 %`, `99.7 %`, `>99.99 %`).
 */
export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return EMPTY_VALUE;
  const percent = Math.min(Math.max(fraction, 0), 1) * 100;

  if (percent === 0) return '0 %';
  if (percent === 100) return '100 %';
  if (percent < 0.01) return '<0.01 %';
  if (percent > 99.99) return '>99.99 %';
  if (percent < 0.995) return `${trimFixed(percent, 2)} %`;
  if (percent < 9.95) return `${trimFixed(percent, 1)} %`;
  if (percent < 99.5) return `${trimFixed(percent, 0)} %`;
  if (percent < 99.95) return `${trimFixed(percent, 1)} %`;
  return `${trimFixed(percent, 2)} %`;
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

/**
 * A time span in its two most significant units: `45s`, `12m 05s`, `2h 07m`, `3d 4h`.
 * Negative and unusable input formats as `0s`.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const totalSeconds = Math.floor(ms / SECOND);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${pad2(minutes)}m`;
  if (minutes > 0) return `${minutes}m ${pad2(seconds)}s`;
  return `${seconds}s`;
}

type DateInput = string | number | Date;

function toTime(input: DateInput): number {
  const time = input instanceof Date ? input.getTime() : new Date(input).getTime();
  return Number.isFinite(time) ? time : Number.NaN;
}

const relativeFormat = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'long' });

/**
 * How long ago (or how far ahead) a moment is: `just now`, `3 minutes ago`,
 * `yesterday`, `in 2 hours`, `4 months ago`. `now` is injectable for tests.
 */
export function formatRelativeTime(input: DateInput, now: DateInput = Date.now()): string {
  const time = toTime(input);
  const reference = toTime(now);
  if (Number.isNaN(time) || Number.isNaN(reference)) return EMPTY_VALUE;

  const diff = time - reference;
  const magnitude = Math.abs(diff);
  if (magnitude < 45 * SECOND) return 'just now';

  const steps: [limit: number, size: number, unit: Intl.RelativeTimeFormatUnit][] = [
    [HOUR, MINUTE, 'minute'],
    [DAY, HOUR, 'hour'],
    [30 * DAY, DAY, 'day'],
    [365 * DAY, 30 * DAY, 'month'],
    [Number.POSITIVE_INFINITY, 365 * DAY, 'year'],
  ];
  for (const [limit, size, unit] of steps) {
    if (magnitude < limit) {
      // Round toward the smaller magnitude so "59.6 min" never claims a full hour early.
      const amount = Math.max(1, Math.floor(magnitude / size));
      return relativeFormat.format(diff < 0 ? -amount : amount, unit);
    }
  }
  return EMPTY_VALUE;
}

export interface FormatDateTimeOptions {
  /** BCP 47 locale; defaults to the system locale. */
  locale?: string;
  /** Include the time of day (default true). */
  time?: boolean;
  /** Include seconds in the time (default false). */
  seconds?: boolean;
}

/** An absolute date and time in the user's locale, e.g. `Oct 13, 2026, 6:04 PM`. */
export function formatDateTime(input: DateInput, options: FormatDateTimeOptions = {}): string {
  const time = toTime(input);
  if (Number.isNaN(time)) return EMPTY_VALUE;
  const { locale, time: withTime = true, seconds = false } = options;
  const format = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    ...(withTime ? { timeStyle: seconds ? 'medium' : 'short' } : {}),
  });
  return format.format(time);
}

/**
 * Turns a PokeAPI-style slug into a display label: `self-destruct` → `Self Destruct`,
 * `vulpix-alola` → `Vulpix Alola`, `item_drop` → `Item Drop`.
 */
export function titleCase(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/** Clamps `value` into `[min, max]`; NaN becomes `min`. */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}
