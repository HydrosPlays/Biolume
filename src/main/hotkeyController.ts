/**
 * The global hotkeys: keeps the OS registrations (`globalShortcut`) in line
 * with the settings and the current {@link HotkeyMode}, and applies a shortcut
 * when the OS reports it.
 *
 * Encounters can be counted while a game has focus and Biolume is unfocused,
 * hidden or minimized. While the main window itself has focus every shortcut is
 * released and the renderer handles the same bindings, which keeps keys such as
 * Space typeable in Biolume's own text fields.
 *
 * The controller only talks to the interfaces below (`main.ts` passes Electron's
 * `globalShortcut` and the window manager), so this module stays free of
 * `electron` imports and can be unit-tested.
 */
import { IPC } from '@shared/ipc';
import type {
  HotkeyAction,
  HotkeyActionEvent,
  HotkeyRegistration,
  HotkeyStatus,
  Hunt,
} from '@shared/types';
import { describeError } from './dataFiles';
import {
  createRepeatGuard,
  DUPLICATE_BINDING_ERROR,
  planBindings,
  planSignature,
  REPEAT_GUARD_MS,
  resolveHotkeyMode,
  type PlannedBinding,
} from './hotkeyPlan';
import type { ConfirmTimers, ShinyConfirm } from './shinyConfirm';
import type { AppStore } from './store';
import type { MainWindowActivity } from './windows';

type Logger = (message: string, detail?: unknown) => void;

/** The part of Electron's `globalShortcut` the controller uses. */
export interface ShortcutRegistry {
  /** False when the OS refuses the accelerator; throws when it is malformed. */
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
  isRegistered(accelerator: string): boolean;
}

/** What the controller needs from the window manager. */
export interface HotkeyHost {
  isMainFocused(): boolean;
  toggleOverlay(): void;
  broadcast(channel: string, payload: unknown): void;
}

export interface HotkeyControllerOptions {
  shortcuts: ShortcutRegistry;
  store: Pick<AppStore, 'getState' | 'getActiveHunt' | 'adjustCount' | 'undo' | 'logPhase'>;
  /**
   * Shiny Found needs a confirming second press; the controller forwards each
   * press, and holds back a confirming one until it is sure the key was not held.
   */
  shiny: Pick<ShinyConfirm, 'request' | 'armedUntil'>;
  host: HotkeyHost;
  /** Clock for the auto-repeat guard, in ms (default `Date.now`). */
  now?: () => number;
  /** Timers for the held-key check on Shiny Found (default `setTimeout`, unref'd). */
  timers?: ConfirmTimers;
  log?: Logger;
}

/**
 * A Shiny Found press that would *confirm* waits this long before it is acted on.
 * Holding the key down is one press, but its first auto-repeat arrives 250–1000 ms
 * after it — long after the repeat guard's window — and would count as the second
 * press. The repeats right behind it (every ~33 ms by default) cancel the
 * confirmation instead, so a held key only ever arms.
 */
export const SHINY_HOLD_CHECK_MS = 150;

/** After a hold was detected, the key counts as released once it has been quiet this long. */
export const SHINY_HOLD_RELEASE_MS = 500;

