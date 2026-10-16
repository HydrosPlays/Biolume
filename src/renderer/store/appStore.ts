/**
 * Renderer mirror of the main process' {@link AppState}.
 *
 * The main process is the single source of truth: this store is written ONLY
 * from the boot snapshot and from pushed events — never optimistically. A
 * mutation is a call on `window.biolume.*` (see `./actions`); its effect comes
 * back as a `StateEvent` and lands here, in this window and in every other one.
 */
import { create } from 'zustand';
import { createDefaultSettings } from '@shared/defaults';
import type { BiolumeApi, Unsubscribe } from '@shared/ipc';
import { SHINY_CONFIRM_WINDOW_MS } from '@shared/streamDeck';
import type {
  AppState,
  CounterSource,
  HotkeyStatus,
  Hunt,
  HuntChange,
  SessionRecord,
  Settings,
  ShinyArmedEvent,
  StateEvent,
  StreamDeckStatus,
  WindowKind,
  WindowStateInfo,
} from '@shared/types';

/** The most recent hunt change — drives audio / animation feedback. */
export interface LastChange {
  huntId: string;
  change: HuntChange;
  /** `Date.now()` when the event reached this renderer. */
  at: number;
}

/**
 * A Shiny Found confirmation waiting for its second press (hotkey or Stream
 * Deck): the first press armed it, a second one before `armedUntil` completes
 * the hunt. See `SHINY_CONFIRM_WINDOW_MS` in `@shared/streamDeck`.
 */
export interface ShinyArmedState {
  /** Epoch ms the confirmation window closes. */
  armedUntil: number;
  /** What armed it — decides the wording of the hint ("press the key again"). */
  source: CounterSource;
}

export interface AppStoreState extends AppState {
  /** True once the boot snapshot has been applied. */
  ready: boolean;
  /** Why the boot snapshot could not be loaded, or null. */
  loadError: string | null;
  windowState: WindowStateInfo;
  hotkeyStatus: HotkeyStatus;
  /** A fresh object for every `hunt-changed` event received after boot; null until the first. */
  lastChange: LastChange | null;
  /** The local bridge the Elgato Stream Deck plugin connects to. */
  streamDeckStatus: StreamDeckStatus;
  /** Armed Shiny Found confirmations by hunt id; an entry disappears on confirmation or expiry. */
  shinyArmed: Readonly<Record<string, ShinyArmedState>>;
}

function currentWindowKind(): WindowKind {
  return typeof window !== 'undefined' && window.biolume?.windowKind === 'overlay'
    ? 'overlay'
    : 'main';
}

/** What the Stream Deck bridge looks like before the main process has answered. */
export function createInitialStreamDeckStatus(): StreamDeckStatus {
  return {
    enabled: false,
    listening: false,
    port: null,
    clients: 0,
    pluginBundled: false,
    error: null,
  };
}

function createInitialState(): AppStoreState {
  return {
    ready: false,
    loadError: null,
    settings: createDefaultSettings(),
    hunts: [],
    activeHuntId: null,
    sessions: [],
    windowState: {
      kind: currentWindowKind(),
      maximized: false,
      focused: true,
      alwaysOnTop: false,
      overlayOpen: false,
    },
    hotkeyStatus: { mode: 'disabled', registrations: [] },
    lastChange: null,
    streamDeckStatus: createInitialStreamDeckStatus(),
    shinyArmed: {},
  };
}

export const useAppStore = create<AppStoreState>()(() => createInitialState());

function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

/**
 * Pure reducer for one pushed event. `at` stamps `lastChange`; pass
 * `{ silent: true }` to apply a change without flagging it for feedback
 * (used when replaying events that raced the boot snapshot).
 */
