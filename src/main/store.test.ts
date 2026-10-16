import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TARGET_LEVEL,
  LIMITS,
  createDefaultOddsSelection,
  createDefaultSettings,
} from '@shared/defaults';
import {
  MAX_BINDINGS_PER_ACTION,
  huntTotal,
  type AppState,
  type Hunt,
  type SessionRecord,
  type StateEvent,
  type TargetRef,
} from '@shared/types';
import { createStorage } from './storage';
import {
  STARTER_HUNT_NAME,
  createAppStore,
  type AppStore,
  type AppStoreOptions,
  type StatePersistence,
} from './store';
import { BOUNDS } from './validation';

const START = Date.UTC(2026, 9, 13, 18, 0, 0);
const MINUTE = 60_000;

const PIKACHU: TargetRef = {
  speciesId: 25,
  pokemonId: 25,
  slug: 'pikachu',
  name: 'Pikachu',
  types: ['electric'],
  spriteUrl: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/25.png',
  shinySpriteUrl:
    'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/shiny/25.png',
};

function emptyState(): AppState {
  return { settings: createDefaultSettings(), hunts: [], activeHuntId: null, sessions: [] };
}

interface Harness {
  store: AppStore;
  events: StateEvent[];
  /** Events recorded since the last call. */
  drain(): StateEvent[];
  clock: { ms: number; advance(ms: number): void };
  saves: { settings: number; hunts: number; sessions: number; flushes: number };
  saved: { hunts: Hunt[]; activeHuntId: string | null; sessions: SessionRecord[] };
}

function setup(initial: AppState = emptyState(), options: AppStoreOptions = {}): Harness {
  const clock = {
    ms: START,
    advance(ms: number) {
      clock.ms += ms;
    },
  };
  const saves = { settings: 0, hunts: 0, sessions: 0, flushes: 0 };
  const saved: Harness['saved'] = { hunts: [], activeHuntId: null, sessions: [] };
  const persistence: StatePersistence = {
    loadState: () => initial,
    saveSettings: () => {
      saves.settings += 1;
    },
    saveHunts: (hunts, activeHuntId) => {
      saves.hunts += 1;
      saved.hunts = [...hunts];
      saved.activeHuntId = activeHuntId;
    },
    saveSessions: (sessions) => {
      saves.sessions += 1;
      saved.sessions = [...sessions];
    },
    flushSync: () => {
      saves.flushes += 1;
    },
  };
  let nextId = 0;
  const store = createAppStore(persistence, {
    now: () => new Date(clock.ms),
    idGenerator: () => `id-${(nextId += 1)}`,
    ...options,
  });
  const events: StateEvent[] = [];
  store.subscribe((event) => events.push(event));
  return { store, events, drain: () => events.splice(0), clock, saves, saved };
}

/** A store whose starter hunt is the active one. */
function setupWithHunt(options: AppStoreOptions = {}): Harness & { huntId: string } {
  const harness = setup(emptyState(), options);
  const huntId = harness.store.getState().activeHuntId;
  if (huntId === null) throw new Error('expected a starter hunt');
  return { ...harness, huntId };
}

function huntChanges(events: readonly StateEvent[]) {
  return events.flatMap((event) => (event.type === 'hunt-changed' ? [event.change] : []));
}

