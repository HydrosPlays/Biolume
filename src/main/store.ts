/**
 * The single source of truth for {@link AppState} in the main process.
 *
 * Every mutation validates its input, replaces the affected objects (state is
 * never mutated in place, so renderers can rely on reference changes), persists
 * through the storage layer and announces itself with a {@link StateEvent}.
 *
 * Events per mutation, in order:
 *   createHunt       hunt-changed(created) [, active-hunt-changed]
 *   updateHunt       hunt-changed(edited)
 *   removeHunt       [active-hunt-changed,] hunt-removed
 *   setActiveHunt    active-hunt-changed
 *   adjustCount      hunt-changed(increment | decrement)
 *   setCount         hunt-changed(set-count)
 *   logPhase         hunt-changed(phase-logged)
 *   updatePhase      hunt-changed(phase-edited)
 *   removePhase      hunt-changed(phase-removed)
 *   completeHunt     hunt-changed(completed)
 *   reopenHunt       hunt-changed(reopened)
 *   undo             hunt-changed(undo)
 *   updateSettings   settings-changed
 *   resetSettings    settings-changed
 *   replaceState     state-replaced
 * Any of them may be followed by one `sessions-changed` when it opened, closed
 * or (throttled) extended a session. A call that changes nothing emits nothing.
 *
 * This module must stay free of `electron` imports so it can be unit-tested.
 */
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_TARGET_LEVEL,
  LIMITS,
  createDefaultOddsSelection,
  createDefaultSettings,
} from '@shared/defaults';
import {
  huntTotal,
  type AppState,
  type CompleteHuntInput,
  type CounterSource,
  type CreateHuntInput,
  type Hunt,
  type HuntChangeKind,
  type HuntPatch,
  type HuntStatus,
  type ISODateString,
  type LogPhaseInput,
  type OddsSelection,
  type PhaseEntry,
  type PhasePatch,
  type Settings,
  type SettingsPatch,
  type StateEvent,
  type TargetRef,
} from '@shared/types';
import { recordActivity, type OpenSession } from './sessions';
import type { Storage } from './storage';
import {
  BOUNDS,
  clamp,
  inputSchemas,
  isValidId,
  mergeSettings,
  parseInput,
  pickFallbackActiveHunt,
  resolveHuntName,
  sanitizeAppState,
  truncate,
} from './validation';

/** Created on a first launch so the counter and hotkeys work immediately. */
export const STARTER_HUNT_NAME = 'First hunt';

const DEFAULT_SESSIONS_EMIT_INTERVAL_MS = 1_000;

/** What the store needs from the storage layer. */
export type StatePersistence = Pick<
  Storage,
  'loadState' | 'saveSettings' | 'saveHunts' | 'saveSessions' | 'flushSync'
>;

export interface AppStoreOptions {
  /** Clock for timestamps, session gaps and event throttling (default: system clock). */
  now?: () => Date;
  /** Ids for hunts, phases and sessions; must satisfy `isValidId` (default: `randomUUID`). */
  idGenerator?: () => string;
  /** Minimum spacing of `sessions-changed` events while counting (default 1000 ms). */
  sessionsEmitIntervalMs?: number;
  /** Receives exceptions thrown by subscribers; they never reach the caller of a mutation. */
  onListenerError?: (error: unknown) => void;
}

export interface AppStore {
  /** The current state. The same object is returned until something changes. */
  getState(): AppState;
  getHunt(id: string): Hunt | null;
  getActiveHunt(): Hunt | null;
  subscribe(listener: (event: StateEvent) => void): () => void;