const defaultTimers: ConfirmTimers = {
  set(callback, ms) {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return timer;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface HotkeyController {
  /** The mode and the outcome of the latest registration attempt per binding. */
  getStatus(): HotkeyStatus;
  /**
   * Re-evaluates the mode and brings the OS registrations in line with it.
   * Idempotent: call it whenever something it depends on may have changed.
   */
  refresh(): HotkeyStatus;
  /** The settings UI started / stopped recording a key combination. */
  setCapturing(capturing: boolean): void;
  /** Releases the shortcuts while a native dialog of ours has focus; returns the release function. */
  holdForDialog(): () => void;
  handleMainActivity(activity: MainWindowActivity): void;
  /** What a registered shortcut runs when the OS reports it. */
  trigger(action: HotkeyAction, accelerator: string): void;
  /** Unregisters everything; the controller is inert afterwards. */
  dispose(): void;
}

export const OS_REFUSED_ERROR = 'In use by another application or reserved by the system';

/** Main-window changes after which a key recording cannot be in progress any more. */
const ENDS_CAPTURE: ReadonlySet<MainWindowActivity> = new Set([
  'blur',
  'hide',
  'minimize',
  'reload',
  'closed',
]);

export function createHotkeyController(options: HotkeyControllerOptions): HotkeyController {
  const { shortcuts, store, shiny, host } = options;
  const log = options.log ?? (() => undefined);
  const repeatGuard = createRepeatGuard(REPEAT_GUARD_MS, options.now);
  const timers = options.timers ?? defaultTimers;
  /** A confirming Shiny Found press waiting out {@link SHINY_HOLD_CHECK_MS}. */
  let pendingConfirm: { accelerator: string; timer: unknown } | null = null;
  /** Keys found held down on Shiny Found, with the timer that declares them released. */
  const heldDown = new Map<string, unknown>();

  /** Accelerators this app currently holds with the OS — the only ones it ever unregisters. */
  const held = new Set<string>();
  /** Outcome of the latest registration attempt, and the bindings it was made for. */
  let attempted: { signature: string; registrations: HotkeyRegistration[] } | null = null;
  let status: HotkeyStatus = { mode: 'disabled', registrations: [] };
  let capturing = false;
  let openDialogs = 0;
  let disposed = false;

  const release = (): void => {
    for (const accelerator of held) {
      try {
        shortcuts.unregister(accelerator);
      } catch (error) {
        log(`Could not unregister the shortcut "${accelerator}"`, error);
      }
    }
    held.clear();
  };

  /**
   * Asks the OS for one binding. With `keep` false the shortcut is handed
   * straight back: a probe that tells the settings UI whether the key is
   * available without taking it away from the focused window.
   */
  const attempt = (binding: PlannedBinding, keep: boolean): HotkeyRegistration => {
    const { action, accelerator } = binding;
    if (binding.duplicateOf !== null) {
      return { action, accelerator, registered: false, error: DUPLICATE_BINDING_ERROR };
    }
    try {
      const accepted = shortcuts.register(accelerator, () => trigger(action, accelerator));
      if (!accepted) return { action, accelerator, registered: false, error: OS_REFUSED_ERROR };
    } catch (error) {
      return {
        action,
        accelerator,
        registered: false,
        error: `Not a valid shortcut (${describeError(error)})`,
      };
    }
    held.add(accelerator);
    if (!keep) {
      try {
        shortcuts.unregister(accelerator);
        held.delete(accelerator);
      } catch (error) {
        // Still listed in `held`, so the next release retries.
        log(`Could not release the shortcut "${accelerator}" after probing it`, error);
      }
    }
    return { action, accelerator, registered: true };
  };

  /** Whether everything the last attempt registered is still held, by us and by the OS. */
  const isIntact = (registrations: readonly HotkeyRegistration[]): boolean =>
    registrations.every(
      ({ registered, accelerator }) =>
        !registered || (held.has(accelerator) && shortcuts.isRegistered(accelerator)),
    );

  const publish = (next: HotkeyStatus): HotkeyStatus => {
    if (JSON.stringify(next) === JSON.stringify(status)) return status;
    status = next;
    try {
      host.broadcast(IPC.hotkeysStatusEvent, status);
    } catch (error) {
      log('Could not broadcast the hotkey status', error);
    }
    return status;
  };

  const refresh = (): HotkeyStatus => {
    if (disposed) return status;
    const settings = store.getState().settings.hotkeys;
    const mode = resolveHotkeyMode({
      globalEnabled: settings.globalEnabled,
      capturing,
      mainFocused: openDialogs > 0 || host.isMainFocused(),
    });
    const plan = planBindings(settings.bindings);
    const signature = planSignature(plan);

    if (mode === 'disabled') {
      // Switched off: the OS is left alone entirely, so nothing is known about availability.
      release();
      attempted = null;
      return publish({
        mode,
        registrations: plan.map(({ action, accelerator }) => ({
          action,
          accelerator,
          registered: false,
        })),
      });
    }

    if (mode === 'active') {
      if (attempted?.signature !== signature || !isIntact(attempted.registrations)) {
        // Start from nothing, so an accelerator that left the settings can never linger.
        release();
        attempted = { signature, registrations: plan.map((binding) => attempt(binding, true)) };
      }
    } else {
      // The renderer handles the bindings now (or a key is being recorded): hold nothing.
      release();
      if (attempted?.signature !== signature) {
        attempted = { signature, registrations: plan.map((binding) => attempt(binding, false)) };
      }
    }
    return publish({ mode, registrations: attempted.registrations });
  };

  /** Applies a count-style action to the active hunt; returns the id of a quick-logged phase. */
  const applyToHunt = (action: HotkeyAction, hunt: Hunt): string | undefined => {
    switch (action) {
      case 'increment':
        // Counting on a completed or archived hunt is ignored quietly.
        if (hunt.status === 'active') store.adjustCount(hunt.id, hunt.step, 'hotkey-global');
        return undefined;
      case 'decrement':
        if (hunt.status === 'active') store.adjustCount(hunt.id, -hunt.step, 'hotkey-global');
        return undefined;
      case 'undo':
        store.undo(hunt.id, 'hotkey-global');
        return undefined;
      case 'logPhase':
        if (hunt.status !== 'active') return undefined;
        // Unidentified for now — the renderer offers to name it once the user is back.
        return store.logPhase(hunt.id, {
          speciesId: null,
          speciesName: '',
          source: 'hotkey-global',
        }).phase.id;
      case 'shinyFound':
        // The first press arms it, a second one within the confirmation window completes the hunt.
        if (hunt.status === 'active') shiny.request(hunt.id, 'hotkey-global');
        return undefined;
      case 'toggleOverlay':
        return undefined;
    }
  };

  /** (Re)starts the quiet period after which a held key counts as released. */
  const holdDown = (accelerator: string): void => {
    const previous = heldDown.get(accelerator);
    if (previous !== undefined) timers.clear(previous);
    heldDown.set(
      accelerator,
      timers.set(() => heldDown.delete(accelerator), SHINY_HOLD_RELEASE_MS),
    );
  };

  /** True when a Shiny Found press now would complete the active hunt. */
  const wouldConfirmShiny = (): boolean => {
    const hunt = store.getActiveHunt();
    return hunt !== null && hunt.status === 'active' && shiny.armedUntil(hunt.id) !== null;
  };

  function trigger(action: HotkeyAction, accelerator: string): void {
    if (disposed) return;
    if (heldDown.has(accelerator)) {
      // Still held since a confirmation was refused: every repeat extends the hold.
      holdDown(accelerator);
      return;
    }
    if (pendingConfirm !== null && pendingConfirm.accelerator === accelerator) {
      // A repeat right behind the confirming press: the key is held down, not pressed twice.
      timers.clear(pendingConfirm.timer);
      pendingConfirm = null;
      holdDown(accelerator);
      return;
    }
    // A held key repeats every ~30 ms; only its first trigger counts.
    if (!repeatGuard.accept(accelerator)) return;

    if (action === 'shinyFound' && wouldConfirmShiny()) {
      if (pendingConfirm !== null) timers.clear(pendingConfirm.timer);
      const timer = timers.set(() => {
        if (pendingConfirm?.timer !== timer) return;
        pendingConfirm = null;
        perform(action, accelerator);
      }, SHINY_HOLD_CHECK_MS);
      pendingConfirm = { accelerator, timer };
      return;
    }
    perform(action, accelerator);
  }

  /** Applies a press that passed the repeat and held-key checks, and tells the windows. */
  function perform(action: HotkeyAction, accelerator: string): void {
    if (disposed) return;
    let huntId: string | null = null;
    let phaseId: string | undefined;
    try {
      if (action === 'toggleOverlay') {
        huntId = store.getState().activeHuntId;
        host.toggleOverlay();
      } else {
        const hunt = store.getActiveHunt();
        huntId = hunt?.id ?? null;
        if (hunt !== null) phaseId = applyToHunt(action, hunt);
      }
    } catch (error) {
      // This runs straight from an OS callback: nothing may escape it.
      log(`The "${action}" hotkey failed`, error);
    }

    const event: HotkeyActionEvent =
      phaseId === undefined
        ? { action, accelerator, huntId }
        : { action, accelerator, huntId, phaseId };
    try {
      host.broadcast(IPC.hotkeysActionEvent, event);
    } catch (error) {
      log('Could not broadcast a hotkey action', error);
    }
  }

  return {
    getStatus: () => status,
    refresh,

    setCapturing(next) {
      // Only a focused main window can be recording; anything else would silence the hotkeys.
      capturing = next && host.isMainFocused();
      refresh();
    },

    holdForDialog() {
      openDialogs += 1;
      refresh();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        openDialogs = Math.max(0, openDialogs - 1);
        refresh();
      };
    },

    handleMainActivity(activity) {
      if (ENDS_CAPTURE.has(activity)) capturing = false;
      refresh();
    },

    trigger,

    dispose() {
      if (disposed) return;
      release();
      disposed = true;
      attempted = null;
      repeatGuard.reset();
      if (pendingConfirm !== null) timers.clear(pendingConfirm.timer);
      pendingConfirm = null;
      for (const timer of heldDown.values()) timers.clear(timer);
      heldDown.clear();
    },
  };
}