export function applyStateEvent(
  state: AppStoreState,
  event: StateEvent,
  at: number,
  options: { silent?: boolean } = {},
): Partial<AppStoreState> {
  switch (event.type) {
    case 'hunt-changed': {
      const index = state.hunts.findIndex((hunt) => hunt.id === event.hunt.id);
      const hunts =
        index === -1
          ? [...state.hunts, event.hunt]
          : state.hunts.map((hunt, position) => (position === index ? event.hunt : hunt));
      const patch: Partial<AppStoreState> = options.silent
        ? { hunts }
        : { hunts, lastChange: { huntId: event.hunt.id, change: event.change, at } };
      // However it got completed (its own button, the confirming press), nothing is pending any more.
      if (event.hunt.status === 'completed' && event.hunt.id in state.shinyArmed) {
        patch.shinyArmed = withoutKey(state.shinyArmed, event.hunt.id);
      }
      return patch;
    }
    case 'hunt-removed': {
      const hunts = state.hunts.filter((hunt) => hunt.id !== event.huntId);
      const patch: Partial<AppStoreState> = { hunts };
      // Main follows up with `active-hunt-changed`; never point at a missing hunt meanwhile.
      if (state.activeHuntId === event.huntId) patch.activeHuntId = null;
      if (event.huntId in state.shinyArmed) {
        patch.shinyArmed = withoutKey(state.shinyArmed, event.huntId);
      }
      return patch;
    }
    case 'active-hunt-changed':
      return { activeHuntId: event.activeHuntId };
    case 'settings-changed':
      return { settings: event.settings };
    case 'sessions-changed':
      return { sessions: event.sessions };
    case 'state-replaced':
      return { ...event.state, lastChange: null, shinyArmed: {} };
  }
}

/**
 * Pure reducer for a pushed {@link ShinyArmedEvent}: arms (or re-arms) the
 * hunt's confirmation, or clears it once it was confirmed or expired. A
 * malformed event changes nothing.
 */
export function applyShinyArmedEvent(
  state: Pick<AppStoreState, 'shinyArmed'>,
  event: ShinyArmedEvent,
): Partial<AppStoreState> {
  if (typeof event.huntId !== 'string' || event.huntId === '') return {};
  if (event.armedUntil === null) {
    return event.huntId in state.shinyArmed
      ? { shinyArmed: withoutKey(state.shinyArmed, event.huntId) }
      : {};
  }
  if (typeof event.armedUntil !== 'number' || !Number.isFinite(event.armedUntil)) return {};
  return {
    shinyArmed: {
      ...state.shinyArmed,
      [event.huntId]: { armedUntil: event.armedUntil, source: event.source },
    },
  };
}

/** Milliseconds a confirmation has left at `now`: 0 once expired, never more than the full window. */
export function shinyArmedRemaining(
  armed: Pick<ShinyArmedState, 'armedUntil'>,
  now: number,
): number {
  return Math.min(Math.max(armed.armedUntil - now, 0), SHINY_CONFIRM_WINDOW_MS);
}

let initPromise: Promise<void> | null = null;
let subscriptions: Unsubscribe[] = [];
/** Bumped by `resetStore` so a boot that is still in flight cannot write into the fresh state. */
let generation = 0;

/**
 * Main announces the expiry itself; these timers only make sure an armed
 * confirmation never outlives its window here when that event is lost.
 */
const shinyExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Slack after `armedUntil` before the local fallback drops an entry main has not cleared. */
const SHINY_EXPIRY_GRACE_MS = 250;

function clearShinyExpiry(huntId: string): void {
  const timer = shinyExpiryTimers.get(huntId);
  if (timer === undefined) return;
  clearTimeout(timer);
  shinyExpiryTimers.delete(huntId);
}

function clearAllShinyExpiries(): void {
  for (const timer of shinyExpiryTimers.values()) clearTimeout(timer);
  shinyExpiryTimers.clear();
}