  createHunt(input: CreateHuntInput): Hunt;
  updateHunt(id: string, patch: HuntPatch): Hunt;
  removeHunt(id: string): void;
  setActiveHunt(id: string | null): void;
  /** Adds `delta` to the current-phase count, clamped to `LIMITS.count`. Throws unless the hunt is active. */
  adjustCount(id: string, delta: number, source: CounterSource): Hunt;
  setCount(id: string, count: number, source: CounterSource): Hunt;
  logPhase(id: string, input: LogPhaseInput): { hunt: Hunt; phase: PhaseEntry };
  updatePhase(id: string, phaseId: string, patch: PhasePatch): Hunt;
  /** Deletes the log entry only; counts stay as they are. */
  removePhase(id: string, phaseId: string): Hunt;
  /** Marks the hunt completed; `source` (default `ui`) travels in the `hunt-changed` event. */
  completeHunt(id: string, input?: CompleteHuntInput, source?: CounterSource): Hunt;
  reopenHunt(id: string): Hunt;
  /** Reverts the hunt's latest count / phase / completion change; null when there is nothing to undo. */
  undo(id: string, source?: CounterSource): Hunt | null;

  updateSettings(patch: SettingsPatch): Settings;
  resetSettings(): Settings;

  /** Swaps in a whole new state (after an import). Clears undo history and the open session. */
  replaceState(state: AppState): void;
  /** Ends the running session (call on quit, before `flushSync`). */
  closeSessions(): void;
  /** Writes everything pending to disk synchronously. */
  flushSync(): void;
}

export interface HuntSeed {
  id: string;
  /** Creation time. */
  at: Date;
  name?: string | undefined;
  target?: TargetRef | null | undefined;
  targetLevel?: number | undefined;
  odds?: OddsSelection | undefined;
  step?: number | undefined;
  notes?: string | undefined;
}

/** A fresh hunt with zero progress. The seed must already be validated. */
export function createHuntRecord(seed: HuntSeed): Hunt {
  const iso = seed.at.toISOString();
  const target = seed.target ?? null;
  return {
    id: seed.id,
    name: resolveHuntName(seed.name, target),
    status: 'active',
    target,
    targetLevel: seed.targetLevel ?? DEFAULT_TARGET_LEVEL,
    odds: seed.odds ?? createDefaultOddsSelection(),
    count: 0,
    priorCount: 0,
    step: seed.step ?? 1,
    phases: [],
    notes: seed.notes ?? '',
    createdAt: iso,
    updatedAt: iso,
    completedAt: null,
    elapsedMs: 0,
  };
}

/** What `undo` restores. `notes` is only captured by mutations that overwrite the notes. */
interface UndoSnapshot {
  count: number;
  priorCount: number;
  phases: PhaseEntry[];
  status: HuntStatus;
  completedAt: ISODateString | null;
  notes?: string;
}

/** How a mutation touched the session list. */
interface SessionEffect {
  gapMs: number;
  /** The list changed and should be announced (throttled). */
  changed: boolean;
  /** A session opened or closed — announce immediately. */
  boundary: boolean;
}

const NO_SESSION_EFFECT: SessionEffect = { gapMs: 0, changed: false, boundary: false };

function describeId(id: unknown): string {
  return typeof id === 'string'
    ? `"${truncate(id, BOUNDS.idLength)}"`
    : `(${id === null ? 'null' : typeof id})`;
}

