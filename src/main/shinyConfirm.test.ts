import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '@shared/defaults';
import { SHINY_CONFIRM_WINDOW_MS } from '@shared/streamDeck';
import type { AppState, ShinyArmedEvent, StateEvent } from '@shared/types';
import { createShinyConfirm, type ConfirmTimers } from './shinyConfirm';
import { createAppStore, type StatePersistence } from './store';

const START = Date.UTC(2026, 9, 15, 20, 0, 0);

/** A clock and a timer queue that only move when the test says so. */
function createManualTime() {
  let ms = START;
  let nextId = 0;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const timers: ConfirmTimers = {
    set(callback, delay) {
      nextId += 1;
      pending.set(nextId, { at: ms + delay, callback });
      return nextId;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    now: () => ms,
    timers,
    pendingCount: () => pending.size,
    /** Moves the clock without running any timer (a busy event loop). */
    skew(by: number) {
      ms += by;
    },
    /** Moves the clock forward and fires every timer that came due, in order. */
    advance(by: number) {
      const target = ms + by;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        pending.delete(due[0]);
        ms = due[1].at;
        due[1].callback();
      }
      ms = target;
    },
  };
}

function setup() {
  const initial: AppState = {
    settings: createDefaultSettings(),
    hunts: [],
    activeHuntId: null,
    sessions: [],
  };
  const persistence: StatePersistence = {
    loadState: () => initial,
    saveSettings: () => undefined,
    saveHunts: () => undefined,
    saveSessions: () => undefined,
    flushSync: () => undefined,
  };
  const time = createManualTime();
  let nextId = 0;
  const store = createAppStore(persistence, {
    now: () => new Date(time.now()),
    idGenerator: () => `id-${(nextId += 1)}`,
  });
  const shiny = createShinyConfirm({ store, now: time.now, timers: time.timers });
  const armed: ShinyArmedEvent[] = [];
  shiny.subscribe((event) => armed.push(event));
  const changes: StateEvent[] = [];
  store.subscribe((event) => changes.push(event));
  const hunt = store.getActiveHunt();
  if (hunt === null) throw new Error('The store should start with a hunt');
  return { store, shiny, time, armed, changes, huntId: hunt.id };
}

