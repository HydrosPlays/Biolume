/**
 * Capped exponential backoff with downward jitter: attempt n waits
 * `min(max, initial * factor^n)`, shortened by up to `jitter` of itself so
 * several plugin instances never hammer a restarting Biolume in lockstep, and
 * never longer than the cap.
 */
export interface BackoffOptions {
  /** Delay before the first retry, ms (default 250). */
  initialMs?: number;
  /** Upper bound of any delay, ms (default 10 000). */
  maxMs?: number;
  /** Growth per attempt (default 2). */
  factor?: number;
  /** Share of the delay that may be shaved off at random, 0–1 (default 0.2). */
  jitter?: number;
  /** Source of randomness in [0, 1) — injectable for tests. */
  random?: () => number;
}

export class Backoff {
  readonly #initial: number;
  readonly #max: number;
  readonly #factor: number;
  readonly #jitter: number;
  readonly #random: () => number;
  #attempt = 0;

  constructor(options: BackoffOptions = {}) {
    this.#initial = Math.max(1, options.initialMs ?? 250);
    this.#max = Math.max(this.#initial, options.maxMs ?? 10_000);
    this.#factor = Math.max(1, options.factor ?? 2);
    this.#jitter = Math.min(1, Math.max(0, options.jitter ?? 0.2));
    this.#random = options.random ?? Math.random;
  }

  /** Retries scheduled since the last {@link reset}. */
  get attempt(): number {
    return this.#attempt;
  }

  /** The delay before the next retry; advances the attempt counter. */
  next(): number {
    const exponent = Math.min(this.#attempt, 64);
    const base = Math.min(this.#max, this.#initial * this.#factor ** exponent);
    this.#attempt++;
    const shave = base * this.#jitter * Math.min(Math.max(this.#random(), 0), 1);
    return Math.max(1, Math.round(base - shave));
  }

  /** Back to the initial delay, e.g. after a connection delivered real data. */
  reset(): void {
    this.#attempt = 0;
  }
}
