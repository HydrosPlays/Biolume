import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '@shared/defaults';
import type { AppState, HotkeyStatus } from '@shared/types';
import {
  createHotkeyController,
  OS_REFUSED_ERROR,
  type HotkeyController,
  type ShortcutRegistry,
} from './hotkeyController';
import { DUPLICATE_BINDING_ERROR, findRegistrationMismatches } from './hotkeyPlan';
import { createShinyConfirm, type ConfirmTimers } from './shinyConfirm';
import { createAppStore, type AppStore, type StatePersistence } from './store';

const MALFORMED = 'Biolume+Not+A+Key';

/**
 * Behaves like Electron's `globalShortcut` on Windows: a malformed accelerator
 * throws (in `register` and in `isRegistered`), a key owned by another
 * application is refused, everything else is held until it is unregistered.
 */
function createFakeOs(takenByOthers: readonly string[] = []) {
  const held = new Map<string, () => void>();
  const assertValid = (accelerator: string): void => {
    if (accelerator.includes('Not+A+Key')) {
      throw new TypeError(`conversion failure from ${accelerator}`);
    }
  };
  const registry: ShortcutRegistry = {
    register(accelerator, callback) {
      assertValid(accelerator);
      if (takenByOthers.includes(accelerator) || held.has(accelerator)) return false;
      held.set(accelerator, callback);
      return true;
    },
    unregister(accelerator) {
      held.delete(accelerator);
    },
    isRegistered(accelerator) {
      assertValid(accelerator);
      return held.has(accelerator);
    },
  };
  return {
    registry,
    /** What the OS holds for this app right now. */
    heldKeys: (): string[] => [...held.keys()].sort(),
    press: (accelerator: string): void => held.get(accelerator)?.(),
  };
}

