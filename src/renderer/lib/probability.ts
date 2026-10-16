/**
 * Probability helpers behind the odds calculator and the counter's luck meter.
 *
 * Everything here is pure and total: NaN, negative or out-of-range arguments
 * produce a documented safe value instead of throwing, so the functions can be
 * fed straight from half-typed form fields.
 *
 * Shiny odds are tiny (1/8192) and counts are large (hundreds of thousands), so
 * the naive `1 - Math.pow(1 - p, n)` loses most of its digits. The geometric
 * helpers work in log space (`log1p` / `expm1`) and the binomial helpers use a
 * saddle-point expansion, which stays accurate without ever forming a factorial.
 */

// ───────────────────────────── Types & constants ─────────────────────────────

/** The cumulative probabilities the UI marks on a curve: 25 / 50 / 75 / 90 / 95 / 99 %. */
export const MILESTONE_PROBABILITIES: readonly number[] = [0.25, 0.5, 0.75, 0.9, 0.95, 0.99];

export interface Milestone {
  /** Target cumulative probability, 0–1. */
  probability: number;
  /** Smallest number of encounters reaching it; `Infinity` when unreachable. */
  encounters: number;
}

export interface CurvePoint {
  /** Encounter count (a whole number). */
  n: number;
  /** Cumulative probability of at least one shiny within `n` encounters, 0–1. */
  probability: number;
}

export interface CurveOptions {
  /** Last encounter count on the curve. Default: the 99 % quantile, capped at {@link CURVE_MAX_N_CAP}. */
  maxN?: number;
  /** Number of samples, 2–{@link CURVE_MAX_POINTS}. Default {@link CURVE_DEFAULT_POINTS}. */
  points?: number;
}

/** `unknown` = nothing to judge yet (no encounters, or odds of zero). */
export type LuckVerdict =
  'very-lucky' | 'lucky' | 'average' | 'unlucky' | 'very-unlucky' | 'unknown';

export interface LuckResult {
  /** Probability of at least one shiny within `n` encounters, 0–1. */
  cumulative: number;
  /**
   * Share of hunters (0–100) who would already have found their shiny by
   * encounter `n`. Still hunting at `n` means being unluckier than this share;
   * finding it exactly at `n` means being luckier than `100 − percentile`.
   */
  percentile: number;
  /** `n` relative to the expected count `1 / p` — 1 is exactly "at odds", 2 is "twice over odds". */
  oddsRatio: number;
  verdict: LuckVerdict;
}

/** Upper bounds (exclusive) of each verdict on the cumulative probability. */
export const LUCK_THRESHOLDS = {
  veryLucky: 0.1,
  lucky: 0.4,
  /** "At odds" (n = 1/p) sits at ≈ 0.632, just inside `average`. */
  average: 0.65,
  unlucky: 0.9,
} as const;

export const LUCK_VERDICT_LABELS: Record<LuckVerdict, string> = {
  'very-lucky': 'Very lucky',
  lucky: 'Lucky',
  average: 'Average',
  unlucky: 'Unlucky',
  'very-unlucky': 'Very unlucky',
  unknown: '—',
};

export const CURVE_DEFAULT_POINTS = 120;
export const CURVE_MAX_POINTS = 2_000;
/** Cap on the default x-range of a curve (odds worse than ≈ 1 in 2 million hit it). */
export const CURVE_MAX_N_CAP = 10_000_000;
/** x-range used when no finite quantile exists (odds of zero). */
export const CURVE_FALLBACK_MAX_N = 1_000;
/** Hard ceiling on an explicitly requested `maxN`. */
const CURVE_ABSOLUTE_MAX_N = 1e12;

/** Upper bound on callback invocations when a varying chain is given as a function. */
export const MAX_VARYING_STEPS = 5_000_000;

/** Below this log-survival the cumulative probability is exactly 1 in double precision. */
const LOG_SURVIVAL_FLOOR = -745;
/** Terms smaller than this fraction of the running sum no longer change it. */
const NEGLIGIBLE = 1e-17;
/** Guard against pathological inputs in the binomial tail sums (≈ n beyond 10^13). */
const MAX_TAIL_TERMS = 10_000_000;

