import { describe, expect, it } from 'vitest';
import { Backoff } from './backoff';

describe('Backoff', () => {
  it('doubles from the initial delay up to the cap', () => {
    const backoff = new Backoff({ initialMs: 100, maxMs: 1_000, jitter: 0 });
    expect(Array.from({ length: 7 }, () => backoff.next())).toEqual([
      100, 200, 400, 800, 1_000, 1_000, 1_000,
    ]);
    expect(backoff.attempt).toBe(7);
  });

  it('starts over after reset()', () => {
    const backoff = new Backoff({ initialMs: 100, maxMs: 1_000, jitter: 0 });
    backoff.next();
    backoff.next();
    backoff.reset();
    expect(backoff.next()).toBe(100);
  });

  it('jitter only ever shortens the delay, by at most its share', () => {
    const low = new Backoff({ initialMs: 1_000, maxMs: 1_000, jitter: 0.25, random: () => 0.999 });
    const high = new Backoff({ initialMs: 1_000, maxMs: 1_000, jitter: 0.25, random: () => 0 });
    expect(low.next()).toBe(750);
    expect(high.next()).toBe(1_000);
    const real = new Backoff({ initialMs: 500, maxMs: 500, jitter: 0.5 });
    for (let i = 0; i < 100; i++) {
      const delay = real.next();
      expect(delay).toBeGreaterThanOrEqual(250);
      expect(delay).toBeLessThanOrEqual(500);
    }
  });

  it('never overflows on long outages', () => {
    const backoff = new Backoff({ initialMs: 250, maxMs: 10_000, jitter: 0 });
    for (let i = 0; i < 10_000; i++) backoff.next();
    expect(backoff.next()).toBe(10_000);
  });
});