function types(events: readonly StateEvent[]): string[] {
  return events.map((event) => event.type);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('startup', () => {
  it('creates and activates a starter hunt when there are no hunts', () => {
    const { store, saves, saved } = setup();
    const state = store.getState();
    expect(state.hunts).toHaveLength(1);
    expect(state.hunts[0]).toMatchObject({
      name: STARTER_HUNT_NAME,
      status: 'active',
      count: 0,
      priorCount: 0,
      step: 1,
      target: null,
      targetLevel: DEFAULT_TARGET_LEVEL,
      odds: createDefaultOddsSelection(),
      phases: [],
      completedAt: null,
      elapsedMs: 0,
      createdAt: new Date(START).toISOString(),
    });
    expect(state.activeHuntId).toBe(state.hunts[0]?.id);
    expect(store.getActiveHunt()).toBe(state.hunts[0]);
    expect(saves.hunts).toBe(1);
    expect(saved.activeHuntId).toBe(state.activeHuntId);
  });

  it('lets the counter work immediately on a first launch', () => {
    const { store, huntId } = setupWithHunt();
    expect(store.adjustCount(huntId, 1, 'hotkey-global').count).toBe(1);
  });

  it('leaves existing hunts and an explicit "no active hunt" alone', () => {
    const { store: seed, huntId } = setupWithHunt();
    seed.adjustCount(huntId, 3, 'ui');
    const initial: AppState = { ...seed.getState(), activeHuntId: null, sessions: [] };
    const { store, saves } = setup(initial);
    expect(store.getState()).toBe(initial);
    expect(store.getActiveHunt()).toBeNull();
    expect(saves.hunts).toBe(0);
  });
});

describe('createHunt', () => {
  it('creates an active hunt, activates it and emits both events in order', () => {
    const { store, drain, saves } = setupWithHunt();
    const savesBefore = saves.hunts;
    const hunt = store.createHunt({
      name: '  Pika hunt ',
      target: PIKACHU,
      targetLevel: 12,
      step: 5,
      notes: 'Viridian',
    });

    expect(hunt).toMatchObject({
      name: 'Pika hunt',
      target: PIKACHU,
      targetLevel: 12,
      step: 5,
      notes: 'Viridian',
      count: 0,
    });
    expect(store.getState().activeHuntId).toBe(hunt.id);
    expect(store.getState().hunts).toHaveLength(2);
    expect(store.getHunt(hunt.id)).toBe(hunt);
    expect(saves.hunts).toBe(savesBefore + 1);

    const events = drain();
    expect(events).toEqual([
      { type: 'hunt-changed', hunt, change: { kind: 'created', delta: 0, source: 'ui' } },
      { type: 'active-hunt-changed', activeHuntId: hunt.id },
    ]);
  });

  it('does not activate when asked not to', () => {
    const { store, drain, huntId } = setupWithHunt();
    const hunt = store.createHunt({ name: 'Later', activate: false });
    expect(store.getState().activeHuntId).toBe(huntId);
    expect(types(drain())).toEqual(['hunt-changed']);
    expect(hunt.status).toBe('active');
  });

  it('names an unnamed hunt after its target, or generically', () => {
    const { store } = setupWithHunt();
    expect(store.createHunt({ target: PIKACHU }).name).toBe('Pikachu');
    expect(store.createHunt({ name: '   ' }).name).toBe('Untitled hunt');
  });

  it('clamps numbers, caps strings and drops what does not belong', () => {
    const { store } = setupWithHunt();
    const hunt = store.createHunt({
      name: 'x'.repeat(500),
      targetLevel: 9_000,
      step: -3,
      notes: 'n'.repeat(10_000),
      target: {
        ...PIKACHU,
        spriteUrl: 'http://insecure.example/pika.png',
        shinySpriteUrl: 'javascript:alert(1)',
      },
      odds: {
        gameId: 'swsh',
        methodId: 'masuda',
        shinyCharm: true,
        inputs: { chain: 12, mode: 'fast', bad: null as unknown as number },
      },
    });
    expect(hunt.name).toHaveLength(LIMITS.huntName);
    expect(hunt.targetLevel).toBe(LIMITS.targetLevel.max);
    expect(hunt.step).toBe(LIMITS.step.min);
    expect(hunt.notes).toHaveLength(LIMITS.notes);
    expect(hunt.target?.spriteUrl).toBeNull();
    expect(hunt.target?.shinySpriteUrl).toBeNull();
    expect(hunt.odds).toEqual({
      gameId: 'swsh',
      methodId: 'masuda',
      shinyCharm: true,
      inputs: { chain: 12, mode: 'fast' },
    });
  });

  it('rejects input of the wrong shape with a readable message', () => {
    const { store, drain } = setupWithHunt();
    expect(() => store.createHunt({ name: 42 as unknown as string })).toThrow(
      /Invalid hunt: name: expected string/,
    );
    expect(() => store.createHunt({ targetLevel: Number.NaN })).toThrow(
      /Invalid hunt: targetLevel/,
    );
    expect(() => store.createHunt({ target: { ...PIKACHU, slug: '../../x' } })).toThrow(
      /target\.slug/,
    );
    expect(() => store.createHunt('nope' as unknown as object)).toThrow(/Invalid hunt/);
    expect(drain()).toEqual([]);
    expect(store.getState().hunts).toHaveLength(1);
  });
});

describe('updateHunt', () => {
  it('applies a patch, bumps updatedAt and emits one edited event', () => {
    const { store, drain, clock, huntId } = setupWithHunt();
    const before = store.getHunt(huntId);
    clock.advance(5_000);
    const next = store.updateHunt(huntId, {
      name: 'Renamed',
      target: PIKACHU,
      targetLevel: 0,
      step: 99_999,
    });

    expect(next).toMatchObject({
      name: 'Renamed',
      target: PIKACHU,
      targetLevel: 1,
      step: LIMITS.step.max,
    });
    expect(next.updatedAt).toBe(new Date(START + 5_000).toISOString());
    expect(next.createdAt).toBe(before?.createdAt);
    expect(drain()).toEqual([
      { type: 'hunt-changed', hunt: next, change: { kind: 'edited', delta: 0, source: 'ui' } },
    ]);
  });

  it('can clear the target with null and ignores undefined keys', () => {
    const { store, huntId } = setupWithHunt();
    store.updateHunt(huntId, { target: PIKACHU, notes: 'keep' });
    const next = store.updateHunt(huntId, { target: null, notes: undefined });
    expect(next.target).toBeNull();
    expect(next.notes).toBe('keep');
  });

  it('does nothing for an empty patch', () => {
    const { store, drain, saves, huntId } = setupWithHunt();
    const before = store.getHunt(huntId);
    const savesBefore = saves.hunts;
    expect(store.updateHunt(huntId, {})).toBe(before);
    expect(drain()).toEqual([]);
    expect(saves.hunts).toBe(savesBefore);
  });

  it('keeps completedAt consistent when the status is edited, and lets undo take it back', () => {
    const { store, clock, huntId } = setupWithHunt();
    clock.advance(1_000);
    const completed = store.updateHunt(huntId, { status: 'completed' });
    expect(completed.completedAt).toBe(new Date(START + 1_000).toISOString());

    const archived = store.updateHunt(huntId, { status: 'archived' });
    expect(archived.completedAt).toBe(completed.completedAt);

    const active = store.updateHunt(huntId, { status: 'active' });
    expect(active.completedAt).toBeNull();

    expect(store.undo(huntId)?.status).toBe('archived');
    expect(store.undo(huntId)).toMatchObject({
      status: 'completed',
      completedAt: completed.completedAt,
    });
    expect(store.undo(huntId)).toMatchObject({ status: 'active', completedAt: null });
  });

  it('falls back to a sensible name instead of storing an empty one', () => {
    const { store, huntId } = setupWithHunt();
    store.updateHunt(huntId, { target: PIKACHU });
    expect(store.updateHunt(huntId, { name: '  ' }).name).toBe('Pikachu');
  });

  it('throws for unknown hunts and invalid patches', () => {
    const { store, huntId } = setupWithHunt();
    expect(() => store.updateHunt('missing', { name: 'x' })).toThrow('Unknown hunt: "missing"');
    expect(() => store.updateHunt(huntId, { status: 'paused' as never })).toThrow(
      /status: expected one of active, completed, archived/,
    );
    expect(() => store.updateHunt(huntId, { step: '5' as unknown as number })).toThrow(
      /Invalid hunt changes: step/,
    );
    expect(() => store.updateHunt(null as unknown as string, {})).toThrow('Unknown hunt: (null)');
  });
});

describe('removeHunt and setActiveHunt', () => {
  it('activates the most recently updated countable hunt when the active one is removed', () => {
    const { store, drain, clock, huntId } = setupWithHunt();
    const older = store.createHunt({ name: 'Older', activate: false });
    clock.advance(1_000);
    const newer = store.createHunt({ name: 'Newer', activate: false });
    clock.advance(1_000);
    const newestButDone = store.createHunt({ name: 'Done', activate: false });
    store.completeHunt(newestButDone.id);
    drain();

    store.removeHunt(huntId);
    expect(store.getState().activeHuntId).toBe(newer.id);
    expect(store.getHunt(huntId)).toBeNull();
    expect(drain()).toEqual([
      { type: 'active-hunt-changed', activeHuntId: newer.id },
      { type: 'hunt-removed', huntId },
    ]);

    store.removeHunt(newer.id);
    expect(store.getState().activeHuntId).toBe(older.id);
    store.removeHunt(older.id);
    // Only a completed hunt is left: nothing can be counted on, so nothing is active.
    expect(store.getState().activeHuntId).toBeNull();
    expect(store.getState().hunts.map((hunt) => hunt.id)).toEqual([newestButDone.id]);
  });

  it('removing an inactive hunt leaves the selection alone', () => {
    const { store, drain, huntId } = setupWithHunt();
    const other = store.createHunt({ name: 'Other', activate: false });
    drain();
    store.removeHunt(other.id);
    expect(store.getState().activeHuntId).toBe(huntId);
    expect(drain()).toEqual([{ type: 'hunt-removed', huntId: other.id }]);
  });

  it('removing the last hunt leaves an empty list', () => {
    const { store, huntId } = setupWithHunt();
    store.removeHunt(huntId);
    expect(store.getState()).toMatchObject({ hunts: [], activeHuntId: null });
    expect(() => store.removeHunt(huntId)).toThrow(/Unknown hunt/);
  });

  it('drops the removed hunt’s undo history', () => {
    const { store, huntId } = setupWithHunt();
    store.adjustCount(huntId, 1, 'ui');
    store.removeHunt(huntId);
    expect(() => store.undo(huntId)).toThrow(/Unknown hunt/);
  });

  it('switches the active hunt, including to none', () => {
    const { store, drain, saved, huntId } = setupWithHunt();
    const other = store.createHunt({ name: 'Other', activate: false });
    drain();

    store.setActiveHunt(other.id);
    expect(store.getState().activeHuntId).toBe(other.id);
    expect(saved.activeHuntId).toBe(other.id);
    store.setActiveHunt(other.id);
    store.setActiveHunt(null);
    expect(store.getActiveHunt()).toBeNull();
    store.setActiveHunt(huntId);

    expect(drain()).toEqual([
      { type: 'active-hunt-changed', activeHuntId: other.id },
      { type: 'active-hunt-changed', activeHuntId: null },
      { type: 'active-hunt-changed', activeHuntId: huntId },
    ]);
    expect(() => store.setActiveHunt('missing')).toThrow(/Unknown hunt/);
    expect(() => store.setActiveHunt(undefined as unknown as null)).toThrow(/Unknown hunt/);
  });
});

describe('adjustCount and setCount', () => {
  it('increments and decrements with the delta actually applied', () => {
    const { store, drain, huntId } = setupWithHunt();
    expect(store.adjustCount(huntId, 5, 'ui').count).toBe(5);
    expect(store.adjustCount(huntId, -2, 'hotkey-global').count).toBe(3);
    // Clamped at zero: only 3 of the requested 10 can be taken away.
    expect(store.adjustCount(huntId, -10, 'overlay').count).toBe(0);

    expect(huntChanges(drain())).toEqual([
      { kind: 'increment', delta: 5, source: 'ui' },
      { kind: 'decrement', delta: -2, source: 'hotkey-global' },
      { kind: 'decrement', delta: -3, source: 'overlay' },
    ]);
  });

  it('clamps at the maximum', () => {
    const { store, drain, huntId } = setupWithHunt();
    store.setCount(huntId, LIMITS.count.max - 1, 'ui');
    drain();
    expect(store.adjustCount(huntId, 50, 'ui').count).toBe(LIMITS.count.max);
    expect(huntChanges(drain())).toEqual([{ kind: 'increment', delta: 1, source: 'ui' }]);
    expect(store.adjustCount(huntId, Number.MAX_SAFE_INTEGER, 'ui').count).toBe(LIMITS.count.max);
  });

  it('emits nothing and records nothing when the count cannot change', () => {
    const { store, drain, saves, huntId } = setupWithHunt();
    const before = store.getHunt(huntId);
    const savesBefore = saves.hunts;
    expect(store.adjustCount(huntId, -1, 'ui')).toBe(before);
    expect(store.adjustCount(huntId, 0, 'ui')).toBe(before);
    expect(store.setCount(huntId, 0, 'ui')).toBe(before);
    expect(drain()).toEqual([]);
    expect(saves.hunts).toBe(savesBefore);
    expect(store.undo(huntId)).toBeNull();
    expect(store.getState().sessions).toEqual([]);
  });

  it('sets the count with a set-count change', () => {
    const { store, drain, huntId } = setupWithHunt();
    store.adjustCount(huntId, 10, 'ui');
    drain();
    expect(store.setCount(huntId, 4, 'ui').count).toBe(4);
    expect(store.setCount(huntId, -50, 'ui').count).toBe(0);
    expect(store.setCount(huntId, 1e15, 'import').count).toBe(LIMITS.count.max);
    expect(huntChanges(drain())).toEqual([
      { kind: 'set-count', delta: -6, source: 'ui' },
      { kind: 'set-count', delta: -4, source: 'ui' },
      { kind: 'set-count', delta: LIMITS.count.max, source: 'import' },
    ]);
  });

  it('refuses to count on a hunt that is not active', () => {
    const { store, drain, huntId } = setupWithHunt();
    store.completeHunt(huntId);
    drain();
    expect(() => store.adjustCount(huntId, 1, 'ui')).toThrow(
      /Cannot count: hunt "First hunt" is completed/,
    );
    expect(() => store.setCount(huntId, 5, 'ui')).toThrow(/is completed/);
    store.updateHunt(huntId, { status: 'archived' });
    drain();
    expect(() => store.adjustCount(huntId, 1, 'ui')).toThrow(/is archived/);
    expect(drain()).toEqual([]);
  });

  it('rejects malformed deltas, counts, sources and ids', () => {
    const { store, drain, huntId } = setupWithHunt();
    expect(() => store.adjustCount(huntId, 1.5, 'ui')).toThrow(/Invalid count change/);
    expect(() => store.adjustCount(huntId, Number.NaN, 'ui')).toThrow(/Invalid count change/);
    expect(() => store.adjustCount(huntId, '1' as unknown as number, 'ui')).toThrow(
      /Invalid count change/,
    );
    expect(() => store.adjustCount(huntId, Number.POSITIVE_INFINITY, 'ui')).toThrow(
      /Invalid count change/,
    );
    expect(() => store.setCount(huntId, 2.5, 'ui')).toThrow(/Invalid count/);
    expect(() => store.adjustCount(huntId, 1, 'keyboard' as never)).toThrow(
      /Invalid counter source/,
    );
    expect(() => store.adjustCount(huntId, 1, undefined as never)).toThrow(
      /Invalid counter source/,
    );
    expect(() => store.adjustCount('missing', 1, 'ui')).toThrow('Unknown hunt: "missing"');
    expect(() => store.adjustCount({} as unknown as string, 1, 'ui')).toThrow(
      'Unknown hunt: (object)',
    );
    expect(drain()).toEqual([]);
    expect(store.getHunt(huntId)?.count).toBe(0);
  });

  it('replaces objects instead of mutating them', () => {
    const { store, huntId } = setupWithHunt();
    const stateBefore = store.getState();
    const huntBefore = store.getHunt(huntId);
    const snapshot = JSON.stringify(stateBefore);
    const other = store.createHunt({ name: 'Bystander', activate: false });

    store.adjustCount(huntId, 1, 'ui');
    const stateAfter = store.getState();
    expect(stateAfter).not.toBe(stateBefore);
    expect(stateAfter.hunts).not.toBe(stateBefore.hunts);
    expect(store.getHunt(huntId)).not.toBe(huntBefore);
    // Untouched hunts keep their identity, so renderers can skip re-rendering them.
    expect(store.getHunt(other.id)).toBe(other);
    expect(JSON.stringify(stateBefore)).toBe(snapshot);
    expect(huntBefore?.count).toBe(0);
  });
});

describe('phases', () => {
  it('logs a phase and starts a fresh one by default', () => {
    const { store, drain, clock, huntId } = setupWithHunt();
    store.adjustCount(huntId, 120, 'ui');
    drain();
    clock.advance(2_000);
    const { hunt, phase } = store.logPhase(huntId, {
      speciesId: 133,
      speciesName: ' Eevee ',
      spriteUrl: 'https://example.com/eevee.png',
      notes: 'so close',
      source: 'hotkey-global',
    });

    expect(phase).toEqual({
      id: phase.id,
      speciesId: 133,
      speciesName: 'Eevee',
      spriteUrl: 'https://example.com/eevee.png',
      encounters: 120,
      totalEncounters: 120,
      timestamp: new Date(START + 2_000).toISOString(),
      notes: 'so close',
    });
    expect(hunt).toMatchObject({ count: 0, priorCount: 120, phases: [phase] });
    expect(huntTotal(hunt)).toBe(120);
    expect(drain()[0]).toEqual({
      type: 'hunt-changed',
      hunt,
      change: { kind: 'phase-logged', delta: -120, source: 'hotkey-global', phaseId: phase.id },
    });

    store.adjustCount(huntId, 30, 'ui');
    const second = store.logPhase(huntId, { speciesId: null, speciesName: '' });
    expect(second.phase).toMatchObject({
      speciesId: null,
      speciesName: '',
      spriteUrl: null,
      encounters: 30,
      totalEncounters: 150,
      notes: '',
    });
    expect(second.hunt).toMatchObject({ count: 0, priorCount: 150 });
    expect(second.hunt.phases.map((entry) => entry.id)).toEqual([phase.id, second.phase.id]);
    expect(second.phase.id).not.toBe(phase.id);
  });

  it('keeps counting in the same phase when resetCount is false', () => {
    const { store, drain, huntId } = setupWithHunt();
    store.adjustCount(huntId, 40, 'ui');
    drain();
    const { hunt, phase } = store.logPhase(huntId, {
      speciesId: null,
      speciesName: 'Zubat',
      resetCount: false,
    });
    expect(hunt).toMatchObject({ count: 40, priorCount: 0 });
    expect(phase).toMatchObject({ encounters: 40, totalEncounters: 40 });
    expect(huntChanges(drain())[0]).toEqual({
      kind: 'phase-logged',
      delta: 0,
      source: 'ui',
      phaseId: phase.id,
    });
  });

  it('accepts a bare quick-log and coerces a bad sprite URL to null', () => {
    const { store, huntId } = setupWithHunt();
    const quick = store.logPhase(huntId, {} as never);
    expect(quick.phase).toMatchObject({ speciesId: null, speciesName: '', spriteUrl: null });
    const insecure = store.logPhase(huntId, {
      speciesId: 1,
      speciesName: 'Bulbasaur',
      spriteUrl: 'file:///etc/passwd',
    });
    expect(insecure.phase.spriteUrl).toBeNull();
  });

  it('refuses to log on a finished hunt and validates its input', () => {
    const { store, huntId } = setupWithHunt();
    expect(() => store.logPhase(huntId, { speciesId: -4, speciesName: 'x' })).toThrow(
      /Invalid phase: speciesId/,
    );
    expect(() =>
      store.logPhase(huntId, { speciesId: null, speciesName: 5 as unknown as string }),
    ).toThrow(/speciesName/);
    expect(() => store.logPhase('missing', { speciesId: null, speciesName: '' })).toThrow(
      /Unknown hunt/,
    );
    store.completeHunt(huntId);
    expect(() => store.logPhase(huntId, { speciesId: null, speciesName: '' })).toThrow(
      /Cannot log a phase/,
    );
  });

  it('edits a phase', () => {
    const { store, drain, huntId } = setupWithHunt();
    const { phase } = store.logPhase(huntId, {
      speciesId: null,
      speciesName: '',
      spriteUrl: 'https://example.com/a.png',
    });
    drain();
    const next = store.updatePhase(huntId, phase.id, {
      speciesId: 41,
      speciesName: 'Zubat',
      notes: 'cave',
    });
    expect(next.phases[0]).toEqual({
      ...phase,
      speciesId: 41,
      speciesName: 'Zubat',
      notes: 'cave',
    });
    expect(drain()).toEqual([
      {
        type: 'hunt-changed',
        hunt: next,
        change: { kind: 'phase-edited', delta: 0, source: 'ui', phaseId: phase.id },
      },
    ]);

    expect(
      store.updatePhase(huntId, phase.id, { spriteUrl: null }).phases[0]?.spriteUrl,
    ).toBeNull();
    expect(
      store.updatePhase(huntId, phase.id, { speciesId: null }).phases[0]?.speciesId,
    ).toBeNull();
    const untouched = store.getHunt(huntId);
    expect(store.updatePhase(huntId, phase.id, {})).toBe(untouched);
    expect(() => store.updatePhase(huntId, 'missing', { notes: 'x' })).toThrow(
      /Unknown phase: "missing"/,
    );
    expect(() => store.updatePhase(huntId, phase.id, { notes: 1 as unknown as string })).toThrow(
      /Invalid phase changes/,
    );
  });

  it('removes only the log entry and leaves the counts untouched', () => {
    const { store, drain, huntId } = setupWithHunt();
    store.adjustCount(huntId, 10, 'ui');
    const first = store.logPhase(huntId, { speciesId: null, speciesName: 'A' });
    store.adjustCount(huntId, 5, 'ui');
    const second = store.logPhase(huntId, { speciesId: null, speciesName: 'B' });
    drain();

    const next = store.removePhase(huntId, first.phase.id);
    expect(next.phases).toEqual([second.phase]);
    expect(next).toMatchObject({ count: 0, priorCount: 15 });
    expect(drain()).toEqual([
      {
        type: 'hunt-changed',
        hunt: next,
        change: { kind: 'phase-removed', delta: 0, source: 'ui', phaseId: first.phase.id },
      },
    ]);
    expect(() => store.removePhase(huntId, first.phase.id)).toThrow(/Unknown phase/);
  });

  it('caps the number of phases per hunt', () => {
    const { store, huntId } = setupWithHunt({ sessionsEmitIntervalMs: 0 });
    for (let index = 0; index < BOUNDS.phasesPerHunt; index += 1) {
      store.logPhase(huntId, { speciesId: null, speciesName: '' });
    }
    expect(() => store.logPhase(huntId, { speciesId: null, speciesName: '' })).toThrow(
      /maximum of 5000 phases/,
    );
  });
});

describe('completeHunt and reopenHunt', () => {
  it('completes and reopens a hunt', () => {
    const { store, drain, clock, huntId } = setupWithHunt();
    store.updateHunt(huntId, { notes: 'before' });
    drain();
    clock.advance(9_000);
    const completed = store.completeHunt(huntId, { notes: 'Got it at 3am' });
    expect(completed).toMatchObject({
      status: 'completed',
      completedAt: new Date(START + 9_000).toISOString(),
      notes: 'Got it at 3am',
    });
    expect(store.completeHunt(huntId, { notes: 'ignored' })).toBe(completed);

    const reopened = store.reopenHunt(huntId);
    expect(reopened).toMatchObject({ status: 'active', completedAt: null, notes: 'Got it at 3am' });
    expect(store.reopenHunt(huntId)).toBe(reopened);
    expect(store.adjustCount(huntId, 1, 'ui').count).toBe(1);

    expect(huntChanges(drain()).map((change) => change.kind)).toEqual([
      'completed',
      'reopened',
      'increment',
    ]);
  });

  it('keeps the notes when none are given and reopens archived hunts too', () => {
    const { store, huntId } = setupWithHunt();
    store.updateHunt(huntId, { notes: 'kept' });
    expect(store.completeHunt(huntId).notes).toBe('kept');
    store.updateHunt(huntId, { status: 'archived' });
    expect(store.reopenHunt(huntId)).toMatchObject({ status: 'active', completedAt: null });
  });

  it('tells where a completion came from (default: the UI)', () => {
    const { store, drain, huntId } = setupWithHunt();
    drain();
    store.completeHunt(huntId, undefined, 'streamdeck');
    store.reopenHunt(huntId);
    store.completeHunt(huntId);
    expect(
      huntChanges(drain())
        .filter((change) => change.kind === 'completed')
        .map((change) => change.source),
    ).toEqual(['streamdeck', 'ui']);
    store.reopenHunt(huntId);
    expect(() => store.completeHunt(huntId, undefined, 'keyboard' as unknown as 'ui')).toThrow(
      /Invalid counter source/,
    );
  });

  it('validates', () => {
    const { store, huntId } = setupWithHunt();
    expect(() => store.completeHunt('missing')).toThrow(/Unknown hunt/);
    expect(() => store.reopenHunt('missing')).toThrow(/Unknown hunt/);
    expect(() => store.completeHunt(huntId, { notes: 3 as unknown as string })).toThrow(
      /Invalid completion details: notes/,
    );
  });
});

describe('undo', () => {
  it('returns null when there is nothing to undo', () => {
    const { store, drain, huntId } = setupWithHunt();
    expect(store.undo(huntId)).toBeNull();
    expect(drain()).toEqual([]);
    expect(() => store.undo('missing')).toThrow(/Unknown hunt/);
  });

  it('walks back count changes and reports the resulting delta', () => {
    const { store, drain, huntId } = setupWithHunt();
    store.adjustCount(huntId, 5, 'ui');
    store.adjustCount(huntId, -2, 'ui');
    store.setCount(huntId, 40, 'ui');
    drain();

    expect(store.undo(huntId, 'hotkey-global')?.count).toBe(3);
    expect(store.undo(huntId)?.count).toBe(5);
    expect(store.undo(huntId)?.count).toBe(0);
    expect(store.undo(huntId)).toBeNull();
    expect(huntChanges(drain())).toEqual([
      { kind: 'undo', delta: -37, source: 'hotkey-global' },
      { kind: 'undo', delta: 2, source: 'ui' },
      { kind: 'undo', delta: -5, source: 'ui' },
    ]);
  });

  it('reverts a logged phase, restoring the count that was folded away', () => {
    const { store, huntId } = setupWithHunt();
    store.adjustCount(huntId, 77, 'ui');
    store.logPhase(huntId, { speciesId: null, speciesName: 'Oops' });
    const reverted = store.undo(huntId);
    expect(reverted).toMatchObject({ count: 77, priorCount: 0, phases: [] });
  });

  it('reverts phase edits and removals', () => {
    const { store, huntId } = setupWithHunt();
    const { phase } = store.logPhase(huntId, { speciesId: null, speciesName: 'Original' });
    store.updatePhase(huntId, phase.id, { speciesName: 'Edited' });
    store.removePhase(huntId, phase.id);

    expect(store.undo(huntId)?.phases[0]?.speciesName).toBe('Edited');
    expect(store.undo(huntId)?.phases).toEqual([phase]);
    expect(store.undo(huntId)?.phases).toEqual([]);
  });

  it('reverts completion (including overwritten notes) and reopening', () => {
    const { store, drain, huntId } = setupWithHunt();
    store.updateHunt(huntId, { notes: 'original' });
    const completed = store.completeHunt(huntId, { notes: 'celebration' });
    store.reopenHunt(huntId);
    drain();

    expect(store.undo(huntId)).toMatchObject({
      status: 'completed',
      completedAt: completed.completedAt,
      notes: 'celebration',
    });
    expect(store.undo(huntId)).toMatchObject({
      status: 'active',
      completedAt: null,
      notes: 'original',
    });
    expect(huntChanges(drain())).toEqual([
      { kind: 'undo', delta: 0, source: 'ui' },
      { kind: 'undo', delta: 0, source: 'ui' },
    ]);
  });

  it('does not let undo clobber notes edited after completion', () => {
    const { store, huntId } = setupWithHunt();
    store.completeHunt(huntId, { notes: 'celebration' });
    store.updateHunt(huntId, { notes: 'edited later' });
    expect(store.undo(huntId)).toMatchObject({ status: 'active', notes: 'edited later' });
  });

  it('leaves edits made through updateHunt alone', () => {
    const { store, huntId } = setupWithHunt();
    store.adjustCount(huntId, 1, 'ui');
    store.updateHunt(huntId, { name: 'Renamed', step: 3 });
    expect(store.undo(huntId)).toMatchObject({ count: 0, name: 'Renamed', step: 3 });
  });

  it('keeps separate histories per hunt', () => {
    const { store, huntId } = setupWithHunt();
    const other = store.createHunt({ name: 'Other', activate: false });
    store.adjustCount(huntId, 1, 'ui');
    store.adjustCount(other.id, 9, 'ui');
    expect(store.undo(huntId)?.count).toBe(0);
    expect(store.getHunt(other.id)?.count).toBe(9);
    expect(store.undo(other.id)?.count).toBe(0);
  });

  it('remembers at most LIMITS.undoDepth steps', () => {
    const { store, huntId } = setupWithHunt({ sessionsEmitIntervalMs: 0 });
    for (let step = 0; step < LIMITS.undoDepth + 25; step += 1) store.adjustCount(huntId, 1, 'ui');
    let undone = 0;
    while (store.undo(huntId) !== null) undone += 1;
    expect(undone).toBe(LIMITS.undoDepth);
    expect(store.getHunt(huntId)?.count).toBe(25);
  });
});

describe('sessions', () => {
  it('opens a session on the first count change and extends it afterwards', () => {
    const { store, drain, clock, huntId } = setupWithHunt();
    store.updateHunt(huntId, { target: PIKACHU });
    store.setCount(huntId, 100, 'ui');
    store.closeSessions();
    drain();

    clock.advance(10 * MINUTE);
    store.adjustCount(huntId, 1, 'ui');
    const opened = store.getState().sessions[0];
    expect(store.getState().sessions).toHaveLength(2);
    expect(opened).toEqual({
      id: opened?.id,
      huntId,
      huntName: STARTER_HUNT_NAME,
      targetName: 'Pikachu',
      gameId: 'sv',
      methodId: 'full-odds',
      startedAt: new Date(clock.ms).toISOString(),
      endedAt: new Date(clock.ms).toISOString(),
      startCount: 100,
      endCount: 101,
      encounters: 1,
      phasesLogged: 0,
    });
    expect(store.getHunt(huntId)?.elapsedMs).toBe(0);
    expect(types(drain())).toEqual(['hunt-changed', 'sessions-changed']);

    clock.advance(30_000);
    store.adjustCount(huntId, 4, 'ui');
    clock.advance(45_000);
    store.adjustCount(huntId, -1, 'ui');

    const extended = store.getState().sessions[0];
    expect(store.getState().sessions).toHaveLength(2);
    expect(extended).toMatchObject({
      id: opened?.id,
      startedAt: opened?.startedAt,
      endedAt: new Date(clock.ms).toISOString(),
      startCount: 100,
      endCount: 104,
      encounters: 4,
    });
    // Time between activities inside the session is hunting time.
    expect(store.getHunt(huntId)?.elapsedMs).toBe(75_000);
  });

  it('counts logged phases and treats a phase log as activity', () => {
    const { store, clock, huntId } = setupWithHunt();
    store.logPhase(huntId, { speciesId: null, speciesName: 'First thing in the morning' });
    expect(store.getState().sessions[0]).toMatchObject({
      startCount: 0,
      endCount: 0,
      encounters: 0,
      phasesLogged: 1,
    });

    clock.advance(1_000);
    store.adjustCount(huntId, 20, 'ui');
    clock.advance(1_000);
    store.logPhase(huntId, { speciesId: null, speciesName: 'Second' });
    expect(store.getState().sessions).toHaveLength(1);
    // Folding the count into priorCount does not change the hunt total.
    expect(store.getState().sessions[0]).toMatchObject({
      endCount: 20,
      encounters: 20,
      phasesLogged: 2,
    });
    expect(store.getHunt(huntId)?.elapsedMs).toBe(2_000);

    clock.advance(500);
    store.undo(huntId);
    expect(store.getState().sessions[0]).toMatchObject({ endCount: 20, phasesLogged: 1 });
    clock.advance(500);
    store.undo(huntId);
    expect(store.getState().sessions[0]).toMatchObject({
      endCount: 0,
      encounters: 0,
      phasesLogged: 1,
    });
    expect(store.getHunt(huntId)?.elapsedMs).toBe(3_000);
  });

  it('closes the session after the configured idle gap', () => {
    const { store, clock, huntId } = setupWithHunt();
    store.updateSettings({ general: { sessionIdleMinutes: 5 } });
    store.adjustCount(huntId, 1, 'ui');
    clock.advance(5 * MINUTE);
    store.adjustCount(huntId, 1, 'ui');
    expect(store.getState().sessions).toHaveLength(1);
    expect(store.getHunt(huntId)?.elapsedMs).toBe(5 * MINUTE);

    clock.advance(5 * MINUTE + 1);
    store.adjustCount(huntId, 1, 'ui');
    const [newest, oldest] = store.getState().sessions;
    expect(store.getState().sessions).toHaveLength(2);
    expect(oldest).toMatchObject({ startCount: 0, endCount: 2, encounters: 2 });
    expect(oldest?.endedAt).toBe(new Date(START + 5 * MINUTE).toISOString());
    expect(newest).toMatchObject({ startCount: 2, endCount: 3, encounters: 1 });
    // The idle gap is not hunting time.
    expect(store.getHunt(huntId)?.elapsedMs).toBe(5 * MINUTE);
  });

  it('closes the session when another hunt is counted on or selected', () => {
    const { store, drain, clock, huntId } = setupWithHunt();
    const other = store.createHunt({ name: 'Other', activate: false });
    store.adjustCount(huntId, 1, 'ui');
    clock.advance(1_000);
    store.adjustCount(other.id, 1, 'ui');
    expect(store.getState().sessions.map((session) => session.huntId)).toEqual([other.id, huntId]);

    clock.advance(1_000);
    store.adjustCount(huntId, 1, 'ui');
    expect(store.getState().sessions.map((session) => session.huntId)).toEqual([
      huntId,
      other.id,
      huntId,
    ]);
    expect(store.getHunt(huntId)?.elapsedMs).toBe(0);
    drain();

    // Selecting another hunt ends the session even without counting on it.
    store.setActiveHunt(other.id);
    expect(types(drain())).toEqual(['active-hunt-changed', 'sessions-changed']);
    clock.advance(1_000);
    store.adjustCount(huntId, 1, 'ui');
    expect(store.getState().sessions).toHaveLength(4);
  });

  it('closeSessions ends the running session and announces it once', () => {
    const { store, drain, clock, huntId } = setupWithHunt();
    store.adjustCount(huntId, 1, 'ui');
    drain();
    store.closeSessions();
    expect(types(drain())).toEqual(['sessions-changed']);
    store.closeSessions();
    expect(drain()).toEqual([]);

    clock.advance(1_000);
    store.adjustCount(huntId, 1, 'ui');
    expect(store.getState().sessions).toHaveLength(2);
    expect(store.getHunt(huntId)?.elapsedMs).toBe(0);
  });

  it('ends the session when the hunt is completed or removed', () => {
    const { store, drain, clock, huntId } = setupWithHunt();
    store.adjustCount(huntId, 1, 'ui');
    drain();
    store.completeHunt(huntId);
    expect(types(drain())).toEqual(['hunt-changed', 'sessions-changed']);
    store.reopenHunt(huntId);
    clock.advance(1_000);
    store.adjustCount(huntId, 1, 'ui');
    expect(store.getState().sessions).toHaveLength(2);
    drain();

    store.removeHunt(huntId);
    expect(types(drain())).toEqual(['active-hunt-changed', 'hunt-removed', 'sessions-changed']);
    // History outlives the hunt it belongs to.
    expect(store.getState().sessions).toHaveLength(2);
  });

  it('never opens a session for an undo', () => {
    const { store, huntId } = setupWithHunt();
    store.adjustCount(huntId, 5, 'ui');
    store.closeSessions();
    const before = store.getState().sessions;
    store.undo(huntId);
    expect(store.getState().sessions).toBe(before);
    expect(store.getHunt(huntId)?.count).toBe(0);
  });

  it('keeps the list newest first and capped', () => {
    const { store, clock, huntId } = setupWithHunt({ sessionsEmitIntervalMs: 0 });
    store.updateSettings({ general: { sessionIdleMinutes: 1 } });
    for (let index = 0; index < LIMITS.sessions + 5; index += 1) {
      store.adjustCount(huntId, 1, 'ui');
      clock.advance(2 * MINUTE);
    }
    const { sessions } = store.getState();
    expect(sessions).toHaveLength(LIMITS.sessions);
    expect(sessions[0]?.endCount).toBe(LIMITS.sessions + 5);
    expect(sessions[sessions.length - 1]?.startCount).toBe(5);
    expect(new Set(sessions.map((session) => session.id)).size).toBe(LIMITS.sessions);
  });

  it('keeps rapid counting cheap: session events and saves are throttled to about one per second', () => {
    const { store, drain, clock, saves, saved, huntId } = setupWithHunt();
    store.adjustCount(huntId, 1, 'ui');
    drain();
    const sessionSavesBefore = saves.sessions;
    const huntSavesBefore = saves.hunts;

    // Ten presses a second for five seconds.
    for (let press = 0; press < 50; press += 1) {
      clock.advance(100);
      store.adjustCount(huntId, 1, 'hotkey-global');
    }
    const events = drain();
    const sessionEvents = events.filter((event) => event.type === 'sessions-changed');
    expect(events.filter((event) => event.type === 'hunt-changed')).toHaveLength(50);
    expect(sessionEvents.length).toBeGreaterThanOrEqual(4);
    expect(sessionEvents.length).toBeLessThanOrEqual(6);
    expect(saves.sessions - sessionSavesBefore).toBe(sessionEvents.length);
    // Every change is handed to the (debounced) hunt save.
    expect(saves.hunts - huntSavesBefore).toBe(50);

    // Whatever was throttled away is delivered by flushSync before the files are written.
    clock.advance(100);
    store.adjustCount(huntId, 1, 'hotkey-global');
    expect(saved.sessions[0]?.endCount).not.toBe(52);
    store.flushSync();
    expect(saved.sessions[0]?.endCount).toBe(52);
    expect(saves.flushes).toBe(1);
    expect(store.getState().sessions[0]?.endCount).toBe(52);
  });

  it('delivers a throttled session update on its own after the interval', () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const { store, drain, huntId } = setupWithHunt({ now: () => new Date() });
    store.adjustCount(huntId, 1, 'ui');
    vi.advanceTimersByTime(200);
    store.adjustCount(huntId, 1, 'ui');
    expect(types(drain())).toEqual(['hunt-changed', 'sessions-changed', 'hunt-changed']);

    vi.advanceTimersByTime(799);
    expect(drain()).toEqual([]);
    vi.advanceTimersByTime(1);
    const late = drain();
    expect(types(late)).toEqual(['sessions-changed']);
    expect(late[0]).toMatchObject({ sessions: [{ endCount: 2 }] });
  });

  it('survives a clock that jumps backwards', () => {
    const { store, clock, huntId } = setupWithHunt();
    store.adjustCount(huntId, 1, 'ui');
    const endedAt = store.getState().sessions[0]?.endedAt;
    clock.advance(-60 * MINUTE);
    store.adjustCount(huntId, 1, 'ui');
    expect(store.getState().sessions).toHaveLength(1);
    expect(store.getState().sessions[0]?.endedAt).toBe(endedAt);
    expect(store.getHunt(huntId)?.elapsedMs).toBe(0);
  });
});