// ───────────────────────────── Sanitising ─────────────────────────────

/** NaN / negative → 0, above 1 → 1. */
function clampProbability(p: number): number {
  if (!(p > 0)) return 0;
  return p >= 1 ? 1 : p;
}

/** NaN / negative → 0. `Infinity` is kept (it means "forever"). */
function clampCount(n: number): number {
  return n > 0 ? n : 0;
}

/** Whole, finite, non-negative count — or `null` when `n` is not one. */
function toTrials(n: number): number | null {
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function clampInteger(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** `1 − e^logSurvival` for a log-survival ≤ 0 (never the `-0` a bare `-expm1(0)` yields). */
function fromLogSurvival(logSurvival: number): number {
  return logSurvival < 0 ? -Math.expm1(logSurvival) : 0;
}

// ───────────────────────────── Geometric (first shiny) ─────────────────────────────

/**
 * Probability of at least one success in `n` independent tries: `1 − (1 − p)^n`.
 * `n` may be fractional (the formula is continuous) or `Infinity`.
 */
export function cumulativeProbability(p: number, n: number): number {
  const probability = clampProbability(p);
  const count = clampCount(n);
  if (probability === 0 || count === 0) return 0;
  if (probability === 1 || count === Infinity) return 1;
  // Exact for the commonest case, where the log round-trip could cost an ulp.
  if (count === 1) return probability;
  return fromLogSurvival(count * Math.log1p(-probability));
}

/**
 * Smallest whole number of encounters whose cumulative probability reaches `q`.
 * `Infinity` when it never does (`p ≤ 0`, an invalid `q`, or `q ≥ 1` with `p < 1`).
 */
export function encountersForProbability(p: number, q: number): number {
  const probability = clampProbability(p);
  if (Number.isNaN(q) || probability === 0) return Infinity;
  if (q <= 0) return 0;
  if (probability === 1) return 1;
  if (q >= 1) return Infinity;

  let n = Math.max(1, Math.ceil(Math.log1p(-q) / Math.log1p(-probability)));
  // The division can land one off the true boundary; settle it against the same
  // formula callers will use. Beyond 2^53 neighbouring integers are not distinct.
  if (n < Number.MAX_SAFE_INTEGER) {
    for (let i = 0; i < 3 && n > 1 && cumulativeProbability(probability, n - 1) >= q; i++) n--;
    for (let i = 0; i < 3 && cumulativeProbability(probability, n) < q; i++) n++;
  }
  return n;
}

/** Mean number of encounters until the first success: `1 / p` (`Infinity` when `p ≤ 0`). */
export function expectedEncounters(p: number): number {
  const probability = clampProbability(p);
  return probability === 0 ? Infinity : 1 / probability;
}

/** Encounters needed to reach each of `probabilities` (default {@link MILESTONE_PROBABILITIES}). */
export function geometricQuantiles(
  p: number,
  probabilities: readonly number[] = MILESTONE_PROBABILITIES,
): Milestone[] {
  return probabilities.map((probability) => ({
    probability,
    encounters: encountersForProbability(p, probability),
  }));
}

/** The 25 / 50 / 75 / 90 / 95 / 99 % marks for odds `p`. */
export function milestones(p: number): Milestone[] {
  return geometricQuantiles(p, MILESTONE_PROBABILITIES);
}

/**
 * The verdict for a cumulative probability (0–1) of having found the shiny by
 * now. Use it directly for chains, whose cumulative comes from
 * {@link cumulativeVarying}; `unknown` for 0 or an invalid value.
 */
export function luckVerdict(cumulative: number): LuckVerdict {
  if (!(cumulative > 0)) return 'unknown';
  if (cumulative < LUCK_THRESHOLDS.veryLucky) return 'very-lucky';
  if (cumulative < LUCK_THRESHOLDS.lucky) return 'lucky';
  if (cumulative < LUCK_THRESHOLDS.average) return 'average';
  if (cumulative < LUCK_THRESHOLDS.unlucky) return 'unlucky';
  return 'very-unlucky';
}

/**
 * How a hunt at `n` encounters compares with every other hunter at odds `p`.
 * The verdict reads as "finding the shiny now would be …": very lucky early on,
 * very unlucky deep past the odds.
 */
export function luck(p: number, n: number): LuckResult {
  const probability = clampProbability(p);
  const count = clampCount(n);
  if (probability === 0 || count === 0) {
    return { cumulative: 0, percentile: 0, oddsRatio: 0, verdict: 'unknown' };
  }
  const cumulative = cumulativeProbability(probability, count);
  return {
    cumulative,
    percentile: cumulative * 100,
    oddsRatio: count * probability,
    verdict: luckVerdict(cumulative),
  };
}

// ───────────────────────────── Curves ─────────────────────────────

/** `points` whole, strictly increasing x values from 0 to `maxN` (every integer when they fit). */
function sampleCounts(maxN: number, points: number): number[] {
  if (maxN + 1 <= points) return Array.from({ length: maxN + 1 }, (_, i) => i);
  const counts: number[] = [];
  let previous = -1;
  for (let i = 0; i < points; i++) {
    const n = i === points - 1 ? maxN : Math.round((i * maxN) / (points - 1));
    if (n > previous) counts.push(n);
    previous = n;
  }
  return counts;
}

function resolveCurveRange(options: CurveOptions | undefined, defaultMaxN: number): number[] {
  const points = clampInteger(options?.points, 2, CURVE_MAX_POINTS, CURVE_DEFAULT_POINTS);
  const fallback = Number.isFinite(defaultMaxN)
    ? Math.min(Math.max(1, defaultMaxN), CURVE_MAX_N_CAP)
    : CURVE_FALLBACK_MAX_N;
  const maxN = clampInteger(options?.maxN, 1, CURVE_ABSOLUTE_MAX_N, fallback);
  return sampleCounts(maxN, points);
}

/**
 * Evenly sampled cumulative curve for constant odds `p`, starting at `n = 0`.
 * With no `maxN` it runs to the 99 % quantile.
 */
export function buildCurve(p: number, options?: CurveOptions): CurvePoint[] {
  const probability = clampProbability(p);
  const counts = resolveCurveRange(options, encountersForProbability(probability, 0.99));
  return counts.map((n) => ({ n, probability: cumulativeProbability(probability, n) }));
}

// ───────────────────────────── Varying odds (chains) ─────────────────────────────

/**
 * Per-encounter odds of a chain: element / call `i` is the chance on encounter
 * `i` (zero-based). An array shorter than the requested count repeats its last
 * element, which is how chains behave once they hit their cap.
 */
export type VaryingProbabilities = readonly number[] | ((index: number) => number);

/** Walks the chain, handing out `ln(survival)` after each encounter. Stops when `visit` returns false. */
function walkSurvival(
  probabilities: VaryingProbabilities,
  limit: number,
  visit: (encounters: number, logSurvival: number) => boolean,
): void {
  const isArray = typeof probabilities !== 'function';
  const length = isArray ? probabilities.length : Infinity;
  if (length === 0) return;
  let logSurvival = 0;
  for (let i = 0; i < limit; i++) {
    const raw = isArray ? probabilities[Math.min(i, length - 1)] : probabilities(i);
    const probability = clampProbability(raw ?? 0);
    logSurvival = probability === 1 ? -Infinity : logSurvival + Math.log1p(-probability);
    if (!visit(i + 1, logSurvival)) return;
  }
}

/** Probability of an array's last element, used for the closed-form tail. */
function tailProbability(probabilities: readonly number[]): number {
  return clampProbability(probabilities[probabilities.length - 1] ?? 0);
}

/**
 * Cumulative probability after `n` encounters whose odds differ per encounter:
 * `1 − Π (1 − p_i)` for `i` in `0 … n − 1`. Invalid entries count as 0.
 * A function source is evaluated at most {@link MAX_VARYING_STEPS} times.
 */
export function cumulativeVarying(probabilities: VaryingProbabilities, n: number): number {
  const count = Math.floor(clampCount(n));
  if (count === 0) return 0;
  const isArray = typeof probabilities !== 'function';
  if (isArray && probabilities.length === 0) return 0;

  // Arrays are only walked to their end; the repeated tail has a closed form.
  const head = isArray ? Math.min(count, probabilities.length) : Math.min(count, MAX_VARYING_STEPS);
  let logSurvival = 0;
  walkSurvival(probabilities, head, (_encounters, value) => {
    logSurvival = value;
    return value > LOG_SURVIVAL_FLOOR;
  });
  if (isArray && count > head && logSurvival > LOG_SURVIVAL_FLOOR) {
    const tail = tailProbability(probabilities);
    if (tail === 1) return 1;
    if (tail > 0) logSurvival += (count - head) * Math.log1p(-tail);
  }
  return fromLogSurvival(logSurvival);
}

/**
 * Smallest number of encounters at which a varying chain reaches cumulative
 * probability `q`; `Infinity` when it never does (or not within
 * {@link MAX_VARYING_STEPS} calls of a function source).
 */
export function encountersForProbabilityVarying(
  probabilities: VaryingProbabilities,
  q: number,
): number {
  if (Number.isNaN(q)) return Infinity;
  if (q <= 0) return 0;
  const isArray = typeof probabilities !== 'function';
  if (isArray && probabilities.length === 0) return Infinity;

  const head = isArray ? probabilities.length : MAX_VARYING_STEPS;
  let reached = Infinity;
  let logSurvival = 0;
  walkSurvival(probabilities, head, (encounters, value) => {
    logSurvival = value;
    if (fromLogSurvival(value) >= q) {
      reached = encounters;
      return false;
    }
    return true;
  });
  if (reached !== Infinity || !isArray || q >= 1) return reached;

  const tail = tailProbability(probabilities);
  if (tail === 0) return Infinity;
  // Past the array the odds are constant, so the remaining distance is geometric.
  const extra = Math.max(1, Math.ceil((Math.log1p(-q) - logSurvival) / Math.log1p(-tail)));
  let n = head + extra;
  if (n < Number.MAX_SAFE_INTEGER) {
    for (let i = 0; i < 3 && n > head + 1 && cumulativeVarying(probabilities, n - 1) >= q; i++) n--;
    for (let i = 0; i < 3 && cumulativeVarying(probabilities, n) < q; i++) n++;
  }
  return n;
}

/**
 * Sampled cumulative curve for a chain with per-encounter odds, computed in a
 * single pass. With no `maxN` it runs to the chain's 99 % quantile.
 */
export function buildVaryingCurve(
  probabilities: VaryingProbabilities,
  options?: CurveOptions,
): CurvePoint[] {
  const counts = resolveCurveRange(options, encountersForProbabilityVarying(probabilities, 0.99));
  const isArray = typeof probabilities !== 'function';
  const walkLimit = isArray ? probabilities.length : MAX_VARYING_STEPS;
  const tail = isArray && probabilities.length > 0 ? tailProbability(probabilities) : 0;
  const logTailMiss = tail === 1 ? -Infinity : Math.log1p(-tail);

  const curve: CurvePoint[] = [];
  let next = 0;
  let walked = 0;
  let logSurvival = 0;
  const emitUpTo = (encounters: number, value: number): void => {
    for (let n = counts[next]; n !== undefined && n <= encounters; n = counts[++next]) {
      // Sample points between two walked encounters only occur for n = 0.
      curve.push({ n, probability: n === 0 ? 0 : fromLogSurvival(value) });
    }
  };

  emitUpTo(0, 0);
  const last = counts[counts.length - 1] ?? 0;
  walkSurvival(probabilities, Math.min(last, walkLimit), (encounters, value) => {
    walked = encounters;
    logSurvival = value;
    emitUpTo(encounters, value);
    return true;
  });
  // Whatever lies past the walked part uses the repeated tail odds (0 for a
  // function source that hit its step limit, i.e. the curve goes flat).
  for (let n = counts[next]; n !== undefined; n = counts[++next]) {
    const extra = (n - walked) * logTailMiss;
    const total = Number.isNaN(extra) ? logSurvival : logSurvival + extra;
    curve.push({ n, probability: fromLogSurvival(total) });
  }
  return curve;
}

// ───────────────────────────── Binomial (how many shinies) ─────────────────────────────

/**
 * `ln(n!) − ln(√(2πn)·(n/e)^n)`: the error of Stirling's formula. Exact values
 * for small `n`, the asymptotic series beyond (accurate to 1e-16 from n = 16).
 */
const STIRLING_ERROR: readonly number[] = [
  0, 0.08106146679532726, 0.0413406959554093, 0.02767792568499834, 0.020790672103765093,
  0.016644691189821193, 0.013876128823070748, 0.01189670994589177, 0.010411265261972096,
  0.009255462182712733, 0.00833056343336287, 0.007573675487951841, 0.00694284010720953,
  0.006408994188004207, 0.0059513701127588475, 0.005554733551962801,
];

function stirlingError(n: number): number {
  const exact = STIRLING_ERROR[n];
  if (exact !== undefined) return exact;
  const n2 = n * n;
  return (1 / 12 - (1 / 360 - (1 / 1260 - (1 / 1680 - 1 / 1188 / n2) / n2) / n2) / n2) / n;
}

/**
 * `x·ln(x / mean) + mean − x`, the deviance term of the saddle-point expansion
 * (Loader's `bd0`). Near the mean the closed form cancels — it would lose every
 * digit once `n` is astronomically large — so a series in
 * `v = (x − mean) / (x + mean)` is summed there: `ln(x / mean) = 2·atanh(v)`.
 * Far from the mean the plain logarithm is safe and, unlike `log1p` of a
 * relative difference that rounds to −1, can never turn into `−Infinity`.
 */
function deviance(x: number, mean: number): number {
  if (x === 0) return mean;
  const difference = x - mean;
  if (Math.abs(difference) < 0.1 * (x + mean)) {
    let v = difference / (x + mean);
    let sum = difference * v;
    let term = 2 * x * v;
    v *= v;
    // |v| < 0.1, so each term is at least 100× smaller than the one before.
    for (let j = 1; j < 100; j++) {
      term *= v;
      const next = sum + term / (2 * j + 1);
      if (next === sum) break;
      sum = next;
    }
    return sum;
  }
  return x * Math.log(x / mean) + mean - x;
}

/**
 * Binomial point probability for validated arguments (whole `0 ≤ k ≤ n`, `0 ≤ p ≤ 1`).
 * Saddle-point form (C. Loader, "Fast and Accurate Computation of Binomial
 * Probabilities", 2000): every term is O(1) in size, so nothing overflows or
 * cancels however large `n` gets.
 */
function binomialPmfRaw(n: number, k: number, p: number): number {
  if (p === 0) return k === 0 ? 1 : 0;
  if (p === 1) return k === n ? 1 : 0;
  if (k === 0) return Math.exp(n * Math.log1p(-p));
  if (k === n) return Math.exp(n * Math.log(p));
  const exponent =
    stirlingError(n) -
    stirlingError(k) -
    stirlingError(n - k) -
    deviance(k, n * p) -
    deviance(n - k, n * (1 - p));
  // √(n / (2π·k·(n − k))), divided step by step: the product k·(n − k) overflows
  // for n beyond ~1e154 and would silently zero the whole probability.
  const value = Math.exp(exponent) * Math.sqrt(n / k / (2 * Math.PI) / (n - k));
  // A point probability is never above 1; NaN cannot arise, but must not escape if it did.
  return value >= 0 ? Math.min(1, value) : 0;
}

/**
 * Probability of exactly `k` successes in `n` tries. `n` is floored; a `k` that
 * is not a whole number in `0 … n`, or an unusable `n`, gives 0.
 */
export function binomialPmf(n: number, k: number, p: number): number {
  const trials = toTrials(n);
  if (trials === null || !Number.isInteger(k) || k < 0 || k > trials) return 0;
  return binomialPmfRaw(trials, k, clampProbability(p));
}

/** `[P(X ≤ k), P(X > k)]` for validated arguments with `0 ≤ k < n` and `0 < p < 1`. */
function binomialTails(n: number, k: number, p: number): [lower: number, upper: number] {
  const odds = p / (1 - p);
  const mode = Math.floor((n + 1) * p);
  // Sum whichever tail does not contain the mode: its terms shrink monotonically
  // away from k, so the loop ends after ~√n terms and the sum loses no digits.
  if (k < mode) {
    let term = binomialPmfRaw(n, k, p);
    let sum = term;
    for (let i = k, guard = 0; i > 0 && term > 0 && guard < MAX_TAIL_TERMS; i--, guard++) {
      term *= i / ((n - i + 1) * odds);
      sum += term;
      if (term < sum * NEGLIGIBLE) break;
    }
    const lower = Math.min(1, sum);
    return [lower, 1 - lower];
  }
  let term = binomialPmfRaw(n, k + 1, p);
  let sum = term;
  for (let i = k + 1, guard = 0; i < n && term > 0 && guard < MAX_TAIL_TERMS; i++, guard++) {
    term *= ((n - i) * odds) / (i + 1);
    sum += term;
    if (term < sum * NEGLIGIBLE) break;
  }
  const upper = Math.min(1, sum);
  return [1 - upper, upper];
}

/**
 * Probability of at most `k` successes in `n` tries. `n` and `k` are floored;
 * an unusable `n` counts as zero tries.
 */
export function binomialCdf(n: number, k: number, p: number): number {
  if (Number.isNaN(k) || k < 0) return 0;
  const trials = toTrials(n) ?? 0;
  const successes = Math.floor(k);
  if (successes >= trials) return 1;
  const probability = clampProbability(p);
  if (probability === 0) return 1;
  if (probability === 1) return 0;
  return binomialTails(trials, successes, probability)[0];
}

/** Probability of at least `k` successes in `n` tries — `binomialAtLeast(n, 1, p)` is the cumulative curve. */
export function binomialAtLeast(n: number, k: number, p: number): number {
  if (Number.isNaN(k)) return 0;
  const trials = toTrials(n) ?? 0;
  const successes = Math.ceil(k);
  if (successes <= 0) return 1;
  if (successes > trials) return 0;
  const probability = clampProbability(p);
  if (probability === 0) return 0;
  if (probability === 1) return 1;
  return binomialTails(trials, successes - 1, probability)[1];
}

export interface BinomialPoint {
  /** Number of successes. */
  k: number;
  /** P(X = k). */
  probability: number;
  /** P(X ≤ k). */
  cumulative: number;
}

/** Entries returned by {@link binomialDistribution} when `maxK` is omitted. */
export const BINOMIAL_DEFAULT_MAX_ENTRIES = 50;
const BINOMIAL_MAX_ENTRIES = 10_000;
/** The default listing stops once this much probability mass has been covered. */
const BINOMIAL_COVERAGE = 0.9999;

/**
 * The distribution of the number of shinies in `n` encounters, from `k = 0`
 * up to `maxK`. With no `maxK` it stops once 99.99 % of the mass is listed
 * (at most {@link BINOMIAL_DEFAULT_MAX_ENTRIES} entries).
 */
export function binomialDistribution(n: number, p: number, maxK?: number): BinomialPoint[] {
  const trials = toTrials(n) ?? 0;
  const probability = clampProbability(p);
  const auto = maxK === undefined || Number.isNaN(maxK);
  const last = auto
    ? Math.min(trials, BINOMIAL_DEFAULT_MAX_ENTRIES - 1)
    : Math.min(trials, clampInteger(maxK, 0, BINOMIAL_MAX_ENTRIES - 1, 0));

  const distribution: BinomialPoint[] = [];
  let cumulative = 0;
  for (let k = 0; k <= last; k++) {
    const mass = binomialPmfRaw(trials, k, probability);
    cumulative = Math.min(1, cumulative + mass);
    distribution.push({ k, probability: mass, cumulative });
    if (auto && cumulative >= BINOMIAL_COVERAGE) break;
  }
  return distribution;
}
