/**
 * Shiny Found with confirmation, for inputs that are pressed rather than
 * clicked: the global hotkey, the renderer's in-app hotkey and the Stream Deck.
 *
 * The first request for a hunt arms it for {@link SHINY_CONFIRM_WINDOW_MS}; a
 * second request inside that window completes the hunt through
 * `store.completeHunt`, so it stays undoable like any other completion. A stray
 * tap therefore never ends a hunt. The Hunt view's own button does not come
 * through here — it completes directly.
 *
 * A pending confirmation is dropped (and announced) when:
 *   - its window runs out                         source `system`
 *   - the hunt's count / phases / status change   source of that change
 *   - another hunt becomes the active one,
 *     the hunt is removed or the state replaced   source `system`
 *
 * Every arm, confirmation and drop is announced as a {@link ShinyArmedEvent};
 * `main.ts` forwards them to the windows and the Stream Deck bridge.
 *
 * This module must stay free of `electron` imports so it can be unit-tested.
 */
import { SHINY_CONFIRM_WINDOW_MS } from '@shared/streamDeck';
import type {
  CounterSource,
  HuntChangeKind,
  ShinyArmedEvent,
  ShinyFoundResult,
  StateEvent,
} from '@shared/types';
import type { AppStore } from './store';
import { BOUNDS, truncate } from './validation';

type Logger = (message: string, detail?: unknown) => void;

/** Timer functions, injectable so tests can drive the expiry by hand. */
export interface ConfirmTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface ShinyConfirmOptions {
  store: Pick<AppStore, 'getHunt' | 'completeHunt' | 'subscribe'>;
  /** How long a first press stays armed (default {@link SHINY_CONFIRM_WINDOW_MS}). */
  windowMs?: number;
  /** Epoch ms (default `Date.now`). */
  now?: () => number;
  timers?: ConfirmTimers;
  log?: Logger;
}

export interface ShinyConfirm {
  /**
   * First call for a hunt: arms it. Second call inside the window: completes it.
   * Throws for an unknown hunt or one that is not active (completed / archived).
   */
  request(huntId: string, source: CounterSource): ShinyFoundResult;
  /** Epoch ms the hunt's pending confirmation expires; null when it is not armed. */
  armedUntil(huntId: string): number | null;
  subscribe(listener: (event: ShinyArmedEvent) => void): () => void;
  /** Drops every pending confirmation without announcing it and stops following the store. */
  dispose(): void;
}

/** Changes after which a pending confirmation no longer refers to what the user saw. */
const DISARMING_CHANGES: ReadonlySet<HuntChangeKind> = new Set<HuntChangeKind>([
  'increment',
  'decrement',
  'set-count',
  'phase-logged',
  'completed',
  'reopened',
  'undo',
]);

const defaultTimers: ConfirmTimers = {
  set(callback, ms) {
    const timer = setTimeout(callback, ms);
    // A pending confirmation must not keep the process alive.
    timer.unref();
    return timer;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

interface Armed {
  until: number;
  timer: unknown;
}

export function createShinyConfirm(options: ShinyConfirmOptions): ShinyConfirm {
  const { store } = options;
  const windowMs = Math.max(1, options.windowMs ?? SHINY_CONFIRM_WINDOW_MS);
  const now = options.now ?? Date.now;
  const timers = options.timers ?? defaultTimers;
  const log = options.log ?? (() => undefined);

  const armed = new Map<string, Armed>();
  const listeners = new Set<(event: ShinyArmedEvent) => void>();
  let disposed = false;

  const announce = (event: ShinyArmedEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        log('A Shiny Found listener failed', error);
      }
    }
  };

  /** Forgets the hunt's pending confirmation; true when there was one. */
  const forget = (huntId: string): boolean => {
    const entry = armed.get(huntId);
    if (entry === undefined) return false;
    timers.clear(entry.timer);
    armed.delete(huntId);
    return true;
  };

  const disarm = (huntId: string, source: CounterSource): void => {
    if (forget(huntId)) announce({ huntId, armedUntil: null, source });
  };

  const expire = (huntId: string, until: number): void => {
    const entry = armed.get(huntId);
    // A re-arm replaced this window; its own timer handles it.
    if (entry === undefined || entry.until !== until) return;
    armed.delete(huntId);
    announce({ huntId, armedUntil: null, source: 'system' });
  };

  const follow = (event: StateEvent): void => {
    if (armed.size === 0) return;
    switch (event.type) {
      case 'hunt-changed':
        if (!armed.has(event.hunt.id)) return;
        if (event.hunt.status !== 'active' || DISARMING_CHANGES.has(event.change.kind)) {
          disarm(event.hunt.id, event.change.source);
        }
        return;
      case 'active-hunt-changed':
        for (const huntId of [...armed.keys()]) {
          if (huntId !== event.activeHuntId) disarm(huntId, 'system');
        }
        return;
      case 'hunt-removed':
        disarm(event.huntId, 'system');
        return;
      case 'state-replaced':
        for (const huntId of [...armed.keys()]) disarm(huntId, 'system');
        return;
      case 'settings-changed':
      case 'sessions-changed':
        return;
    }
  };

  const stopFollowing = store.subscribe(follow);

  return {
    request(huntId, source) {
      if (disposed) throw new Error('Biolume is shutting down');
      const hunt = store.getHunt(huntId);
      if (hunt === null) throw new Error(`Unknown hunt: "${truncate(huntId, BOUNDS.idLength)}"`);
      if (hunt.status !== 'active') {
        disarm(hunt.id, 'system');
        throw new Error(
          `Cannot mark a shiny found: hunt "${hunt.name}" is ${hunt.status} — reopen it first`,
        );
      }

      const at = now();
      const pending = armed.get(hunt.id);
      if (pending !== undefined && at < pending.until) {
        // Forgotten before completing, so the `completed` event this causes is not a disarm.
        forget(hunt.id);
        try {
          const completed = store.completeHunt(hunt.id, undefined, source);
          return { completed: true, armedUntil: null, hunt: completed };
        } finally {
          announce({ huntId: hunt.id, armedUntil: null, source });
        }
      }

      // First press — or the previous window ran out a moment before its timer fired.
      forget(hunt.id);
      const until = at + windowMs;
      const timer = timers.set(() => expire(hunt.id, until), windowMs);
      armed.set(hunt.id, { until, timer });
      announce({ huntId: hunt.id, armedUntil: until, source });
      return { completed: false, armedUntil: until, hunt };
    },

    armedUntil(huntId) {
      const entry = armed.get(huntId);
      return entry !== undefined && now() < entry.until ? entry.until : null;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      stopFollowing();
      for (const huntId of [...armed.keys()]) forget(huntId);
      listeners.clear();
    },
  };
}