export function createAppStore(storage: StatePersistence, options: AppStoreOptions = {}): AppStore {
  const generateId = options.idGenerator ?? randomUUID;
  const sessionsEmitIntervalMs = Math.max(
    0,
    options.sessionsEmitIntervalMs ?? DEFAULT_SESSIONS_EMIT_INTERVAL_MS,
  );

  const listeners = new Set<(event: StateEvent) => void>();
  const eventQueue: StateEvent[] = [];
  let dispatching = false;

  const undoStacks = new Map<string, UndoSnapshot[]>();
  let openSession: OpenSession | null = null;
  let sessionsDirty = false;
  let sessionsTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSessionsEmitMs = Number.NEGATIVE_INFINITY;

  const readClock = (): Date => {
    const at = options.now?.() ?? new Date();
    return at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date();
  };

  const nextId = (isTaken: (id: string) => boolean): string => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = generateId();
      if (isValidId(id) && !isTaken(id)) return id;
    }
    throw new Error(
      'Could not generate a unique id — the id generator keeps returning invalid or used ids',
    );
  };

  let state: AppState = storage.loadState();
  if (state.hunts.length === 0) {
    const starter = createHuntRecord({
      id: nextId(() => false),
      at: readClock(),
      name: STARTER_HUNT_NAME,
    });
    state = { ...state, hunts: [starter], activeHuntId: starter.id };
    storage.saveHunts(state.hunts, state.activeHuntId);
  }

  // ───────────────────────────── Events ─────────────────────────────

  /** Queued so that a listener which mutates the store cannot reorder events. */
  const emit = (event: StateEvent): void => {
    eventQueue.push(event);
    if (dispatching) return;
    dispatching = true;
    try {
      for (let next = eventQueue.shift(); next !== undefined; next = eventQueue.shift()) {
        for (const listener of [...listeners]) {
          try {
            listener(next);
          } catch (error) {
            try {
              options.onListenerError?.(error);
            } catch {
              // A failing error handler must not break dispatch either.
            }
          }
        }
      }
    } finally {
      dispatching = false;
    }
  };

  // ───────────────────────────── Hunts ─────────────────────────────

  const locate = (id: unknown): { hunt: Hunt; index: number } => {
    if (typeof id === 'string') {
      const index = state.hunts.findIndex((hunt) => hunt.id === id);
      const hunt = state.hunts[index];
      if (hunt !== undefined) return { hunt, index };
    }
    throw new Error(`Unknown hunt: ${describeId(id)}`);
  };

  const locatePhase = (hunt: Hunt, phaseId: unknown): { phase: PhaseEntry; index: number } => {
    if (typeof phaseId === 'string') {
      const index = hunt.phases.findIndex((phase) => phase.id === phaseId);
      const phase = hunt.phases[index];
      if (phase !== undefined) return { phase, index };
    }
    throw new Error(`Unknown phase: ${describeId(phaseId)} in hunt "${hunt.name}"`);
  };

  const putHunt = (index: number, hunt: Hunt): void => {
    const hunts = state.hunts.slice();
    hunts[index] = hunt;
    state = { ...state, hunts };
  };

  const saveHunts = (): void => storage.saveHunts(state.hunts, state.activeHuntId);

  const requireCountable = (hunt: Hunt, action: string): void => {
    if (hunt.status !== 'active') {
      throw new Error(`Cannot ${action}: hunt "${hunt.name}" is ${hunt.status} — reopen it first`);
    }
  };

  const announce = (
    hunt: Hunt,
    kind: HuntChangeKind,
    delta: number,
    source: CounterSource,
    phaseId?: string,
  ): void => {
    emit({
      type: 'hunt-changed',
      hunt,
      change: phaseId === undefined ? { kind, delta, source } : { kind, delta, source, phaseId },
    });
  };

  // ───────────────────────────── Undo ─────────────────────────────

  const remember = (hunt: Hunt, extra?: { notes: string }): void => {
    const stack = undoStacks.get(hunt.id) ?? [];
    const snapshot: UndoSnapshot = {
      count: hunt.count,
      priorCount: hunt.priorCount,
      phases: hunt.phases,
      status: hunt.status,
      completedAt: hunt.completedAt,
    };
    if (extra !== undefined) snapshot.notes = extra.notes;
    stack.push(snapshot);
    if (stack.length > LIMITS.undoDepth) stack.splice(0, stack.length - LIMITS.undoDepth);
    undoStacks.set(hunt.id, stack);
  };

  // ───────────────────────────── Sessions ─────────────────────────────

  const flushSessions = (): void => {
    if (sessionsTimer !== null) clearTimeout(sessionsTimer);
    sessionsTimer = null;
    sessionsDirty = false;
    lastSessionsEmitMs = readClock().getTime();
    storage.saveSessions(state.sessions);
    emit({ type: 'sessions-changed', sessions: state.sessions });
  };

  /** Announces (and saves) the session list now, or coalesces it into the next throttle slot. */
  const publishSessions = (effect: SessionEffect, forceNow = false): void => {
    if (forceNow || effect.boundary) {
      flushSessions();
      return;
    }
    if (!effect.changed) return;
    const sinceLast = readClock().getTime() - lastSessionsEmitMs;
    // A negative gap means the clock went backwards; do not stall on it.
    if (sinceLast >= sessionsEmitIntervalMs || sinceLast < 0) {
      flushSessions();
      return;
    }
    sessionsDirty = true;
    if (sessionsTimer === null) {
      sessionsTimer = setTimeout(() => {
        sessionsTimer = null;
        if (sessionsDirty) flushSessions();
      }, sessionsEmitIntervalMs - sinceLast);
      // Housekeeping only — it must not keep the process alive.
      sessionsTimer.unref();
    }
  };

  /** Folds counter activity on `hunt` (its pre-change value) into the session list. */
  const trackActivity = (
    hunt: Hunt,
    totalAfter: number,
    at: Date,
    phasesDelta: number,
    canOpen: boolean,
  ): SessionEffect => {
    const result = recordActivity(state.sessions, openSession, {
      hunt,
      totalBefore: huntTotal(hunt),
      totalAfter,
      phasesDelta,
      at,
      idleMs: state.settings.general.sessionIdleMinutes * 60_000,
      canOpen,
      newId: () => nextId((id) => state.sessions.some((session) => session.id === id)),
    });
    const changed = result.sessions !== state.sessions;
    openSession = result.open;
    if (changed) state = { ...state, sessions: result.sessions };
    return { gapMs: result.gapMs, changed, boundary: result.opened || result.closed };
  };

  /** Stops extending the running session if it belongs to `huntId`. */
  const endSessionOf = (huntId: string): boolean => {
    if (openSession?.huntId !== huntId) return false;
    openSession = null;
    return true;
  };

  const addElapsed = (elapsedMs: number, gapMs: number): number =>
    clamp(elapsedMs + gapMs, 0, BOUNDS.elapsedMs);

  // ───────────────────────────── Count changes ─────────────────────────────

  const applyCount = (
    index: number,
    hunt: Hunt,
    nextCount: number,
    source: CounterSource,
    fixedKind: 'set-count' | null,
  ): Hunt => {
    const delta = nextCount - hunt.count;
    if (delta === 0) return hunt;
    const at = readClock();
    // Session tracking is the only step that can still throw (id generation), so it goes first.
    const effect = trackActivity(hunt, hunt.priorCount + nextCount, at, 0, true);
    remember(hunt);
    const next: Hunt = {
      ...hunt,
      count: nextCount,
      updatedAt: at.toISOString(),
      elapsedMs: addElapsed(hunt.elapsedMs, effect.gapMs),
    };
    putHunt(index, next);
    saveHunts();
    announce(next, fixedKind ?? (delta > 0 ? 'increment' : 'decrement'), delta, source);
    publishSessions(effect);
    return next;
  };

  // ───────────────────────────── Public API ─────────────────────────────

  return {
    getState: () => state,

    getHunt: (id) => state.hunts.find((hunt) => hunt.id === id) ?? null,

    getActiveHunt: () =>
      state.activeHuntId === null
        ? null
        : (state.hunts.find((hunt) => hunt.id === state.activeHuntId) ?? null),

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    createHunt(input) {
      const seed = parseInput(inputSchemas.createHunt, input ?? {}, 'hunt');
      if (state.hunts.length >= BOUNDS.hunts)
        throw new Error(`Cannot keep more than ${BOUNDS.hunts} hunts`);
      const hunt = createHuntRecord({
        id: nextId((id) => state.hunts.some((existing) => existing.id === id)),
        at: readClock(),
        name: seed.name,
        target: seed.target,
        targetLevel: seed.targetLevel,
        odds: seed.odds,
        step: seed.step,
        notes: seed.notes,
      });
      const activate = seed.activate !== false;
      // Switching hunts ends the session that was running on the previous one.
      const sessionEnded = activate && openSession !== null;
      if (sessionEnded) openSession = null;
      state = {
        ...state,
        hunts: [...state.hunts, hunt],
        activeHuntId: activate ? hunt.id : state.activeHuntId,
      };
      saveHunts();
      announce(hunt, 'created', 0, 'ui');
      if (activate) emit({ type: 'active-hunt-changed', activeHuntId: hunt.id });
      if (sessionEnded) flushSessions();
      return hunt;
    },

    updateHunt(id, patch) {
      const changes = parseInput(inputSchemas.huntPatch, patch, 'hunt changes');
      const { hunt, index } = locate(id);
      if (!Object.values(changes).some((value) => value !== undefined)) return hunt;

      const iso = readClock().toISOString();
      const target = changes.target === undefined ? hunt.target : changes.target;
      const status = changes.status ?? hunt.status;
      let completedAt = hunt.completedAt;
      if (status !== hunt.status) {
        // A status edit is a completion-style change, so `undo` can take it back.
        remember(hunt);
        if (status === 'completed') completedAt = hunt.completedAt ?? iso;
        else if (status === 'active') completedAt = null;
      }
      if (changes.notes !== undefined) {
        // Notes edited by hand outrank the copy an earlier `completeHunt` saved for undo.
        for (const snapshot of undoStacks.get(hunt.id) ?? []) delete snapshot.notes;
      }
      const next: Hunt = {
        ...hunt,
        name: changes.name === undefined ? hunt.name : resolveHuntName(changes.name, target),
        target,
        targetLevel: changes.targetLevel ?? hunt.targetLevel,
        odds: changes.odds ?? hunt.odds,
        step: changes.step ?? hunt.step,
        notes: changes.notes ?? hunt.notes,
        status,
        completedAt,
        updatedAt: iso,
      };
      putHunt(index, next);
      saveHunts();
      const sessionEnded = status !== 'active' && endSessionOf(hunt.id);
      announce(next, 'edited', 0, 'ui');
      if (sessionEnded) flushSessions();
      return next;
    },

    removeHunt(id) {
      const { hunt, index } = locate(id);
      const hunts = state.hunts.filter((_, position) => position !== index);
      const wasActive = state.activeHuntId === hunt.id;
      const activeHuntId = wasActive ? pickFallbackActiveHunt(hunts) : state.activeHuntId;
      undoStacks.delete(hunt.id);
      const sessionEnded = endSessionOf(hunt.id);
      state = { ...state, hunts, activeHuntId };
      saveHunts();
      // Announce the new selection first so no window is left pointing at a removed hunt.
      if (wasActive) emit({ type: 'active-hunt-changed', activeHuntId });
      emit({ type: 'hunt-removed', huntId: hunt.id });
      if (sessionEnded) flushSessions();
    },

    setActiveHunt(id) {
      if (id !== null) locate(id);
      if (id === state.activeHuntId) return;
      const sessionEnded = openSession !== null && openSession.huntId !== id;
      if (sessionEnded) openSession = null;
      state = { ...state, activeHuntId: id };
      saveHunts();
      emit({ type: 'active-hunt-changed', activeHuntId: id });
      if (sessionEnded) flushSessions();
    },

    adjustCount(id, delta, source) {
      const amount = parseInput(inputSchemas.delta, delta, 'count change');
      const origin = parseInput(inputSchemas.counterSource, source, 'counter source');
      const { hunt, index } = locate(id);
      requireCountable(hunt, 'count');
      const nextCount = clamp(hunt.count + amount, LIMITS.count.min, LIMITS.count.max);
      return applyCount(index, hunt, nextCount, origin, null);
    },

    setCount(id, count, source) {
      const nextCount = parseInput(inputSchemas.count, count, 'count');
      const origin = parseInput(inputSchemas.counterSource, source, 'counter source');
      const { hunt, index } = locate(id);
      requireCountable(hunt, 'set the count');
      return applyCount(index, hunt, nextCount, origin, 'set-count');
    },

    logPhase(id, input) {
      const details = parseInput(inputSchemas.logPhase, input ?? {}, 'phase');
      const { hunt, index } = locate(id);
      requireCountable(hunt, 'log a phase');
      if (hunt.phases.length >= BOUNDS.phasesPerHunt) {
        throw new Error(
          `Hunt "${hunt.name}" already has the maximum of ${BOUNDS.phasesPerHunt} phases`,
        );
      }
      const at = readClock();
      const iso = at.toISOString();
      const phase: PhaseEntry = {
        id: nextId((candidate) => hunt.phases.some((existing) => existing.id === candidate)),
        speciesId: details.speciesId,
        speciesName: details.speciesName,
        spriteUrl: details.spriteUrl,
        encounters: hunt.count,
        totalEncounters: huntTotal(hunt),
        timestamp: iso,
        notes: details.notes,
      };
      const startFresh = details.resetCount !== false;
      // Folding the count into priorCount leaves the hunt total where it was.
      const effect = trackActivity(hunt, huntTotal(hunt), at, 1, true);
      remember(hunt);
      const next: Hunt = {
        ...hunt,
        phases: [...hunt.phases, phase],
        priorCount: startFresh
          ? clamp(hunt.priorCount + hunt.count, 0, BOUNDS.priorCount)
          : hunt.priorCount,
        count: startFresh ? 0 : hunt.count,
        updatedAt: iso,
        elapsedMs: addElapsed(hunt.elapsedMs, effect.gapMs),
      };
      putHunt(index, next);
      saveHunts();
      announce(next, 'phase-logged', next.count - hunt.count, details.source ?? 'ui', phase.id);
      publishSessions(effect);
      return { hunt: next, phase };
    },

    updatePhase(id, phaseId, patch) {
      const changes = parseInput(inputSchemas.phasePatch, patch, 'phase changes');
      const { hunt, index } = locate(id);
      const { phase, index: phaseIndex } = locatePhase(hunt, phaseId);
      if (!Object.values(changes).some((value) => value !== undefined)) return hunt;
      remember(hunt);
      const phases = hunt.phases.slice();
      phases[phaseIndex] = {
        ...phase,
        speciesId: changes.speciesId === undefined ? phase.speciesId : changes.speciesId,
        speciesName: changes.speciesName ?? phase.speciesName,
        spriteUrl: changes.spriteUrl === undefined ? phase.spriteUrl : changes.spriteUrl,
        notes: changes.notes ?? phase.notes,
      };
      const next: Hunt = { ...hunt, phases, updatedAt: readClock().toISOString() };
      putHunt(index, next);
      saveHunts();
      announce(next, 'phase-edited', 0, 'ui', phase.id);
      return next;
    },

    removePhase(id, phaseId) {
      const { hunt, index } = locate(id);
      const { phase, index: phaseIndex } = locatePhase(hunt, phaseId);
      remember(hunt);
      const next: Hunt = {
        ...hunt,
        phases: hunt.phases.filter((_, position) => position !== phaseIndex),
        updatedAt: readClock().toISOString(),
      };
      putHunt(index, next);
      saveHunts();
      announce(next, 'phase-removed', 0, 'ui', phase.id);
      return next;
    },

    completeHunt(id, input, source = 'ui') {
      const details = parseInput(inputSchemas.completeHunt, input ?? {}, 'completion details');
      const origin = parseInput(inputSchemas.counterSource, source, 'counter source');
      const { hunt, index } = locate(id);
      if (hunt.status === 'completed') return hunt;
      const iso = readClock().toISOString();
      remember(hunt, details.notes === undefined ? undefined : { notes: hunt.notes });
      const next: Hunt = {
        ...hunt,
        status: 'completed',
        completedAt: iso,
        notes: details.notes ?? hunt.notes,
        updatedAt: iso,
      };
      putHunt(index, next);
      saveHunts();
      const sessionEnded = endSessionOf(hunt.id);
      announce(next, 'completed', 0, origin);
      if (sessionEnded) flushSessions();
      return next;
    },

    reopenHunt(id) {
      const { hunt, index } = locate(id);
      if (hunt.status === 'active') return hunt;
      remember(hunt);
      const next: Hunt = {
        ...hunt,
        status: 'active',
        completedAt: null,
        updatedAt: readClock().toISOString(),
      };
      putHunt(index, next);
      saveHunts();
      announce(next, 'reopened', 0, 'ui');
      return next;
    },

    undo(id, source = 'ui') {
      const origin = parseInput(inputSchemas.counterSource, source, 'counter source');
      const { hunt, index } = locate(id);
      const snapshot = undoStacks.get(hunt.id)?.pop();
      if (snapshot === undefined) return null;

      const at = readClock();
      const delta = snapshot.count - hunt.count;
      const totalAfter = snapshot.priorCount + snapshot.count;
      // Only a taken-back phase log counts against the session; restoring a deleted entry does not.
      const phasesDelta = Math.min(0, snapshot.phases.length - hunt.phases.length);
      const touchesCounter = delta !== 0 || totalAfter !== huntTotal(hunt) || phasesDelta !== 0;
      // Undo may extend the running session but never starts one.
      const effect = touchesCounter
        ? trackActivity(hunt, totalAfter, at, phasesDelta, false)
        : NO_SESSION_EFFECT;
      const next: Hunt = {
        ...hunt,
        count: snapshot.count,
        priorCount: snapshot.priorCount,
        phases: snapshot.phases,
        status: snapshot.status,
        completedAt: snapshot.completedAt,
        notes: snapshot.notes ?? hunt.notes,
        updatedAt: at.toISOString(),
        elapsedMs: addElapsed(hunt.elapsedMs, effect.gapMs),
      };
      putHunt(index, next);
      saveHunts();
      const sessionEnded = next.status !== 'active' && endSessionOf(hunt.id);
      announce(next, 'undo', delta, origin);
      publishSessions(effect, sessionEnded);
      return next;
    },

    updateSettings(patch) {
      const changes = parseInput(inputSchemas.settingsPatch, patch, 'settings');
      if (!Object.values(changes).some((section) => section !== undefined)) return state.settings;
      const settings = mergeSettings(state.settings, changes);
      state = { ...state, settings };
      storage.saveSettings(settings);
      emit({ type: 'settings-changed', settings });
      return settings;
    },

    resetSettings() {
      const settings = createDefaultSettings();
      state = { ...state, settings };
      storage.saveSettings(settings);
      emit({ type: 'settings-changed', settings });
      return settings;
    },

    replaceState(nextState) {
      // Re-validated on the way in: this is the last gate before imported data becomes state.
      const clean = sanitizeAppState(nextState, { now: readClock(), idGenerator: generateId });
      if (sessionsTimer !== null) clearTimeout(sessionsTimer);
      sessionsTimer = null;
      sessionsDirty = false;
      openSession = null;
      undoStacks.clear();
      state = clean;
      storage.saveSettings(state.settings);
      saveHunts();
      storage.saveSessions(state.sessions);
      emit({ type: 'state-replaced', state });
    },

    closeSessions() {
      if (openSession === null && !sessionsDirty) return;
      openSession = null;
      flushSessions();
    },

    flushSync() {
      if (sessionsDirty) flushSessions();
      storage.flushSync();
    },
  };
}