describe('createShinyConfirm', () => {
  it('arms on the first request and completes on a second one inside the window', () => {
    const { store, shiny, time, armed, changes, huntId } = setup();

    const first = shiny.request(huntId, 'streamdeck');
    expect(first.completed).toBe(false);
    expect(first.armedUntil).toBe(START + SHINY_CONFIRM_WINDOW_MS);
    expect(first.hunt.status).toBe('active');
    expect(shiny.armedUntil(huntId)).toBe(START + SHINY_CONFIRM_WINDOW_MS);
    expect(store.getHunt(huntId)?.status).toBe('active');
    expect(changes).toEqual([]);

    time.advance(SHINY_CONFIRM_WINDOW_MS - 1);
    const second = shiny.request(huntId, 'hotkey-global');
    expect(second.completed).toBe(true);
    expect(second.armedUntil).toBeNull();
    expect(second.hunt.status).toBe('completed');
    expect(store.getHunt(huntId)?.status).toBe('completed');
    expect(shiny.armedUntil(huntId)).toBeNull();
    expect(time.pendingCount()).toBe(0);

    expect(armed).toEqual([
      { huntId, armedUntil: START + SHINY_CONFIRM_WINDOW_MS, source: 'streamdeck' },
      { huntId, armedUntil: null, source: 'hotkey-global' },
    ]);
    // The completion carries the confirming source, and is the only hunt change.
    const huntChanges = changes.filter((event) => event.type === 'hunt-changed');
    expect(huntChanges).toHaveLength(1);
    expect(huntChanges[0]).toMatchObject({
      change: { kind: 'completed', source: 'hotkey-global' },
    });
  });

  it('stays undoable like any completion', () => {
    const { store, shiny, huntId } = setup();
    store.adjustCount(huntId, 7, 'ui');
    shiny.request(huntId, 'streamdeck');
    shiny.request(huntId, 'streamdeck');
    expect(store.getHunt(huntId)?.status).toBe('completed');
    const undone = store.undo(huntId, 'streamdeck');
    expect(undone?.status).toBe('active');
    expect(undone?.completedAt).toBeNull();
    expect(undone?.count).toBe(7);
  });

  it('expires after the window, announces it and arms afresh on the next request', () => {
    const { store, shiny, time, armed, huntId } = setup();
    shiny.request(huntId, 'streamdeck');
    time.advance(SHINY_CONFIRM_WINDOW_MS);
    expect(shiny.armedUntil(huntId)).toBeNull();
    expect(armed.at(-1)).toEqual({ huntId, armedUntil: null, source: 'system' });

    const again = shiny.request(huntId, 'streamdeck');
    expect(again.completed).toBe(false);
    expect(again.armedUntil).toBe(START + 2 * SHINY_CONFIRM_WINDOW_MS);
    expect(store.getHunt(huntId)?.status).toBe('active');
    expect(armed).toHaveLength(3);
  });

  it('treats a request after the deadline as a first press even before the timer fired', () => {
    const { store, shiny, time, armed, huntId } = setup();
    shiny.request(huntId, 'streamdeck');
    // The event loop was busy: the clock passed the deadline, the timer has not run yet.
    time.skew(SHINY_CONFIRM_WINDOW_MS);
    expect(shiny.armedUntil(huntId)).toBeNull();
    const late = shiny.request(huntId, 'streamdeck');
    expect(late.completed).toBe(false);
    expect(late.armedUntil).toBe(START + 2 * SHINY_CONFIRM_WINDOW_MS);
    expect(store.getHunt(huntId)?.status).toBe('active');
    // The stale timer was replaced, so it can neither fire nor cut the new window short.
    expect(time.pendingCount()).toBe(1);
    time.advance(SHINY_CONFIRM_WINDOW_MS - 1);
    expect(shiny.armedUntil(huntId)).toBe(late.armedUntil);
    expect(armed.map((event) => event.armedUntil)).toEqual([
      START + SHINY_CONFIRM_WINDOW_MS,
      START + 2 * SHINY_CONFIRM_WINDOW_MS,
    ]);
  });

  it('is disarmed by a count change on the hunt', () => {
    const { store, shiny, armed, huntId } = setup();
    shiny.request(huntId, 'streamdeck');
    store.adjustCount(huntId, 1, 'overlay');
    expect(shiny.armedUntil(huntId)).toBeNull();
    expect(armed.at(-1)).toEqual({ huntId, armedUntil: null, source: 'overlay' });
    // The next press arms again instead of completing.
    expect(shiny.request(huntId, 'streamdeck').completed).toBe(false);
    store.adjustCount(huntId, -1, 'streamdeck');
    expect(armed.at(-1)).toEqual({ huntId, armedUntil: null, source: 'streamdeck' });
    for (const change of [
      () => store.logPhase(huntId, { speciesId: null, speciesName: '', source: 'ui' }),
      () => store.undo(huntId, 'ui'),
      () => store.setCount(huntId, 40, 'ui'),
    ]) {
      shiny.request(huntId, 'streamdeck');
      change();
      expect(shiny.armedUntil(huntId)).toBeNull();
    }
  });

  it('survives a rename of the hunt', () => {
    const { store, shiny, huntId } = setup();
    shiny.request(huntId, 'streamdeck');
    store.updateHunt(huntId, { name: 'Renamed' });
    expect(shiny.request(huntId, 'streamdeck').completed).toBe(true);
  });

  it('is disarmed when the hunt is completed some other way', () => {
    const { store, shiny, armed, huntId } = setup();
    shiny.request(huntId, 'streamdeck');
    store.completeHunt(huntId);
    expect(shiny.armedUntil(huntId)).toBeNull();
    expect(armed.at(-1)).toEqual({ huntId, armedUntil: null, source: 'ui' });
  });

  it('is disarmed by switching the active hunt, removing the hunt or replacing the state', () => {
    const { store, shiny, time, armed, huntId } = setup();
    const other = store.createHunt({ name: 'Other', activate: false });

    shiny.request(huntId, 'streamdeck');
    store.setActiveHunt(other.id);
    expect(shiny.armedUntil(huntId)).toBeNull();
    expect(armed.at(-1)).toEqual({ huntId, armedUntil: null, source: 'system' });

    shiny.request(other.id, 'streamdeck');
    store.removeHunt(other.id);
    expect(shiny.armedUntil(other.id)).toBeNull();
    expect(armed.at(-1)).toEqual({ huntId: other.id, armedUntil: null, source: 'system' });

    shiny.request(huntId, 'ui');
    store.replaceState(store.getState());
    expect(shiny.armedUntil(huntId)).toBeNull();
    expect(time.pendingCount()).toBe(0);
  });

  it('keeps one pending confirmation per hunt', () => {
    const { store, shiny, huntId } = setup();
    const other = store.createHunt({ name: 'Other', activate: false });
    shiny.request(huntId, 'streamdeck');
    shiny.request(other.id, 'ui');
    expect(shiny.armedUntil(huntId)).not.toBeNull();
    expect(shiny.armedUntil(other.id)).not.toBeNull();
    // Confirming the first hunt leaves the other armed.
    expect(shiny.request(huntId, 'streamdeck').completed).toBe(true);
    expect(shiny.armedUntil(other.id)).not.toBeNull();
  });

  it('refuses hunts that are not active, and unknown hunts', () => {
    const { store, shiny, armed, huntId } = setup();
    store.completeHunt(huntId);
    expect(() => shiny.request(huntId, 'streamdeck')).toThrow(/is completed — reopen it first/);
    store.reopenHunt(huntId);
    store.updateHunt(huntId, { status: 'archived' });
    expect(() => shiny.request(huntId, 'streamdeck')).toThrow(/is archived/);
    expect(() => shiny.request('no-such-hunt', 'streamdeck')).toThrow(/Unknown hunt/);
    expect(armed).toEqual([]);
  });

  it('keeps announcing when a listener throws, and stops everything on dispose', () => {
    const { shiny, time, huntId } = setup();
    const seen: (number | null)[] = [];
    shiny.subscribe(() => {
      throw new Error('listener failure');
    });
    shiny.subscribe((event) => seen.push(event.armedUntil));
    shiny.request(huntId, 'streamdeck');
    expect(seen).toEqual([START + SHINY_CONFIRM_WINDOW_MS]);
    shiny.dispose();
    expect(time.pendingCount()).toBe(0);
    expect(() => shiny.request(huntId, 'streamdeck')).toThrow(/shutting down/);
  });
});