describe('settings', () => {
  it('merges per section and emits settings-changed', () => {
    const { store, drain, saves } = setupWithHunt();
    const defaults = createDefaultSettings();
    const next = store.updateSettings({ audio: { volume: 0.2 }, overlay: { clickThrough: true } });

    expect(next.audio).toEqual({ ...defaults.audio, volume: 0.2 });
    expect(next.overlay).toEqual({ ...defaults.overlay, clickThrough: true });
    expect(next.hotkeys).toEqual(defaults.hotkeys);
    expect(next.general).toEqual(defaults.general);
    expect(store.getState().settings).toBe(next);
    expect(saves.settings).toBe(1);
    expect(drain()).toEqual([{ type: 'settings-changed', settings: next }]);
  });

  it('clamps numeric values', () => {
    const { store } = setupWithHunt();
    const next = store.updateSettings({
      audio: { volume: 4 },
      overlay: { opacity: -1, scale: 10 },
      general: { sessionIdleMinutes: 0 },
    });
    expect(next.audio.volume).toBe(1);
    expect(next.overlay.opacity).toBe(LIMITS.overlayOpacity.min);
    expect(next.overlay.scale).toBe(LIMITS.overlayScale.max);
    expect(next.general.sessionIdleMinutes).toBe(LIMITS.sessionIdleMinutes.min);
    expect(store.updateSettings({ audio: { volume: -3 } }).audio.volume).toBe(0);
  });

  it('replaces bindings per action, trimming and de-duplicating them', () => {
    const { store } = setupWithHunt();
    const defaults = createDefaultSettings();
    const next = store.updateSettings({
      hotkeys: {
        bindings: { increment: ['  Space ', 'space', 'F13', ''], undo: ['CommandOrControl+Z'] },
      },
    });
    expect(next.hotkeys.bindings).toEqual({
      ...defaults.hotkeys.bindings,
      increment: ['Space', 'F13'],
      undo: ['CommandOrControl+Z'],
    });
    expect(next.hotkeys.globalEnabled).toBe(true);

    const cleared = store.updateSettings({
      hotkeys: { globalEnabled: false, bindings: { increment: [] } },
    });
    expect(cleared.hotkeys.bindings.increment).toEqual([]);
    expect(cleared.hotkeys.bindings.undo).toEqual(['CommandOrControl+Z']);
    expect(cleared.hotkeys.globalEnabled).toBe(false);
  });

  it('accepts accelerators the OS might refuse — that is reported elsewhere', () => {
    const { store } = setupWithHunt();
    const next = store.updateSettings({
      hotkeys: { bindings: { logPhase: ['Definitely+Not+A+Key'] } },
    });
    expect(next.hotkeys.bindings.logPhase).toEqual(['Definitely+Not+A+Key']);
  });

  it('rejects invalid patches and leaves the settings untouched', () => {
    const { store, drain } = setupWithHunt();
    const before = store.getState().settings;
    const tooMany = Array.from(
      { length: MAX_BINDINGS_PER_ACTION + 1 },
      (_, index) => `F${index + 1}`,
    );
    expect(() => store.updateSettings({ hotkeys: { bindings: { increment: tooMany } } })).toThrow(
      /at most 3 shortcuts per action/,
    );
    expect(() =>
      store.updateSettings({ hotkeys: { bindings: { increment: ['x'.repeat(200)] } } }),
    ).toThrow(/too long/);
    expect(() => store.updateSettings({ audio: { pack: 'kazoo' as never } })).toThrow(
      /audio\.pack: expected one of sonar, bubble, click, chime/,
    );
    expect(() => store.updateSettings({ audio: { volume: '1' as unknown as number } })).toThrow(
      /Invalid settings: audio\.volume/,
    );
    expect(() => store.updateSettings({ general: { reducedMotion: 'maybe' as never } })).toThrow(
      /general\.reducedMotion/,
    );
    expect(() => store.updateSettings(null as never)).toThrow(/Invalid settings/);
    expect(store.getState().settings).toBe(before);
    expect(drain()).toEqual([]);
  });

  it('ignores unknown keys and empty patches', () => {
    const { store, drain } = setupWithHunt();
    const before = store.getState().settings;
    expect(store.updateSettings({})).toBe(before);
    const next = store.updateSettings({
      audio: { volume: 0.3, bogus: 1 } as never,
      hotkeys: { bindings: { selfDestruct: ['F12'] } } as never,
    });
    expect(next.audio).not.toHaveProperty('bogus');
    expect(next.hotkeys.bindings).not.toHaveProperty('selfDestruct');
    expect(types(drain())).toEqual(['settings-changed']);
  });

  it('resets to the defaults', () => {
    const { store, drain } = setupWithHunt();
    store.updateSettings({
      audio: { enabled: false },
      hotkeys: { bindings: { increment: ['F1'] } },
    });
    drain();
    const next = store.resetSettings();
    expect(next).toEqual(createDefaultSettings());
    expect(drain()).toEqual([{ type: 'settings-changed', settings: next }]);
  });
});

