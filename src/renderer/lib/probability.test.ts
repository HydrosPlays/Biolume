import { describe, expect, it, vi } from 'vitest';
import {
  BINOMIAL_DEFAULT_MAX_ENTRIES,
  CURVE_DEFAULT_POINTS,
  CURVE_FALLBACK_MAX_N,
  CURVE_MAX_N_CAP,
  CURVE_MAX_POINTS,
  LUCK_VERDICT_LABELS,
  MAX_VARYING_STEPS,
  MILESTONE_PROBABILITIES,
  binomialAtLeast,
  binomialCdf,
  binomialDistribution,
  binomialPmf,
  buildCurve,
  buildVaryingCurve,
  cumulativeProbability,
  cumulativeVarying,
  encountersForProbability,
  encountersForProbabilityVarying,
  expectedEncounters,
  geometricQuantiles,
  luck,
  luckVerdict,
  milestones,
} from './probability';

const FULL_ODDS = 1 / 4096;
const OLD_ODDS = 1 / 8192;
/** The longest odds the engine is expected to face: one roll in 65,536. */
const TINY_ODDS = 1 / 65536;

/** Relative closeness, for values spanning many orders of magnitude. */
function expectRelative(actual: number, expected: number, tolerance = 1e-12): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.abs(expected) * tolerance);
}

/** ln C(n, k) by direct summation — slow but independent of the implementation under test. */
function logChoose(n: number, k: number): number {
  let total = 0;
  for (let i = 1; i <= k; i++) total += Math.log((n - k + i) / i);
  return total;
}

