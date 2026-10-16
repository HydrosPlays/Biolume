/**
 * A stateful, in-memory fake of the complete `window.biolume` bridge.
 *
 * It behaves like a small main process: mutations update its own state,
 * resolve with the result AND broadcast the matching `StateEvent`, so a store
 * initialised against it (`initStore()`) follows along exactly as in the app.
 * Every method is a `vi.fn`, so calls can be asserted and failures injected:
 *
 *   const mock = installMockBiolume({ hunts: [hunt], activeHuntId: hunt.id });
 *   mock.api.hunts.adjustCount.mockRejectedValueOnce(new Error('disk full'));
 *   expect(mock.api.window.setOverlayOpen).toHaveBeenCalledWith(true);
 */
import { act } from '@testing-library/react';
import { vi, type Mock } from 'vitest';
import {
  createDefaultOddsSelection,
  createDefaultSettings,
  DEFAULT_TARGET_LEVEL,
  LIMITS,
} from '@shared/defaults';
import { EXTERNAL_URL_ALLOWLIST, type BiolumeApi, type Unsubscribe } from '@shared/ipc';
import { SHINY_CONFIRM_WINDOW_MS, STREAM_DECK_DEFAULT_PORT } from '@shared/streamDeck';
import {
  huntTotal,
  type AppState,
  type CounterSource,
  type HotkeyActionEvent,
  type HotkeyMode,
  type HotkeyStatus,
  type Hunt,
  type HuntChange,
  type HuntChangeKind,
  type PhaseEntry,
  type SessionRecord,
  type ShinyArmedEvent,
  type StateEvent,
  type StreamDeckStatus,
  type WindowKind,
  type WindowStateInfo,
} from '@shared/types';
import { applySettingsPatch } from './factories';

type AnyFunction = (...args: never[]) => unknown;
type MockedSection<T> = { [K in keyof T]: T[K] extends AnyFunction ? Mock<T[K]> : T[K] };

/** `BiolumeApi` with every method replaced by a typed `vi.fn`. */
export type MockedBiolumeApi = {
  [K in keyof BiolumeApi]: BiolumeApi[K] extends AnyFunction
    ? Mock<BiolumeApi[K]>
    : BiolumeApi[K] extends object
      ? MockedSection<BiolumeApi[K]>
      : BiolumeApi[K];
};

export interface MockBiolumeOptions extends Partial<AppState> {
  /** Which window the fake renderer runs in. Default `main`. */
  windowKind?: WindowKind;
  /** Reported `process.platform`. Default `win32`. */
  platform?: string;
  /** Overrides for the initial window state. */
  windowState?: Partial<WindowStateInfo>;
  /** Initial hotkey status. Default `{ mode: 'app-focused', registrations: [] }`. */
  hotkeyStatus?: HotkeyStatus;
  /**
   * Overrides for the Stream Deck bridge status. Default: follows
   * `settings.streamDeck.enabled` (listening on the default port), no clients,
   * plugin bundled.
   */
  streamDeckStatus?: Partial<StreamDeckStatus>;
}

export interface MockBiolume {
  /** The fake bridge — also installed as `window.biolume`. */
  api: MockedBiolumeApi;
  /** A deep copy of the fake main process' current state. */
  getState: () => AppState;
  /** Broadcasts a state event to every subscriber, as the main process would. */
  emit: (event: StateEvent) => void;
  /** Changes the hotkey status and notifies `hotkeys.onStatus` listeners. */
  setHotkeyStatus: (status: HotkeyStatus) => void;
  /** Patches the window state and notifies `window.onState` listeners. */
  setWindowState: (patch: Partial<WindowStateInfo>) => void;
  /** Simulates a global hotkey that main has already applied (`hotkeys.onAction`). */
  fireHotkeyAction: (event: HotkeyActionEvent) => void;
  /**
   * Pushes a Shiny Found armed / confirmed / expired event (`hunts.onShinyArmed`),
   * e.g. one caused by a Stream Deck key. Only notifies listeners: the fake's own
   * pending confirmation is not changed.
   */
  fireShinyArmed: (event: ShinyArmedEvent) => void;
  /** Patches the Stream Deck bridge status and notifies `streamDeck.onStatus` listeners. */
  setStreamDeckStatus: (patch: Partial<StreamDeckStatus>) => void;
  /** Removes `window.biolume` again (the shared test setup does this after each test). */
  restore: () => void;
}