describe('replaceState', () => {
  it('swaps the state, clears undo history and the running session, and saves everything', () => {
    const { store, drain, clock, saves, huntId } = setupWithHunt();
    store.adjustCount(huntId, 5, 'ui');
    drain();
    const replacement: AppState = {
      ...store.getState(),
      hunts: store.getState().hunts.map((hunt) => ({ ...hunt, name: 'Imported', count: 9 })),
    };
    const savesBefore = { ...saves };
    store.replaceState(replacement);

    expect(store.getState()).toEqual(replacement);
    expect(drain()).toEqual([{ type: 'state-replaced', state: store.getState() }]);
    expect(saves.settings).toBe(savesBefore.settings + 1);
    expect(saves.hunts).toBe(savesBefore.hunts + 1);
    expect(saves.sessions).toBe(savesBefore.sessions + 1);
    expect(store.undo(huntId)).toBeNull();

    clock.advance(1_000);
    store.adjustCount(huntId, 1, 'ui');
    // The pre-import session is not extended.
    expect(store.getState().sessions).toHaveLength(2);
  });

  it('sanitises what it is given', () => {
    const { store } = setupWithHunt();
    const hostile = {
      settings: { audio: { volume: 50 } },
      hunts: [{ id: 'x', name: 'Loose', count: -1, phases: 'nope', extra: true }, 'junk'],
      activeHuntId: 'nobody',
      sessions: null,
    };
    store.replaceState(hostile as unknown as AppState);
    const state = store.getState();
    expect(state.settings.audio.volume).toBe(1);
    expect(state.hunts).toHaveLength(1);
    expect(state.hunts[0]).toMatchObject({ id: 'x', count: 0, phases: [] });
    expect(state.hunts[0]).not.toHaveProperty('extra');
    expect(state.activeHuntId).toBe('x');
    expect(state.sessions).toEqual([]);
    expect(() => store.replaceState(null as unknown as AppState)).toThrow(/Invalid state/);
  });
});