describe('cumulativeProbability', () => {
  // Reference values computed with exact rational arithmetic (BigInt).
  it('matches exact values', () => {
    expect(cumulativeProbability(0.5, 1)).toBe(0.5);
    expect(cumulativeProbability(0.5, 2)).toBe(0.75);
    expectRelative(cumulativeProbability(FULL_ODDS, 1), 0.000244140625);
    expectRelative(cumulativeProbability(FULL_ODDS, 100), 0.024121358687114403);
    expectRelative(cumulativeProbability(FULL_ODDS, 4096), 0.6321654705556539);
    expectRelative(cumulativeProbability(OLD_ODDS, 8192), 0.6321430135498485);
    expectRelative(cumulativeProbability(FULL_ODDS, 18861), 0.990001283270095);
  });

  it('keeps full precision for tiny probabilities', () => {
    // 1 - Math.pow(1 - 1e-12, 1) would be off by 9e-5 relative.
    expectRelative(cumulativeProbability(1e-12, 1), 1e-12, 1e-13);
    expectRelative(cumulativeProbability(1e-12, 1000), 1e-9 * (1 - 499.5e-12), 1e-13);
    expectRelative(cumulativeProbability(1e-300, 1e10), 1e-290, 1e-12);
  });

  it('stays exact for odds as long as 1 in 65,536 over ten million encounters', () => {
    // Reference values from exact fixed-point (BigInt) arithmetic.
    expect(cumulativeProbability(TINY_ODDS, 1)).toBe(1 / 65536);
    expectRelative(cumulativeProbability(TINY_ODDS, 100), 0.0015247269688252075, 1e-14);
    expectRelative(cumulativeProbability(TINY_ODDS, 65_536), 0.632123365543799, 1e-14);
    expectRelative(cumulativeProbability(TINY_ODDS, 1_000_000), 0.9999997638752285, 1e-15);
    // The miss chance at ten million is 5.4e-67: indistinguishable from certainty, never above it.
    expect(cumulativeProbability(TINY_ODDS, 10_000_000)).toBe(1);
    // The naive 1 − (1 − p)^n is already off in the 8th digit here.
    expectRelative(cumulativeProbability(2 ** -32, 10_000_000), 0.00232559803378308, 1e-14);
    for (const n of [1, 10, 1e3, 1e5, 1e7]) {
      const value = cumulativeProbability(TINY_ODDS, n);
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(n / 65536);
    }
  });

  it('saturates for huge counts', () => {
    expect(cumulativeProbability(OLD_ODDS, 1e9)).toBe(1);
    expect(cumulativeProbability(OLD_ODDS, Infinity)).toBe(1);
    expect(cumulativeProbability(OLD_ODDS, 500_000)).toBeLessThanOrEqual(1);
    expect(cumulativeProbability(OLD_ODDS, 500_000)).toBeGreaterThan(0.999999);
  });

  it('handles the edges p = 0, p = 1 and n = 0', () => {
    expect(cumulativeProbability(0, 1000)).toBe(0);
    expect(cumulativeProbability(0, Infinity)).toBe(0);
    expect(cumulativeProbability(1, 1)).toBe(1);
    expect(cumulativeProbability(1, 0)).toBe(0);
    expect(cumulativeProbability(FULL_ODDS, 0)).toBe(0);
  });

  it('returns safe values for invalid input', () => {
    expect(cumulativeProbability(NaN, 10)).toBe(0);
    expect(cumulativeProbability(-0.5, 10)).toBe(0);
    expect(cumulativeProbability(0.5, NaN)).toBe(0);
    expect(cumulativeProbability(0.5, -3)).toBe(0);
    expect(cumulativeProbability(7, 3)).toBe(1);
  });

  it('is monotonic in n', () => {
    let previous = 0;
    for (let n = 1; n <= 30_000; n += 137) {
      const value = cumulativeProbability(FULL_ODDS, n);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });
});

describe('encountersForProbability', () => {
  it('matches known quantiles', () => {
    expect(encountersForProbability(FULL_ODDS, 0.25)).toBe(1179);
    expect(encountersForProbability(FULL_ODDS, 0.5)).toBe(2839);
    expect(encountersForProbability(FULL_ODDS, 0.75)).toBe(5678);
    expect(encountersForProbability(FULL_ODDS, 0.9)).toBe(9431);
    expect(encountersForProbability(FULL_ODDS, 0.95)).toBe(12270);
    expect(encountersForProbability(FULL_ODDS, 0.99)).toBe(18861);
    expect(encountersForProbability(OLD_ODDS, 0.5)).toBe(5678);
    expect(encountersForProbability(0.5, 0.5)).toBe(1);
    expect(encountersForProbability(0.5, 0.75)).toBe(2);
    expect(encountersForProbability(0.5, 0.76)).toBe(3);
  });

  it('is the inverse of cumulativeProbability', () => {
    const probabilities = [
      1 / 8192,
      1 / 4096,
      1 / 1365.67,
      1 / 512.44,
      1 / 100,
      0.03,
      0.5,
      0.999,
      1e-9,
    ];
    const targets = [1e-6, 0.01, 0.25, 0.5, 0.632, 0.75, 0.9, 0.95, 0.99, 0.999999];
    for (const p of probabilities) {
      for (const q of targets) {
        const n = encountersForProbability(p, q);
        expect(Number.isInteger(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(1);
        expect(cumulativeProbability(p, n)).toBeGreaterThanOrEqual(q);
        expect(cumulativeProbability(p, n - 1)).toBeLessThan(q);
      }
    }
  });

  it('has no off-by-one at 1 in 65,536', () => {
    // Each n was confirmed with exact arithmetic: cumulative(n) ≥ q > cumulative(n − 1).
    expect(encountersForProbability(TINY_ODDS, 0.25)).toBe(18_854);
    expect(encountersForProbability(TINY_ODDS, 0.5)).toBe(45_426);
    expect(encountersForProbability(TINY_ODDS, 0.75)).toBe(90_852);
    expect(encountersForProbability(TINY_ODDS, 0.9)).toBe(150_902);
    expect(encountersForProbability(TINY_ODDS, 0.95)).toBe(196_327);
    expect(encountersForProbability(TINY_ODDS, 0.99)).toBe(301_803);
  });

  it('is an exact inverse at powers of one half', () => {
    // 1 − 0.5^k is representable, so the boundary is hit exactly: no slack either way.
    for (let k = 1; k <= 52; k++) {
      expect(encountersForProbability(0.5, 1 - 2 ** -k)).toBe(k);
    }
    expect(encountersForProbability(0.5, 1 - 2 ** -20 + 2 ** -40)).toBe(21);
  });

  it('handles unreachable and trivial targets', () => {
    expect(encountersForProbability(0, 0.5)).toBe(Infinity);
    expect(encountersForProbability(-1, 0.5)).toBe(Infinity);
    expect(encountersForProbability(NaN, 0.5)).toBe(Infinity);
    expect(encountersForProbability(FULL_ODDS, NaN)).toBe(Infinity);
    expect(encountersForProbability(FULL_ODDS, 1)).toBe(Infinity);
    expect(encountersForProbability(FULL_ODDS, 1.5)).toBe(Infinity);
    expect(encountersForProbability(FULL_ODDS, 0)).toBe(0);
    expect(encountersForProbability(FULL_ODDS, -0.2)).toBe(0);
    expect(encountersForProbability(1, 0.5)).toBe(1);
    expect(encountersForProbability(1, 1)).toBe(1);
  });

  it('stays finite for astronomically small odds', () => {
    const n = encountersForProbability(1e-300, 0.5);
    expect(Number.isFinite(n)).toBe(true);
    expectRelative(n, Math.LN2 * 1e300, 1e-9);
  });
});

describe('expectedEncounters', () => {
  it('is 1 / p', () => {
    expect(expectedEncounters(FULL_ODDS)).toBe(4096);
    expect(expectedEncounters(0.25)).toBe(4);
    expect(expectedEncounters(1)).toBe(1);
  });

  it('handles the edges', () => {
    expect(expectedEncounters(0)).toBe(Infinity);
    expect(expectedEncounters(-1)).toBe(Infinity);
    expect(expectedEncounters(NaN)).toBe(Infinity);
    expect(expectedEncounters(3)).toBe(1);
  });
});

describe('binomialPmf', () => {
  it('matches exact values', () => {
    expectRelative(binomialPmf(4, 2, 0.5), 0.375);
    expectRelative(binomialPmf(10, 3, 0.3), 0.266827932);
    expectRelative(binomialPmf(100, 50, 0.5), 0.07958923738717877);
    expectRelative(binomialPmf(2000, 1000, 0.5), 0.01783901114585432);
    expectRelative(binomialPmf(1000, 2, FULL_ODDS), 0.023333818156582302);
    expectRelative(binomialPmf(8192, 0, OLD_ODDS), 0.36785698645015147);
    expectRelative(binomialPmf(8192, 1, OLD_ODDS), 0.36790189634960824);
    expectRelative(binomialPmf(20000, 3, FULL_ODDS), 0.14698548328988525);
  });

  it('sums to 1', () => {
    const cases: [number, number][] = [
      [1, 0.3],
      [15, 0.5],
      [16, 0.5],
      [50, 0.3],
      [333, 0.987],
      [1000, FULL_ODDS],
      [5000, 0.5],
    ];
    for (const [n, p] of cases) {
      let total = 0;
      for (let k = 0; k <= n; k++) total += binomialPmf(n, k, p);
      expect(total).toBeCloseTo(1, 12);
    }
  });

  it('stays accurate for very large n without overflowing', () => {
    // Exact values (BigInt rational arithmetic) at 500,000 encounters, 1/8192.
    expectRelative(binomialPmf(500_000, 61, OLD_ODDS), 0.05101218782983851);
    expectRelative(binomialPmf(500_000, 17, OLD_ODDS), 1.9757233025025733e-11);
    expectRelative(binomialPmf(500_000, 200, OLD_ODDS), 5.053476549752343e-45, 1e-11);
    expectRelative(binomialPmf(500_000, 0, OLD_ODDS), 3.098492389870525e-27, 1e-11);

    const n = 500_000;
    for (const k of [0, 1, 17, 61, 200]) {
      const reference = Math.exp(
        logChoose(n, k) + k * Math.log(OLD_ODDS) + (n - k) * Math.log1p(-OLD_ODDS),
      );
      expectRelative(binomialPmf(n, k, OLD_ODDS), reference, 1e-9);
    }
    // 10^8 encounters (the counter's ceiling) at even odds: mass near the mean, none far away.
    const peak = binomialPmf(100_000_000, 50_000_000, 0.5);
    expectRelative(peak, 1 / Math.sqrt(Math.PI * 50_000_000), 1e-8);
    expect(binomialPmf(100_000_000, 10, 0.5)).toBe(0);
    expect(Number.isFinite(binomialPmf(1e15, 5e14, 0.5))).toBe(true);
  });

  it('keeps its digits away from the mean when n is enormous', () => {
    // For p = ½ and |d| ≪ n: P(X = n/2 + d) = √(2 / πn) · e^(−2d²/n) to well below 1e-12.
    // Evaluating x·ln(x / mean) + mean − x directly cancels ~|d| against itself
    // and is off by 7e-10 at n = 1e15.
    const symmetric = (n: number, d: number): number =>
      Math.sqrt(2 / (Math.PI * n)) * Math.exp((-2 * d * d) / n);
    expectRelative(binomialPmf(1e12, 5e11 + 3e5, 0.5), symmetric(1e12, 3e5), 1e-12);
    expectRelative(binomialPmf(1e15, 5e14 + 1e7, 0.5), symmetric(1e15, 1e7), 1e-12);
    expectRelative(binomialPmf(1e15, 5e14 - 1e7, 0.5), symmetric(1e15, 1e7), 1e-12);
    expectRelative(binomialPmf(1e16, 5e15 + 3e7, 0.5), symmetric(1e16, 3e7), 1e-12);
  });

  it('never leaks Infinity or NaN, however large n is', () => {
    // k/mean below 2^-53 used to turn the exponent into +Infinity.
    expect(binomialPmf(1e17, 1, 0.5)).toBe(0);
    expect(binomialPmf(1e300, 3, 0.25)).toBe(0);
    expect(binomialCdf(1e17, 3, 0.5)).toBe(0);
    expect(binomialAtLeast(1e17, 3, 0.5)).toBe(1);
    // k·(n − k) overflows a double here; the peak of the distribution is still √(2 / πn).
    expectRelative(binomialPmf(1e200, 5e199, 0.5), Math.sqrt(2 / (Math.PI * 1e200)), 1e-10);

    const extremes = [0, 1, 2, 3.5, 1e7, 1e17, 1e155, 1e308, Number.MAX_VALUE, Infinity, -1, NaN];
    const probabilities = [0, 1e-320, TINY_ODDS, 0.3, 0.5, 1 - 1e-16, 1, 2, -1, NaN, Infinity];
    for (const n of extremes) {
      for (const k of extremes) {
        for (const p of probabilities) {
          const label = `n = ${n}, k = ${k}, p = ${p}`;
          for (const value of [binomialPmf(n, k, p), binomialCdf(n, k, p)]) {
            expect(value, label).toBeGreaterThanOrEqual(0);
            expect(value, label).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it('agrees with the geometric helpers at k = 0', () => {
    for (const n of [1, 10, 4096, 100_000]) {
      expectRelative(1 - binomialPmf(n, 0, FULL_ODDS), cumulativeProbability(FULL_ODDS, n), 1e-10);
    }
  });

  it('handles degenerate probabilities and arguments', () => {
    expect(binomialPmf(10, 0, 0)).toBe(1);
    expect(binomialPmf(10, 1, 0)).toBe(0);
    expect(binomialPmf(10, 10, 1)).toBe(1);
    expect(binomialPmf(10, 9, 1)).toBe(0);
    expect(binomialPmf(0, 0, 0.3)).toBe(1);
    expect(binomialPmf(10, 11, 0.3)).toBe(0);
    expect(binomialPmf(10, -1, 0.3)).toBe(0);
    expect(binomialPmf(10, 2.5, 0.3)).toBe(0);
    expect(binomialPmf(NaN, 0, 0.3)).toBe(0);
    expect(binomialPmf(-5, 0, 0.3)).toBe(0);
    expect(binomialPmf(Infinity, 0, 0.3)).toBe(0);
    expect(binomialPmf(10, 0, NaN)).toBe(1);
    expectRelative(binomialPmf(10.9, 3, 0.3), 0.266827932);
  });
});

describe('binomialCdf / binomialAtLeast', () => {
  it('matches exact values on both sides of the mode', () => {
    expectRelative(binomialCdf(20000, 3, FULL_ODDS), 0.2818291035996528, 1e-11);
    expectRelative(binomialCdf(100, 45, 0.5), 0.1841008086633481, 1e-11);
    expectRelative(binomialCdf(100, 60, 0.5), 0.9823998998911476, 1e-11);
    expectRelative(binomialCdf(4, 1, 0.5), 5 / 16);
  });

  it('equals the running sum of the point probabilities', () => {
    for (const [n, p] of [
      [40, 0.3],
      [300, 0.02],
      [1000, FULL_ODDS],
    ] as const) {
      let running = 0;
      for (let k = 0; k <= n; k++) {
        running += binomialPmf(n, k, p);
        expect(binomialCdf(n, k, p)).toBeCloseTo(Math.min(1, running), 12);
      }
    }
  });

  it('is monotonic and bounded', () => {
    let previous = 0;
    for (let k = 0; k <= 200; k++) {
      const value = binomialCdf(200, k, 0.37);
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeLessThanOrEqual(1);
      previous = value;
    }
    expect(previous).toBe(1);
  });

  it('handles huge n', () => {
    // Exact partial sums at 500,000 encounters, 1/8192 (mean ≈ 61).
    expectRelative(binomialCdf(500_000, 40, OLD_ODDS), 0.002727835013618057, 1e-11);
    expectRelative(binomialCdf(500_000, 70, OLD_ODDS), 0.8855072280944026, 1e-12);
    // Symmetric distribution: P(X ≤ n/2) = 1/2 + P(X = n/2)/2.
    const n = 1_000_000;
    expectRelative(binomialCdf(n, n / 2, 0.5), 0.5 + binomialPmf(n, n / 2, 0.5) / 2, 1e-10);
    expect(binomialCdf(n, 400_000, 0.5)).toBe(0);
    expect(binomialCdf(n, 600_000, 0.5)).toBe(1);
    expectRelative(
      binomialCdf(500_000, 0, OLD_ODDS),
      Math.exp(500_000 * Math.log1p(-OLD_ODDS)),
      1e-12,
    );
  });

  it('handles ten million encounters at 1 in 65,536', () => {
    // Exact partial sums (BigInt); the mean is ≈ 152.6 shinies.
    const n = 10_000_000;
    expectRelative(binomialPmf(n, 0, TINY_ODDS), 5.3878501186584e-67, 1e-12);
    expectRelative(binomialPmf(n, 152, TINY_ODDS), 0.0323043486260346, 1e-12);
    expectRelative(binomialCdf(n, 100, TINY_ODDS), 3.651277022961569e-6, 1e-12);
    expectRelative(binomialCdf(n, 152, TINY_ODDS), 0.5025484204349906, 1e-12);
    expectRelative(binomialCdf(n, 153, TINY_ODDS), 0.5347657583738912, 1e-12);
    expectRelative(binomialCdf(n, 200, TINY_ODDS), 0.9998969088206241, 1e-12);
    expect(binomialCdf(n, 152, TINY_ODDS) - binomialCdf(n, 151, TINY_ODDS)).toBeCloseTo(
      binomialPmf(n, 152, TINY_ODDS),
      14,
    );
    // Far upper tail: tiny but not lost to "1 − cdf".
    const tail = binomialAtLeast(n, 301, TINY_ODDS);
    expect(tail).toBeGreaterThan(1e-27);
    expect(tail).toBeLessThan(1e-25);
    expect(binomialAtLeast(n, 1, TINY_ODDS)).toBe(cumulativeProbability(TINY_ODDS, n));
  });

  it('handles edges and invalid input', () => {
    expect(binomialCdf(10, -1, 0.5)).toBe(0);
    expect(binomialCdf(10, NaN, 0.5)).toBe(0);
    expect(binomialCdf(10, 10, 0.5)).toBe(1);
    expect(binomialCdf(10, 99, 0.5)).toBe(1);
    expect(binomialCdf(10, 3, 0)).toBe(1);
    expect(binomialCdf(10, 3, 1)).toBe(0);
    expect(binomialCdf(0, 0, 0.5)).toBe(1);
    expect(binomialCdf(NaN, 0, 0.5)).toBe(1);
    expectRelative(binomialCdf(4, 1.9, 0.5), 5 / 16);
  });

  it('binomialAtLeast complements the cdf', () => {
    for (const k of [1, 2, 5, 9]) {
      expect(binomialAtLeast(30, k, 0.2) + binomialCdf(30, k - 1, 0.2)).toBeCloseTo(1, 13);
    }
    expect(binomialAtLeast(30, 0, 0.2)).toBe(1);
    expect(binomialAtLeast(30, 31, 0.2)).toBe(0);
    expect(binomialAtLeast(30, 3, 0)).toBe(0);
    expect(binomialAtLeast(30, 3, 1)).toBe(1);
    expect(binomialAtLeast(30, NaN, 0.5)).toBe(0);
  });

  it('binomialAtLeast(n, 1, p) is the cumulative curve, even for tiny tails', () => {
    for (const n of [1, 50, 4096, 30_000]) {
      expectRelative(binomialAtLeast(n, 1, FULL_ODDS), cumulativeProbability(FULL_ODDS, n), 1e-10);
    }
    // Two shinies in ten encounters: far too small for "1 − cdf" to resolve.
    const exact = 45 * OLD_ODDS ** 2;
    expectRelative(binomialAtLeast(10, 2, OLD_ODDS), exact, 1e-3);
    expect(binomialAtLeast(10, 2, OLD_ODDS)).toBeGreaterThan(0);
  });
});

describe('binomialDistribution', () => {
  it('lists point and cumulative probabilities from zero', () => {
    const distribution = binomialDistribution(4, 0.5);
    expect(distribution.map((point) => point.k)).toEqual([0, 1, 2, 3, 4]);
    expect(distribution.map((point) => point.probability)).toEqual(
      [1, 4, 6, 4, 1].map((count) => expect.closeTo(count / 16, 14) as number),
    );
    expect(distribution.at(-1)?.cumulative).toBeCloseTo(1, 14);
  });

  it('stops once the mass is covered', () => {
    const distribution = binomialDistribution(10_000, FULL_ODDS);
    expect(distribution.length).toBeLessThan(BINOMIAL_DEFAULT_MAX_ENTRIES);
    expect(distribution.at(-1)?.cumulative).toBeGreaterThanOrEqual(0.9999);
    expect(distribution[0]?.probability).toBeCloseTo(
      1 - cumulativeProbability(FULL_ODDS, 10_000),
      12,
    );
  });

  it('honours maxK and survives bad input', () => {
    expect(binomialDistribution(10_000, FULL_ODDS, 3)).toHaveLength(4);
    expect(binomialDistribution(2, 0.5, 10)).toHaveLength(3);
    expect(binomialDistribution(100, 0.5)).toHaveLength(BINOMIAL_DEFAULT_MAX_ENTRIES);
    expect(binomialDistribution(NaN, 0.5)).toEqual([{ k: 0, probability: 1, cumulative: 1 }]);
    expect(binomialDistribution(5, NaN)).toEqual([{ k: 0, probability: 1, cumulative: 1 }]);
    expect(binomialDistribution(5, 0.5, -3)).toHaveLength(1);
  });
});

describe('geometricQuantiles / milestones', () => {
  it('covers 25 / 50 / 75 / 90 / 95 / 99 %', () => {
    expect(MILESTONE_PROBABILITIES).toEqual([0.25, 0.5, 0.75, 0.9, 0.95, 0.99]);
    expect(milestones(FULL_ODDS)).toEqual([
      { probability: 0.25, encounters: 1179 },
      { probability: 0.5, encounters: 2839 },
      { probability: 0.75, encounters: 5678 },
      { probability: 0.9, encounters: 9431 },
      { probability: 0.95, encounters: 12270 },
      { probability: 0.99, encounters: 18861 },
    ]);
    expect(geometricQuantiles(FULL_ODDS)).toEqual(milestones(FULL_ODDS));
  });

  it('accepts custom quantiles', () => {
    expect(geometricQuantiles(0.5, [0.5, 0.875])).toEqual([
      { probability: 0.5, encounters: 1 },
      { probability: 0.875, encounters: 3 },
    ]);
  });

  it('reports unreachable milestones as Infinity', () => {
    expect(milestones(0).every((milestone) => milestone.encounters === Infinity)).toBe(true);
    expect(milestones(NaN).every((milestone) => milestone.encounters === Infinity)).toBe(true);
    expect(milestones(1).every((milestone) => milestone.encounters === 1)).toBe(true);
  });
});

describe('luck', () => {
  it('describes a hunt relative to other hunters', () => {
    const atOdds = luck(FULL_ODDS, 4096);
    expectRelative(atOdds.cumulative, 0.6321654705556539);
    expectRelative(atOdds.percentile, 63.21654705556539);
    expect(atOdds.oddsRatio).toBe(1);
    expect(atOdds.verdict).toBe('average');
  });

  it('moves through every verdict as the count grows', () => {
    expect(luck(FULL_ODDS, 100).verdict).toBe('very-lucky');
    expect(luck(FULL_ODDS, 1500).verdict).toBe('lucky');
    expect(luck(FULL_ODDS, 2839).verdict).toBe('average');
    expect(luck(FULL_ODDS, 6000).verdict).toBe('unlucky');
    expect(luck(FULL_ODDS, 9431).verdict).toBe('very-unlucky');
    expect(luck(FULL_ODDS, 12_288).oddsRatio).toBe(3);
  });

  it('has nothing to say before the first encounter or at zero odds', () => {
    const empty = { cumulative: 0, percentile: 0, oddsRatio: 0, verdict: 'unknown' };
    expect(luck(FULL_ODDS, 0)).toEqual(empty);
    expect(luck(0, 500)).toEqual(empty);
    expect(luck(NaN, 500)).toEqual(empty);
    expect(luck(FULL_ODDS, NaN)).toEqual(empty);
    expect(luck(FULL_ODDS, -4)).toEqual(empty);
    expect(luck(1, 1)).toMatchObject({ cumulative: 1, percentile: 100, verdict: 'very-unlucky' });
  });

  it('judges a cumulative probability directly, for chains', () => {
    expect(luckVerdict(0.05)).toBe('very-lucky');
    expect(luckVerdict(0.1)).toBe('lucky');
    expect(luckVerdict(0.4)).toBe('average');
    expect(luckVerdict(0.65)).toBe('unlucky');
    expect(luckVerdict(0.9)).toBe('very-unlucky');
    expect(luckVerdict(1)).toBe('very-unlucky');
    expect(luckVerdict(0)).toBe('unknown');
    expect(luckVerdict(-0.2)).toBe('unknown');
    expect(luckVerdict(NaN)).toBe('unknown');
    // 1 − 0.99 × 0.98 × 0.95^28 ≈ 0.769
    expect(luckVerdict(cumulativeVarying([0.01, 0.02, 0.05], 30))).toBe('unlucky');
  });

  it('has a label for every verdict', () => {
    for (const n of [0, 100, 1500, 2839, 6000, 9431]) {
      expect(LUCK_VERDICT_LABELS[luck(FULL_ODDS, n).verdict]).toBeTruthy();
    }
  });
});

describe('buildCurve', () => {
  it('runs from 0 to the 99 % quantile by default', () => {
    const curve = buildCurve(FULL_ODDS);
    expect(curve).toHaveLength(CURVE_DEFAULT_POINTS);
    expect(curve[0]).toEqual({ n: 0, probability: 0 });
    expect(curve.at(-1)?.n).toBe(18861);
    expect(curve.at(-1)?.probability).toBeGreaterThanOrEqual(0.99);
  });

  it('samples whole, strictly increasing counts with matching probabilities', () => {
    const curve = buildCurve(1 / 512, { maxN: 5000, points: 33 });
    expect(curve).toHaveLength(33);
    expect(curve.at(-1)?.n).toBe(5000);
    curve.forEach((point, index) => {
      expect(Number.isInteger(point.n)).toBe(true);
      expect(point.probability).toBe(cumulativeProbability(1 / 512, point.n));
      if (index > 0) expect(point.n).toBeGreaterThan(curve[index - 1]?.n ?? Infinity);
    });
    // Evenly spaced: neighbouring gaps differ by at most one (rounding).
    const gaps = curve.slice(1).map((point, index) => point.n - (curve[index]?.n ?? 0));
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
  });

  it('lists every encounter when the range is shorter than the sample count', () => {
    const curve = buildCurve(0.2, { maxN: 5 });
    expect(curve.map((point) => point.n)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(buildCurve(1).map((point) => point.probability)).toEqual([0, 1]);
  });

  it('caps the default range and clamps the options', () => {
    expect(buildCurve(1e-12).at(-1)?.n).toBe(CURVE_MAX_N_CAP);
    expect(buildCurve(FULL_ODDS, { points: 1, maxN: 1000 })).toHaveLength(2);
    expect(buildCurve(FULL_ODDS, { points: 1e9, maxN: 1e6 })).toHaveLength(CURVE_MAX_POINTS);
    expect(buildCurve(FULL_ODDS, { maxN: -5 }).at(-1)?.n).toBe(1);
    expect(buildCurve(FULL_ODDS, { maxN: 99.9, points: NaN }).at(-1)?.n).toBe(99);
    expect(buildCurve(FULL_ODDS, { maxN: NaN }).at(-1)?.n).toBe(18861);
    expect(Number.isFinite(buildCurve(FULL_ODDS, { maxN: Infinity }).at(-1)?.n)).toBe(true);
  });

  it('draws a flat line for odds of zero', () => {
    const curve = buildCurve(0);
    expect(curve.at(-1)?.n).toBe(CURVE_FALLBACK_MAX_N);
    expect(curve.every((point) => point.probability === 0)).toBe(true);
    expect(buildCurve(NaN).every((point) => point.probability === 0)).toBe(true);
  });
});

describe('cumulativeVarying', () => {
  it('multiplies the per-encounter misses', () => {
    expect(cumulativeVarying([0.5, 0.25], 1)).toBe(0.5);
    expectRelative(cumulativeVarying([0.5, 0.25], 2), 1 - 0.5 * 0.75);
    expectRelative(cumulativeVarying([0.1, 0.2, 0.3], 3), 1 - 0.9 * 0.8 * 0.7);
    expect(cumulativeVarying([0.5, 0.25], 0)).toBe(0);
  });

  it('reduces to the constant-odds formula', () => {
    const constant = new Array<number>(5000).fill(FULL_ODDS);
    for (const n of [1, 10, 2839, 5000]) {
      expectRelative(cumulativeVarying(constant, n), cumulativeProbability(FULL_ODDS, n), 1e-11);
      expectRelative(
        cumulativeVarying(() => FULL_ODDS, n),
        cumulativeProbability(FULL_ODDS, n),
        1e-11,
      );
    }
  });

  it('repeats the last element of a short array (a capped chain)', () => {
    const chain = [0.01, 0.02, 0.05];
    const expected = 1 - 0.99 * 0.98 * 0.95 ** 8;
    expectRelative(cumulativeVarying(chain, 10), expected);
    expect(cumulativeVarying(chain, Infinity)).toBe(1);
    expect(cumulativeVarying([0.5, 0], 1e9)).toBe(0.5);
    expect(cumulativeVarying([0], Infinity)).toBe(0);
  });

  it('accepts a function of the encounter index', () => {
    const ramp = (index: number): number => (index + 1) / 100;
    expectRelative(cumulativeVarying(ramp, 3), 1 - 0.99 * 0.98 * 0.97);
    const spy = vi.fn(ramp);
    cumulativeVarying(spy, 4);
    expect(spy.mock.calls.map(([index]) => index)).toEqual([0, 1, 2, 3]);
  });

  it('treats invalid entries as zero and certain ones as one', () => {
    expectRelative(cumulativeVarying([NaN, -1, 0.5, 0.5], 4), 0.75);
    expect(cumulativeVarying([0.1, 1, 0.1], 2)).toBe(1);
    expect(cumulativeVarying([0.1, 1, 0.1], 1)).toBeCloseTo(0.1, 15);
    expect(cumulativeVarying([0.1, 7], 2)).toBe(1);
    expect(cumulativeVarying([], 10)).toBe(0);
    expect(cumulativeVarying([0.5], NaN)).toBe(0);
    expect(cumulativeVarying([0.5], -1)).toBe(0);
    expect(cumulativeVarying(() => NaN, 10)).toBe(0);
  });

  it('stops calling a function once the outcome is certain', () => {
    const spy = vi.fn(() => 0.5);
    expect(cumulativeVarying(spy, MAX_VARYING_STEPS * 10)).toBe(1);
    expect(spy.mock.calls.length).toBeLessThan(2000);
  });
});

describe('encountersForProbabilityVarying', () => {
  it('finds the first encounter reaching the target', () => {
    const chain = [0.1, 0.2, 0.3];
    expect(encountersForProbabilityVarying(chain, 0.1)).toBe(1);
    expect(encountersForProbabilityVarying(chain, 0.2)).toBe(2);
    expect(encountersForProbabilityVarying(chain, 0.27)).toBe(2);
    expect(encountersForProbabilityVarying(chain, 0.29)).toBe(3);
    expect(encountersForProbabilityVarying((index) => (index + 1) / 10, 0.29)).toBe(3);
  });

  it('continues past the end of an array with its last element', () => {
    const chain = [0.001, 0.002, 0.004];
    for (const q of [0.005, 0.25, 0.5, 0.9, 0.99]) {
      const n = encountersForProbabilityVarying(chain, q);
      expect(cumulativeVarying(chain, n)).toBeGreaterThanOrEqual(q);
      expect(cumulativeVarying(chain, n - 1)).toBeLessThan(q);
    }
  });

  it('agrees with the constant-odds quantile', () => {
    for (const q of MILESTONE_PROBABILITIES) {
      expect(encountersForProbabilityVarying([FULL_ODDS], q)).toBe(
        encountersForProbability(FULL_ODDS, q),
      );
    }
  });

  it('reports unreachable targets', () => {
    expect(encountersForProbabilityVarying([0.1, 0], 0.5)).toBe(Infinity);
    expect(encountersForProbabilityVarying([], 0.5)).toBe(Infinity);
    expect(encountersForProbabilityVarying([0.5], 1)).toBe(Infinity);
    expect(encountersForProbabilityVarying([0.5, 1], 1)).toBe(2);
    expect(encountersForProbabilityVarying([0.5], NaN)).toBe(Infinity);
    expect(encountersForProbabilityVarying([0.5], 0)).toBe(0);
  });
});

describe('buildVaryingCurve', () => {
  const ramp = Array.from({ length: 41 }, (_, index) => (index + 1) / 4096);

  it('matches cumulativeVarying at every sample', () => {
    const curve = buildVaryingCurve(ramp, { maxN: 400, points: 50 });
    expect(curve[0]).toEqual({ n: 0, probability: 0 });
    expect(curve.at(-1)?.n).toBe(400);
    for (const point of curve) {
      expectRelative(point.probability, cumulativeVarying(ramp, point.n), 1e-11);
    }
  });

  it('runs to the 99 % quantile of the chain by default', () => {
    const curve = buildVaryingCurve(ramp);
    expect(curve.at(-1)?.n).toBe(encountersForProbabilityVarying(ramp, 0.99));
    expect(curve.at(-1)?.probability).toBeGreaterThanOrEqual(0.99);
    expect(curve.length).toBeLessThanOrEqual(CURVE_DEFAULT_POINTS);
  });

  it('supports function sources and degenerate chains', () => {
    const fromFunction = buildVaryingCurve((index) => ramp[Math.min(index, 40)] ?? 0, {
      maxN: 300,
      points: 20,
    });
    const fromArray = buildVaryingCurve(ramp, { maxN: 300, points: 20 });
    expect(fromFunction.map((point) => point.n)).toEqual(fromArray.map((point) => point.n));
    fromFunction.forEach((point, index) => {
      expectRelative(point.probability, fromArray[index]?.probability ?? NaN, 1e-11);
    });

    expect(buildVaryingCurve([]).every((point) => point.probability === 0)).toBe(true);
    expect(buildVaryingCurve([0, 1], { maxN: 4 }).map((point) => point.probability)).toEqual([
      0, 0, 1, 1, 1,
    ]);
  });
});

describe('hostile input', () => {
  // Half-typed form fields, corrupted imports and divide-by-zero upstream all end up here.
  const nasty = [
    NaN,
    Infinity,
    -Infinity,
    -1,
    -0,
    0,
    1e-320,
    TINY_ODDS,
    0.5,
    1,
    2,
    2.5,
    1e7,
    1e308,
  ];
  const isProbability = (value: number): boolean => value >= 0 && value <= 1;

  it('never throws and never returns NaN or an out-of-range probability', () => {
    for (const a of nasty) {
      for (const b of nasty) {
        const label = `a = ${a}, b = ${b}`;
        expect(isProbability(cumulativeProbability(a, b)), label).toBe(true);
        expect(isProbability(binomialAtLeast(a, b, 0.3)), label).toBe(true);
        expect(isProbability(binomialAtLeast(10, a, b)), label).toBe(true);
        expect(isProbability(cumulativeVarying([a, b], 3)), label).toBe(true);
        expect(isProbability(cumulativeVarying([0.1, a], b)), label).toBe(true);

        // Counts: a whole number of encounters or Infinity — never NaN, never negative.
        for (const count of [
          encountersForProbability(a, b),
          encountersForProbabilityVarying([a, b], 0.5),
          encountersForProbabilityVarying([0.01, a], b),
        ]) {
          expect(count >= 0, label).toBe(true);
          expect(count === Infinity || Number.isInteger(count), label).toBe(true);
        }

        const verdict = luck(a, b);
        expect(isProbability(verdict.cumulative), label).toBe(true);
        expect(verdict.percentile >= 0 && verdict.percentile <= 100, label).toBe(true);
        expect(verdict.oddsRatio >= 0, label).toBe(true);
        expect(LUCK_VERDICT_LABELS[verdict.verdict], label).toBeTruthy();

        // Keep the explicit range small: this is about validation, not about long curves.
        const curves = [
          buildCurve(a, { maxN: Math.min(b, 500), points: a }),
          buildCurve(b, { maxN: Math.min(a, 500), points: 40 }),
          buildVaryingCurve([a, b], { maxN: 50, points: b }),
        ];
        for (const curve of curves) {
          expect(curve.length, label).toBeGreaterThanOrEqual(2);
          expect(curve[0], label).toEqual({ n: 0, probability: 0 });
          for (const [index, point] of curve.entries()) {
            expect(Number.isInteger(point.n) && isProbability(point.probability), label).toBe(true);
            if (index > 0) expect(point.n, label).toBeGreaterThan(curve[index - 1]?.n ?? Infinity);
          }
        }

        for (const point of binomialDistribution(Math.min(a, 1e6), b, 5)) {
          expect(isProbability(point.probability) && isProbability(point.cumulative), label).toBe(
            true,
          );
        }
      }

      const expected = expectedEncounters(a);
      expect(expected >= 1, `p = ${a}`).toBe(true);
      for (const milestone of milestones(a)) {
        expect(milestone.encounters >= 1, `p = ${a}`).toBe(true);
      }
    }
  });
});