function scheduleShinyExpiry(huntId: string, entry: ShinyArmedState): void {
  clearShinyExpiry(huntId);
  const delay = shinyArmedRemaining(entry, Date.now()) + SHINY_EXPIRY_GRACE_MS;
  shinyExpiryTimers.set(
    huntId,
    setTimeout(() => {
      shinyExpiryTimers.delete(huntId);
      useAppStore.setState((state) =>
        state.shinyArmed[huntId]?.armedUntil === entry.armedUntil
          ? { shinyArmed: withoutKey(state.shinyArmed, huntId) }
          : state,
      );
    }, delay),
  );
}

function handleShinyArmed(event: ShinyArmedEvent): void {
  useAppStore.setState((state) => {
    const patch = applyShinyArmedEvent(state, event);
    return patch.shinyArmed === undefined ? state : patch;
  });
  const entry = selectShinyArmed(useAppStore.getState(), event.huntId);
  if (entry === null) clearShinyExpiry(event.huntId);
  else scheduleShinyExpiry(event.huntId, entry);
}

function releaseSubscriptions(): void {
  clearAllShinyExpiries();
  for (const unsubscribe of subscriptions) {
    try {
      unsubscribe();
    } catch {
      // A listener that is already gone is fine.
    }
  }
  subscriptions = [];
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === 'string' && error ? error : 'Unknown error';
}

/**
 * The bridge status is an extra, not part of the user's data: a failure is
 * logged and keeps the "not listening" placeholder (the next push corrects it)
 * instead of failing the whole boot.
 */
async function loadStreamDeckStatus(api: BiolumeApi): Promise<StreamDeckStatus | null> {
  try {
    return await api.streamDeck.getStatus();
  } catch (error) {
    console.warn('[biolume] Stream Deck status unavailable', error);
    return null;
  }
}

async function boot(api: BiolumeApi): Promise<void> {
  // Subscribe before asking for the snapshot so nothing emitted in between is lost;
  // events that arrive early are queued and replayed on top of the snapshot.
  const bootGeneration = generation;
  let queue: StateEvent[] | null = [];
  let statusPushed = false;
  let windowPushed = false;
  let streamDeckPushed = false;

  subscriptions.push(
    api.state.subscribe((event) => {
      if (queue) {
        queue.push(event);
        return;
      }
      useAppStore.setState((state) => applyStateEvent(state, event, Date.now()));
    }),
    api.hotkeys.onStatus((hotkeyStatus) => {
      statusPushed = true;
      useAppStore.setState({ hotkeyStatus });
    }),
    api.window.onState((windowState) => {
      windowPushed = true;
      useAppStore.setState({ windowState });
    }),
    api.streamDeck.onStatus((streamDeckStatus) => {
      streamDeckPushed = true;
      useAppStore.setState({ streamDeckStatus });
    }),
    // The snapshot carries no armed state, so these apply as they come.
    api.hunts.onShinyArmed(handleShinyArmed),
  );

  const [snapshot, hotkeyStatus, windowState, streamDeckStatus] = await Promise.all([
    api.state.get(),
    api.hotkeys.getStatus(),
    api.window.getState(),
    loadStreamDeckStatus(api),
  ]);

  if (bootGeneration !== generation) return;
  const queued = queue;
  queue = null;
  useAppStore.setState((state) => {
    let next: AppStoreState = {
      ...state,
      settings: snapshot.settings,
      hunts: snapshot.hunts,
      activeHuntId: snapshot.activeHuntId,
      sessions: snapshot.sessions,
      // A pushed value is newer than the answer to a request sent before it.
      hotkeyStatus: statusPushed ? state.hotkeyStatus : hotkeyStatus,
      windowState: windowPushed ? state.windowState : windowState,
      streamDeckStatus:
        streamDeckPushed || streamDeckStatus === null ? state.streamDeckStatus : streamDeckStatus,
      ready: true,
      loadError: null,
      lastChange: null,
    };
    for (const event of queued) {
      next = { ...next, ...applyStateEvent(next, event, Date.now(), { silent: true }) };
    }
    return next;
  });
}