describe('subscribers', () => {
  it('stops delivering after unsubscribe', () => {
    const { store, huntId } = setupWithHunt();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.adjustCount(huntId, 1, 'ui');
    const calls = listener.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    unsubscribe();
    unsubscribe();
    store.adjustCount(huntId, 1, 'ui');
    expect(listener).toHaveBeenCalledTimes(calls);
  });

  it('isolates a throwing subscriber', () => {
    const onListenerError = vi.fn();
    const { store, events, huntId } = setupWithHunt({ onListenerError });
    store.subscribe(() => {
      throw new Error('renderer went away');
    });
    const healthy = vi.fn();
    store.subscribe(healthy);

    expect(store.adjustCount(huntId, 1, 'ui').count).toBe(1);
    expect(healthy).toHaveBeenCalled();
    expect(events.length).toBeGreaterThan(0);
    expect(onListenerError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'renderer went away' }),
    );
  });

  it('delivers events in mutation order even when a subscriber mutates the store', () => {
    const { store, huntId } = setupWithHunt({ sessionsEmitIntervalMs: 60_000 });
    store.adjustCount(huntId, 1, 'ui');
    const seen: number[] = [];
    store.subscribe((event) => {
      if (event.type !== 'hunt-changed') return;
      seen.push(event.hunt.count);
      if (event.hunt.count === 2) store.adjustCount(huntId, 10, 'system');
    });
    const late: number[] = [];
    store.subscribe((event) => {
      if (event.type === 'hunt-changed') late.push(event.hunt.count);
    });
    store.adjustCount(huntId, 1, 'ui');
    expect(seen).toEqual([2, 12]);
    expect(late).toEqual([2, 12]);
  });
});