/** Hand-driven timers for the controller's held-key check on Shiny Found. */
function createManualTimers() {
  let next = 0;
  const pending = new Map<number, () => void>();
  const timers: ConfirmTimers = {
    set(callback) {
      next += 1;
      pending.set(next, callback);
      return next;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    /** Fires every pending timer, oldest first. */
    runAll(): void {
      for (const [id, callback] of [...pending]) {
        if (!pending.delete(id)) continue;
        callback();
      }
    },
  };
}

interface Harness {
  store: AppStore;
  os: ReturnType<typeof createFakeOs>;
  hotkeys: HotkeyController;
  window: { focused: boolean };
  broadcasts: HotkeyStatus[];
  /** Fires the controller's pending timers (the Shiny Found held-key check). */
  runTimers: () => void;
}

/** The controller wired the way `main.ts` wires it: every settings change refreshes it. */
function setup(takenByOthers: readonly string[] = []): Harness {
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
  const store = createAppStore(persistence);
  const os = createFakeOs(takenByOthers);
  // Hidden main window, as while the mini-overlay is open or a game has focus.
  const window = { focused: false };
  const broadcasts: HotkeyStatus[] = [];
  let clock = 0;
  const shiny = createShinyConfirm({
    store,
    now: () => clock,
    // Never expires on its own here; shinyConfirm.test.ts covers the timer.
    timers: { set: () => null, clear: () => undefined },
  });
  const manual = createManualTimers();
  const hotkeys = createHotkeyController({
    shortcuts: os.registry,
    store,
    shiny,
    host: {
      isMainFocused: () => window.focused,
      toggleOverlay: () => undefined,
      broadcast: (_channel, payload) => broadcasts.push(payload as HotkeyStatus),
    },
    // Far apart, so the auto-repeat guard never interferes — but inside the confirmation window.
    now: () => (clock += 1_000),
    timers: manual.timers,
  });
  store.subscribe((event) => {
    if (event.type === 'settings-changed') hotkeys.refresh();
  });
  hotkeys.refresh();
  return { store, os, hotkeys, window, broadcasts, runTimers: manual.runAll };
}

/** The accelerators a status claims the OS holds. */
function reportedKeys(status: HotkeyStatus): string[] {
  return status.registrations
    .filter((entry) => entry.registered)
    .map((entry) => entry.accelerator)
    .sort();
}

describe('createHotkeyController', () => {
  it('registers exactly the configured bindings while the main window is hidden', () => {
    const { os, hotkeys } = setup();
    const status = hotkeys.getStatus();
    expect(status.mode).toBe('active');
    expect(os.heldKeys()).toEqual(['CommandOrControl+Shift+B', 'numadd', 'numsub']);
    expect(reportedKeys(status)).toEqual(os.heldKeys());
  });

  it('re-enabling together with a duplicate and a malformed binding leaves the OS in sync', () => {
    const { store, os, hotkeys, broadcasts } = setup();

    store.updateSettings({ hotkeys: { globalEnabled: false } });
    expect(hotkeys.getStatus().mode).toBe('disabled');
    expect(os.heldKeys()).toEqual([]);

    store.updateSettings({
      hotkeys: { globalEnabled: true, bindings: { undo: ['numadd'], logPhase: [MALFORMED] } },
    });
    const status = hotkeys.getStatus();
    expect(status.mode).toBe('active');
    expect(status.registrations).toEqual([
      { action: 'increment', accelerator: 'numadd', registered: true },
      { action: 'decrement', accelerator: 'numsub', registered: true },
      { action: 'undo', accelerator: 'numadd', registered: false, error: DUPLICATE_BINDING_ERROR },
      {
        action: 'logPhase',
        accelerator: MALFORMED,
        registered: false,
        error: expect.stringContaining('Not a valid shortcut') as string,
      },
      { action: 'toggleOverlay', accelerator: 'CommandOrControl+Shift+B', registered: true },
    ]);

    // The OS holds the registered combinations and nothing else: the duplicate's key through its
    // owner — which is why "is this accelerator held?" must not be asked per binding.
    expect(os.heldKeys()).toEqual(reportedKeys(status));
    expect(os.registry.isRegistered('numadd')).toBe(true);
    expect(findRegistrationMismatches(status, os.registry.isRegistered, 'win32')).toEqual([]);
    expect(broadcasts.at(-1)).toEqual(status);

    // The key that is bound twice still runs its first action only.
    const hunt = store.getActiveHunt();
    expect(hunt).not.toBeNull();
    os.press('numadd');
    expect(store.getActiveHunt()?.count).toBe((hunt?.count ?? 0) + (hunt?.step ?? 1));
    expect(store.getActiveHunt()?.phases).toHaveLength(hunt?.phases.length ?? 0);
  });

  it('never leaves a removed or replaced accelerator registered', () => {
    const { store, os, hotkeys } = setup();
    store.updateSettings({ hotkeys: { bindings: { increment: ['F9'], decrement: [] } } });
    expect(os.heldKeys()).toEqual(['CommandOrControl+Shift+B', 'F9']);
    expect(reportedKeys(hotkeys.getStatus())).toEqual(os.heldKeys());
  });

  it('reports a key owned by another application and does not claim it', () => {
    const { os, hotkeys } = setup(['numsub']);
    const status = hotkeys.getStatus();
    expect(status.registrations.find((entry) => entry.accelerator === 'numsub')).toEqual({
      action: 'decrement',
      accelerator: 'numsub',
      registered: false,
      error: OS_REFUSED_ERROR,
    });
    expect(os.heldKeys()).toEqual(reportedKeys(status));
    expect(findRegistrationMismatches(status, os.registry.isRegistered, 'win32')).toEqual([]);
  });

  it('holds nothing while Biolume is focused or recording, and takes the keys back afterwards', () => {
    const { os, hotkeys, window } = setup();
    window.focused = true;
    hotkeys.handleMainActivity('focus');
    expect(hotkeys.getStatus().mode).toBe('app-focused');
    expect(os.heldKeys()).toEqual([]);
    // `registered` now means "available": the comparison must not expect the OS to hold it.
    expect(reportedKeys(hotkeys.getStatus())).toHaveLength(3);
    expect(
      findRegistrationMismatches(hotkeys.getStatus(), os.registry.isRegistered, 'win32'),
    ).toEqual([]);

    hotkeys.setCapturing(true);
    expect(hotkeys.getStatus().mode).toBe('capturing');
    expect(os.heldKeys()).toEqual([]);

    window.focused = false;
    hotkeys.handleMainActivity('blur');
    expect(hotkeys.getStatus().mode).toBe('active');
    expect(os.heldKeys()).toEqual(reportedKeys(hotkeys.getStatus()));
  });
});

describe('the shinyFound hotkey', () => {
  it('arms on the first press and completes the hunt on the second, undoably', () => {
    const { store, os, runTimers } = setup();
    store.updateSettings({ hotkeys: { bindings: { shinyFound: ['F16'] } } });
    expect(os.heldKeys()).toContain('F16');
    const hunt = store.getActiveHunt();
    expect(hunt?.status).toBe('active');
    const sources: string[] = [];
    store.subscribe((event) => {
      if (event.type === 'hunt-changed')
        sources.push(`${event.change.kind}:${event.change.source}`);
    });

    os.press('F16');
    expect(store.getActiveHunt()?.status).toBe('active');
    os.press('F16');
    // The confirming press waits out the held-key check first.
    expect(store.getActiveHunt()?.status).toBe('active');
    runTimers();
    expect(store.getActiveHunt()?.status).toBe('completed');
    expect(sources).toEqual(['completed:hotkey-global']);

    // A third press finds a completed hunt and does nothing; undo takes the completion back.
    os.press('F16');
    expect(store.getActiveHunt()?.status).toBe('completed');
    store.undo(hunt?.id ?? '', 'hotkey-global');
    expect(store.getActiveHunt()?.status).toBe('active');
  });

  it('is disarmed by a count in between', () => {
    const { store, os, runTimers } = setup();
    store.updateSettings({ hotkeys: { bindings: { shinyFound: ['F16'] } } });
    os.press('F16');
    os.press('numadd');
    os.press('F16');
    runTimers();
    expect(store.getActiveHunt()?.status).toBe('active');
  });

  it('only arms while the key is held down, however long', () => {
    const { store, os, runTimers, broadcasts } = setup();
    store.updateSettings({ hotkeys: { bindings: { shinyFound: ['F16'] } } });
    broadcasts.length = 0;

    // The press, then the first auto-repeat (past the repeat guard) and the repeats behind it.
    for (let trigger = 0; trigger < 6; trigger++) os.press('F16');
    runTimers();
    expect(store.getActiveHunt()?.status).toBe('active');
    // Only the arming press was acted on.
    expect(broadcasts.filter((payload) => 'action' in payload)).toHaveLength(1);

    // Released, then pressed again on purpose inside the window: that confirms.
    os.press('F16');
    expect(store.getActiveHunt()?.status).toBe('active');
    runTimers();
    expect(store.getActiveHunt()?.status).toBe('completed');
  });

  it('drops a confirmation still waiting for the held-key check on dispose', () => {
    const { store, os, hotkeys, runTimers } = setup();
    store.updateSettings({ hotkeys: { bindings: { shinyFound: ['F16'] } } });
    os.press('F16');
    os.press('F16');
    hotkeys.dispose();
    runTimers();
    expect(store.getActiveHunt()?.status).toBe('active');
  });
});

describe('findRegistrationMismatches', () => {
  const status: HotkeyStatus = {
    mode: 'active',
    registrations: [
      { action: 'increment', accelerator: 'numadd', registered: true },
      { action: 'undo', accelerator: 'NumAdd', registered: false, error: DUPLICATE_BINDING_ERROR },
      { action: 'decrement', accelerator: 'numsub', registered: false, error: OS_REFUSED_ERROR },
    ],
  };

  it('accepts a duplicate whose key is held by its owner', () => {
    const held = new Set(['numadd']);
    expect(
      findRegistrationMismatches(status, (key) => held.has(key.toLowerCase()), 'win32'),
    ).toEqual([]);
  });

  it('names a registered key the OS lost and a key it should not hold', () => {
    const held = new Set(['numsub']);
    const mismatches = findRegistrationMismatches(status, (key) => held.has(key), 'win32');
    expect(mismatches).toHaveLength(2);
    expect(mismatches[0]).toContain('"numadd" is reported as registered');
    expect(mismatches[1]).toContain('"numsub" is held by the OS');
  });

  it('expects nothing to be held outside the active mode', () => {
    const paused: HotkeyStatus = { ...status, mode: 'app-focused' };
    expect(findRegistrationMismatches(paused, () => false, 'win32')).toEqual([]);
    expect(findRegistrationMismatches(paused, (key) => key === 'numadd', 'win32')).toHaveLength(1);
  });
});