/**
 * Loads the snapshot from the main process and starts following its events.
 * Idempotent — concurrent and repeated calls share one boot. Rejects (and sets
 * `loadError`) when the snapshot cannot be loaded; calling again retries.
 */
export function initStore(api: BiolumeApi = window.biolume): Promise<void> {
  if (initPromise) return initPromise;
  useAppStore.setState({ loadError: null });
  const attempt = boot(api);
  initPromise = attempt;
  // Registered first, so the store reflects the failure before any caller's handler runs.
  attempt.catch((error: unknown) => {
    if (initPromise !== attempt) return;
    releaseSubscriptions();
    initPromise = null;
    useAppStore.setState({ ready: false, loadError: describeError(error) });
  });
  return attempt;
}

/** Stops following the main process and restores the initial state (tests, hot reload). */
export function resetStore(): void {
  generation += 1;
  releaseSubscriptions();
  initPromise = null;
  useAppStore.setState(createInitialState(), true);
}

// ───────────────────────────── Selectors ─────────────────────────────

export function selectActiveHunt(
  state: Pick<AppStoreState, 'hunts' | 'activeHuntId'>,
): Hunt | null {
  if (state.activeHuntId === null) return null;
  return state.hunts.find((hunt) => hunt.id === state.activeHuntId) ?? null;
}

export function selectHunt(
  state: Pick<AppStoreState, 'hunts'>,
  huntId: string | null | undefined,
): Hunt | null {
  if (!huntId) return null;
  return state.hunts.find((hunt) => hunt.id === huntId) ?? null;
}

/** The hunt's pending Shiny Found confirmation as stored (expiry not re-checked), or null. */
export function selectShinyArmed(
  state: Pick<AppStoreState, 'shinyArmed'>,
  huntId: string | null | undefined,
): ShinyArmedState | null {
  if (!huntId) return null;
  return state.shinyArmed[huntId] ?? null;
}

/** The active hunt outside React (event handlers, actions). */
export function getActiveHunt(): Hunt | null {
  return selectActiveHunt(useAppStore.getState());
}

/** The hunt selected as active, or null when there is none. */
export function useActiveHunt(): Hunt | null {
  return useAppStore(selectActiveHunt);
}

/** One hunt by id, or null when it does not exist (or `huntId` is empty). */
export function useHunt(huntId: string | null | undefined): Hunt | null {
  return useAppStore((state) => selectHunt(state, huntId));
}

/** Every hunt, in the main process' order. */
export function useHunts(): Hunt[] {
  return useAppStore((state) => state.hunts);
}

export function useSettings(): Settings {
  return useAppStore((state) => state.settings);
}

/** Session history, newest first. */
export function useSessions(): SessionRecord[] {
  return useAppStore((state) => state.sessions);
}

export function useHotkeyStatus(): HotkeyStatus {
  return useAppStore((state) => state.hotkeyStatus);
}

export function useWindowState(): WindowStateInfo {
  return useAppStore((state) => state.windowState);
}

/** The latest hunt change; a new object per event, so it is safe as an effect dependency. */
export function useLastChange(): LastChange | null {
  return useAppStore((state) => state.lastChange);
}

export function useStoreReady(): boolean {
  return useAppStore((state) => state.ready);
}

/** Live status of the Stream Deck bridge: listening, port, connected plugin instances. */
export function useStreamDeckStatus(): StreamDeckStatus {
  return useAppStore((state) => state.streamDeckStatus);
}

/**
 * The hunt's pending Shiny Found confirmation as stored, or null. For a
 * countdown use `useShinyConfirmation` (hooks), which ticks and stops at
 * `armedUntil` by itself.
 */
export function useShinyArmed(huntId: string | null | undefined): ShinyArmedState | null {
  return useAppStore((state) => selectShinyArmed(state, huntId));
}