describe('with real storage', () => {
  it('persists across restarts', () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'biolume-store-'));
    try {
      const storage = createStorage(dir);
      const store = createAppStore(storage);
      const huntId = store.getState().activeHuntId ?? '';
      store.adjustCount(huntId, 42, 'ui');
      const { phase } = store.logPhase(huntId, { speciesId: 16, speciesName: 'Pidgey' });
      store.adjustCount(huntId, 7, 'ui');
      store.updateSettings({ audio: { pack: 'bubble' } });
      store.closeSessions();
      store.flushSync();
      const before = store.getState();

      const reopened = createAppStore(createStorage(dir));
      expect(reopened.getState()).toEqual(before);
      expect(reopened.getState().hunts[0]).toMatchObject({
        count: 7,
        priorCount: 42,
        phases: [phase],
      });
      expect(reopened.getState().sessions).toHaveLength(1);
      expect(reopened.getState().sessions[0]).toMatchObject({
        startCount: 0,
        endCount: 49,
        encounters: 49,
        phasesLogged: 1,
      });
      expect(reopened.getState().settings.audio.pack).toBe('bubble');
      // Undo history is deliberately in-memory only.
      expect(reopened.undo(huntId)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('saves the starter hunt so a first launch survives an immediate quit', () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'biolume-store-'));
    try {
      const store = createAppStore(createStorage(dir));
      store.flushSync();
      const again = createAppStore(createStorage(dir));
      expect(again.getState().hunts).toEqual(store.getState().hunts);
      expect(again.getState().activeHuntId).toBe(store.getState().activeHuntId);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('id generation', () => {
  it('retries a generator that returns a used id', () => {
    const queue = ['starter', 'starter', 'starter', 'second'];
    const { store } = setup(emptyState(), { idGenerator: () => queue.shift() ?? 'exhausted' });
    expect(store.getState().hunts[0]?.id).toBe('starter');
    expect(store.createHunt({ name: 'Second' }).id).toBe('second');
  });

  it('fails atomically when no usable id can be generated', () => {
    let broken = false;
    let next = 0;
    const { store, drain, huntId } = setupWithHunt({
      idGenerator: () => (broken ? 'not a valid id!' : `id-${(next += 1)}`),
    });
    const before = store.getState();
    broken = true;

    // Opening a session needs an id, so the count change as a whole is refused.
    expect(() => store.adjustCount(huntId, 1, 'ui')).toThrow(/Could not generate a unique id/);
    expect(() => store.logPhase(huntId, { speciesId: null, speciesName: '' })).toThrow(
      /Could not generate a unique id/,
    );
    expect(() => store.createHunt({ name: 'Nope' })).toThrow(/Could not generate a unique id/);
    expect(store.getState()).toBe(before);
    expect(store.undo(huntId)).toBeNull();
    expect(drain()).toEqual([]);

    broken = false;
    expect(store.adjustCount(huntId, 1, 'ui').count).toBe(1);
  });
});