const clone = <T>(value: T): T => structuredClone(value);

class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  subscribe = (listener: (value: T) => void): Unsubscribe => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  emit(value: T): void {
    // Listeners update React state; `act` flushes it whether or not the test wrapped the call.
    act(() => {
      for (const listener of [...this.listeners]) listener(clone(value));
    });
  }
}

let installed: MockBiolume | null = null;

/** Removes the fake installed by {@link installMockBiolume}, if any. */
export function uninstallMockBiolume(): void {
  installed?.restore();
}

/**
 * Installs a fresh fake bridge as `window.biolume` and returns its controller.
 * `initial` seeds the fake main process (`hunts`, `activeHuntId`, `sessions`,
 * `settings`) and the window it pretends to be.
 */
export function installMockBiolume(initial: MockBiolumeOptions = {}): MockBiolume {
  uninstallMockBiolume();

  const state: AppState = clone({
    settings: initial.settings ?? createDefaultSettings(),
    hunts: initial.hunts ?? [],
    activeHuntId: initial.activeHuntId ?? null,
    sessions: initial.sessions ?? [],
  });
  const windowKind = initial.windowKind ?? 'main';
  let windowState: WindowStateInfo = {
    kind: windowKind,
    maximized: false,
    focused: true,
    alwaysOnTop: false,
    overlayOpen: false,
    ...initial.windowState,
  };
  let hotkeyStatus: HotkeyStatus = clone(
    initial.hotkeyStatus ?? { mode: 'app-focused', registrations: [] },
  );
  let modeBeforeCapture: HotkeyMode = hotkeyStatus.mode;
  const bridgeFor = (
    enabled: boolean,
  ): Pick<StreamDeckStatus, 'enabled' | 'listening' | 'port'> => ({
    enabled,
    listening: enabled,
    port: enabled ? STREAM_DECK_DEFAULT_PORT : null,
  });
  let streamDeckStatus: StreamDeckStatus = {
    ...bridgeFor(state.settings.streamDeck.enabled),
    clients: 0,
    pluginBundled: true,
    error: null,
    ...initial.streamDeckStatus,
  };
  /** Shiny Found confirmations the fake main process is waiting on, with their expiry timers. */
  const shinyPending = new Map<
    string,
    { armedUntil: number; timer: ReturnType<typeof setTimeout> }
  >();

  const stateEvents = new Emitter<StateEvent>();
  const statusEvents = new Emitter<HotkeyStatus>();
  const actionEvents = new Emitter<HotkeyActionEvent>();
  const windowEvents = new Emitter<WindowStateInfo>();
  const shinyArmedEvents = new Emitter<ShinyArmedEvent>();
  const streamDeckEvents = new Emitter<StreamDeckStatus>();

  /** Drops a pending confirmation; announces it (armedUntil null) unless `silent`. */
  /** The bridge starts or stops with `settings.streamDeck.enabled`, as in the main process. */
  const syncBridge = (): void => {
    const { enabled } = state.settings.streamDeck;
    if (enabled === streamDeckStatus.enabled) return;
    streamDeckStatus = {
      ...streamDeckStatus,
      ...bridgeFor(enabled),
      clients: enabled ? streamDeckStatus.clients : 0,
      error: null,
    };
    streamDeckEvents.emit(streamDeckStatus);
  };

  const disarm = (huntId: string, source: CounterSource, silent = false): void => {
    const pending = shinyPending.get(huntId);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    shinyPending.delete(huntId);
    if (!silent) shinyArmedEvents.emit({ huntId, armedUntil: null, source });
  };

  const undoStacks = new Map<string, Hunt[]>();
  let idSequence = 0;
  const nextId = (prefix: string): string => {
    idSequence += 1;
    return `${prefix}-mock-${idSequence}`;
  };
  const now = (): string => new Date().toISOString();
  /** One macrotask-free hop, like the IPC round trip. */
  const hop = (): Promise<void> => Promise.resolve();

  const findHunt = (huntId: string): Hunt => {
    const hunt = state.hunts.find((entry) => entry.id === huntId);
    if (!hunt) throw new Error(`Unknown hunt: ${huntId}`);
    return hunt;
  };

  const remember = (hunt: Hunt): void => {
    const stack = undoStacks.get(hunt.id) ?? [];
    stack.push(clone(hunt));
    if (stack.length > LIMITS.undoDepth) stack.shift();
    undoStacks.set(hunt.id, stack);
  };

  const touchSession = (hunt: Hunt, previousTotal: number, phaseLogged: boolean): void => {
    const total = huntTotal(hunt);
    const open = state.sessions[0]?.huntId === hunt.id ? state.sessions[0] : undefined;
    if (open) {
      open.endedAt = now();
      open.endCount = total;
      open.encounters = total - open.startCount;
      if (phaseLogged) open.phasesLogged += 1;
    } else {
      const session: SessionRecord = {
        id: nextId('session'),
        huntId: hunt.id,
        huntName: hunt.name,
        targetName: hunt.target?.name ?? null,
        gameId: hunt.odds.gameId,
        methodId: hunt.odds.methodId,
        startedAt: now(),
        endedAt: now(),
        startCount: previousTotal,
        endCount: total,
        encounters: total - previousTotal,
        phasesLogged: phaseLogged ? 1 : 0,
      };
      state.sessions.unshift(session);
    }
    stateEvents.emit({ type: 'sessions-changed', sessions: state.sessions });
  };

  /** Stores the mutated hunt, broadcasts it and returns a copy — the tail of every mutation. */
  const commit = (hunt: Hunt, kind: HuntChangeKind, extra: Partial<HuntChange> = {}): Hunt => {
    hunt.updatedAt = now();
    const change: HuntChange = { kind, delta: 0, source: 'ui', ...extra };
    stateEvents.emit({ type: 'hunt-changed', hunt, change });
    return clone(hunt);
  };

  const setActive = (activeHuntId: string | null): void => {
    if (state.activeHuntId === activeHuntId) return;
    state.activeHuntId = activeHuntId;
    stateEvents.emit({ type: 'active-hunt-changed', activeHuntId });
  };

  const applyCount = (hunt: Hunt, next: number, source: CounterSource, setKind: boolean): Hunt => {
    const clamped = Math.min(Math.max(Math.round(next), LIMITS.count.min), LIMITS.count.max);
    const delta = clamped - hunt.count;
    const previousTotal = huntTotal(hunt);
    remember(hunt);
    hunt.count = clamped;
    touchSession(hunt, previousTotal, false);
    const kind: HuntChangeKind = setKind ? 'set-count' : delta < 0 ? 'decrement' : 'increment';
    return commit(hunt, kind, { delta, source });
  };

  const api: MockedBiolumeApi = {
    windowKind,
    platform: initial.platform ?? 'win32',
    versions: { app: '0.0.0-test', electron: '0.0.0', chrome: '0.0.0', node: '0.0.0' },

    state: {
      get: vi.fn(async () => {
        await hop();
        return clone(state);
      }),
      subscribe: vi.fn(stateEvents.subscribe),
    },

    hunts: {
      create: vi.fn(async (input) => {
        await hop();
        const timestamp = now();
        const hunt: Hunt = {
          id: nextId('hunt'),
          name: (input.name ?? input.target?.name ?? 'New hunt').slice(0, LIMITS.huntName),
          status: 'active',
          target: input.target ?? null,
          targetLevel: input.targetLevel ?? DEFAULT_TARGET_LEVEL,
          odds: input.odds ?? createDefaultOddsSelection(),
          count: 0,
          priorCount: 0,
          step: Math.max(LIMITS.step.min, input.step ?? 1),
          phases: [],
          notes: input.notes ?? '',
          createdAt: timestamp,
          updatedAt: timestamp,
          completedAt: null,
          elapsedMs: 0,
        };
        state.hunts.push(hunt);
        const created = commit(hunt, 'created');
        if (input.activate !== false) setActive(hunt.id);
        return created;
      }),

      update: vi.fn(async (huntId, patch) => {
        await hop();
        const hunt = findHunt(huntId);
        if (patch.step !== undefined && patch.step < LIMITS.step.min) {
          throw new Error('Step must be at least 1');
        }
        Object.assign(hunt, clone(patch));
        return commit(hunt, 'edited');
      }),

      remove: vi.fn(async (huntId) => {
        await hop();
        findHunt(huntId);
        state.hunts = state.hunts.filter((entry) => entry.id !== huntId);
        undoStacks.delete(huntId);
        disarm(huntId, 'ui', true);
        stateEvents.emit({ type: 'hunt-removed', huntId });
        if (state.activeHuntId === huntId) setActive(null);
      }),

      setActive: vi.fn(async (huntId) => {
        await hop();
        if (huntId !== null) findHunt(huntId);
        setActive(huntId);
      }),

      adjustCount: vi.fn(async (huntId, delta, source) => {
        await hop();
        const hunt = findHunt(huntId);
        return applyCount(hunt, hunt.count + delta, source, false);
      }),

      setCount: vi.fn(async (huntId, count, source) => {
        await hop();
        return applyCount(findHunt(huntId), count, source, true);
      }),

      logPhase: vi.fn(async (huntId, input) => {
        await hop();
        const hunt = findHunt(huntId);
        const previousTotal = huntTotal(hunt);
        remember(hunt);
        const phase: PhaseEntry = {
          id: nextId('phase'),
          speciesId: input.speciesId,
          speciesName: input.speciesName,
          spriteUrl: input.spriteUrl ?? null,
          encounters: hunt.count,
          totalEncounters: previousTotal,
          timestamp: now(),
          notes: input.notes ?? '',
        };
        hunt.phases.push(phase);
        if (input.resetCount !== false) {
          hunt.priorCount += hunt.count;
          hunt.count = 0;
        }
        touchSession(hunt, previousTotal, true);
        return commit(hunt, 'phase-logged', { source: input.source ?? 'ui', phaseId: phase.id });
      }),

      updatePhase: vi.fn(async (huntId, phaseId, patch) => {
        await hop();
        const hunt = findHunt(huntId);
        const phase = hunt.phases.find((entry) => entry.id === phaseId);
        if (!phase) throw new Error(`Unknown phase: ${phaseId}`);
        Object.assign(phase, clone(patch));
        return commit(hunt, 'phase-edited', { phaseId });
      }),

      removePhase: vi.fn(async (huntId, phaseId) => {
        await hop();
        const hunt = findHunt(huntId);
        if (!hunt.phases.some((entry) => entry.id === phaseId)) {
          throw new Error(`Unknown phase: ${phaseId}`);
        }
        hunt.phases = hunt.phases.filter((entry) => entry.id !== phaseId);
        return commit(hunt, 'phase-removed', { phaseId });
      }),

      complete: vi.fn(async (huntId, input) => {
        await hop();
        const hunt = findHunt(huntId);
        remember(hunt);
        hunt.status = 'completed';
        hunt.completedAt = now();
        if (input?.notes !== undefined) hunt.notes = input.notes;
        const completed = commit(hunt, 'completed');
        // Completing by any other path consumes a pending two-press confirmation.
        disarm(huntId, 'ui');
        return completed;
      }),

      reopen: vi.fn(async (huntId) => {
        await hop();
        const hunt = findHunt(huntId);
        hunt.status = 'active';
        hunt.completedAt = null;
        return commit(hunt, 'reopened');
      }),

      undo: vi.fn(async (huntId) => {
        await hop();
        const hunt = findHunt(huntId);
        const previous = undoStacks.get(huntId)?.pop();
        if (!previous) return null;
        const delta = previous.count - hunt.count;
        Object.assign(hunt, previous);
        return commit(hunt, 'undo', { delta });
      }),

      // Two presses within SHINY_CONFIRM_WINDOW_MS, like the main process.
      requestShinyFound: vi.fn(async (huntId, source) => {
        await hop();
        const hunt = findHunt(huntId);
        if (hunt.status !== 'active') throw new Error('Shiny Found needs an active hunt');

        const pending = shinyPending.get(huntId);
        if (pending !== undefined && pending.armedUntil > Date.now()) {
          disarm(huntId, source, true);
          remember(hunt);
          hunt.status = 'completed';
          hunt.completedAt = now();
          const completed = commit(hunt, 'completed', { source });
          shinyArmedEvents.emit({ huntId, armedUntil: null, source });
          return { completed: true, armedUntil: null, hunt: completed };
        }

        disarm(huntId, source, true);
        const armedUntil = Date.now() + SHINY_CONFIRM_WINDOW_MS;
        const timer = setTimeout(() => disarm(huntId, source), SHINY_CONFIRM_WINDOW_MS);
        shinyPending.set(huntId, { armedUntil, timer });
        shinyArmedEvents.emit({ huntId, armedUntil, source });
        return { completed: false, armedUntil, hunt: clone(hunt) };
      }),

      onShinyArmed: vi.fn(shinyArmedEvents.subscribe),
    },

    streamDeck: {
      getStatus: vi.fn(async () => {
        await hop();
        return clone(streamDeckStatus);
      }),
      onStatus: vi.fn(streamDeckEvents.subscribe),
      installPlugin: vi.fn(async () => {
        await hop();
        return streamDeckStatus.pluginBundled
          ? { ok: true }
          : { ok: false, error: 'This build does not include the Stream Deck plugin.' };
      }),
    },

    settings: {
      update: vi.fn(async (patch) => {
        await hop();
        state.settings = applySettingsPatch(state.settings, clone(patch));
        stateEvents.emit({ type: 'settings-changed', settings: state.settings });
        syncBridge();
        return clone(state.settings);
      }),
      reset: vi.fn(async () => {
        await hop();
        state.settings = createDefaultSettings();
        stateEvents.emit({ type: 'settings-changed', settings: state.settings });
        syncBridge();
        return clone(state.settings);
      }),
    },

    hotkeys: {
      getStatus: vi.fn(async () => {
        await hop();
        return clone(hotkeyStatus);
      }),
      setCapturing: vi.fn(async (capturing) => {
        await hop();
        if (capturing) {
          if (hotkeyStatus.mode !== 'capturing') modeBeforeCapture = hotkeyStatus.mode;
          hotkeyStatus = { ...hotkeyStatus, mode: 'capturing' };
        } else if (hotkeyStatus.mode === 'capturing') {
          hotkeyStatus = { ...hotkeyStatus, mode: modeBeforeCapture };
        }
        statusEvents.emit(hotkeyStatus);
      }),
      onStatus: vi.fn(statusEvents.subscribe),
      onAction: vi.fn(actionEvents.subscribe),
    },

    window: {
      minimize: vi.fn(() => undefined),
      toggleMaximize: vi.fn(() => {
        windowState = { ...windowState, maximized: !windowState.maximized };
        windowEvents.emit(windowState);
      }),
      close: vi.fn(() => undefined),
      getState: vi.fn(async () => {
        await hop();
        return clone(windowState);
      }),
      onState: vi.fn(windowEvents.subscribe),
      setAlwaysOnTop: vi.fn(async (pinned) => {
        await hop();
        windowState = { ...windowState, alwaysOnTop: pinned };
        windowEvents.emit(windowState);
      }),
      setOverlayOpen: vi.fn(async (open) => {
        await hop();
        windowState = { ...windowState, overlayOpen: open };
        windowEvents.emit(windowState);
      }),
      resizeOverlay: vi.fn(() => undefined),
    },

    data: {
      exportData: vi.fn(async (request) => {
        await hop();
        const hunts = request.huntIds
          ? state.hunts.filter((hunt) => request.huntIds?.includes(hunt.id))
          : state.hunts;
        const records =
          request.dataset === 'sessions'
            ? state.sessions.length
            : request.dataset === 'phases'
              ? hunts.reduce((sum, hunt) => sum + hunt.phases.length, 0)
              : hunts.length;
        return {
          canceled: false,
          filePath: `C:\\mock\\exports\\biolume-${request.dataset}.${request.format}`,
          records,
        };
      }),
      importData: vi.fn(async () => {
        await hop();
        // No file dialog in tests: behave as if the user cancelled. Override per test with mockResolvedValueOnce.
        return {
          canceled: true,
          filePath: null,
          dataset: null,
          imported: { hunts: 0, phases: 0, sessions: 0, targets: 0 },
          skipped: 0,
          errors: [],
        };
      }),
      getPath: vi.fn(async () => {
        await hop();
        return 'C:\\mock\\userData';
      }),
      revealFolder: vi.fn(async () => {
        await hop();
      }),
    },

    shell: {
      openExternal: vi.fn(async (url) => {
        await hop();
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || !EXTERNAL_URL_ALLOWLIST.includes(parsed.hostname)) {
          throw new Error(`Blocked external URL: ${url}`);
        }
      }),
    },

    smokeReady: vi.fn(() => undefined),
  };

  const previous = (window as { biolume?: BiolumeApi }).biolume;
  const controller: MockBiolume = {
    api,
    getState: () => clone(state),
    emit: (event) => {
      // Keep the fake main process consistent with what it announces.
      switch (event.type) {
        case 'hunt-changed': {
          const index = state.hunts.findIndex((hunt) => hunt.id === event.hunt.id);
          if (index === -1) state.hunts.push(clone(event.hunt));
          else state.hunts[index] = clone(event.hunt);
          break;
        }
        case 'hunt-removed':
          state.hunts = state.hunts.filter((hunt) => hunt.id !== event.huntId);
          break;
        case 'active-hunt-changed':
          state.activeHuntId = event.activeHuntId;
          break;
        case 'settings-changed':
          state.settings = clone(event.settings);
          break;
        case 'sessions-changed':
          state.sessions = clone(event.sessions);
          break;
        case 'state-replaced':
          Object.assign(state, clone(event.state));
          break;
      }
      stateEvents.emit(event);
    },
    setHotkeyStatus: (status) => {
      hotkeyStatus = clone(status);
      statusEvents.emit(hotkeyStatus);
    },
    setWindowState: (patch) => {
      windowState = { ...windowState, ...patch };
      windowEvents.emit(windowState);
    },
    fireHotkeyAction: (event) => actionEvents.emit(event),
    fireShinyArmed: (event) => shinyArmedEvents.emit(event),
    setStreamDeckStatus: (patch) => {
      streamDeckStatus = { ...streamDeckStatus, ...patch };
      streamDeckEvents.emit(streamDeckStatus);
    },
    restore: () => {
      if (installed !== controller) return;
      installed = null;
      for (const pending of shinyPending.values()) clearTimeout(pending.timer);
      shinyPending.clear();
      if (previous === undefined) delete (window as { biolume?: BiolumeApi }).biolume;
      else window.biolume = previous;
    },
  };

  window.biolume = api as unknown as BiolumeApi;
  installed = controller;
  return controller;
}
