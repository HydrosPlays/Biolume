import { describe, expect, it, vi } from 'vitest';
import { SHINY_CONFIRM_WINDOW_MS } from '@shared/streamDeck';
import type { AppState, HuntChange, StateEvent } from '@shared/types';
import { installMockBiolume, makeHunt, makeSession, makeSettings } from '@renderer/test';
import * as actions from './actions';
import {
  applyShinyArmedEvent,
  applyStateEvent,
  getActiveHunt,
  initStore,
  resetStore,
  selectActiveHunt,
  selectHunt,
  shinyArmedRemaining,
  useAppStore,
} from './appStore';
import { useUiStore } from './uiStore';

const increment: HuntChange = { kind: 'increment', delta: 1, source: 'ui' };

describe('applyStateEvent', () => {
  const base = () => useAppStore.getState();

  it('replaces a known hunt in place and records lastChange', () => {
    const first = makeHunt({ id: 'a' });
    const second = makeHunt({ id: 'b' });
    const state = { ...base(), hunts: [first, second] };
    const updated = { ...second, count: 7 };

    const patch = applyStateEvent(
      state,
      { type: 'hunt-changed', hunt: updated, change: increment },
      1234,
    );

    expect(patch.hunts).toEqual([first, updated]);
    expect(patch.hunts?.[0]).toBe(first);
    expect(patch.lastChange).toEqual({ huntId: 'b', change: increment, at: 1234 });
  });

  it('appends a hunt it has not seen before', () => {
    const existing = makeHunt({ id: 'a' });
    const created = makeHunt({ id: 'new' });
    const patch = applyStateEvent(
      { ...base(), hunts: [existing] },
      { type: 'hunt-changed', hunt: created, change: { kind: 'created', delta: 0, source: 'ui' } },
      1,
    );
    expect(patch.hunts?.map((hunt) => hunt.id)).toEqual(['a', 'new']);
  });

  it('does not flag feedback for silent replays', () => {
    const hunt = makeHunt({ id: 'a' });
    const patch = applyStateEvent(base(), { type: 'hunt-changed', hunt, change: increment }, 1, {
      silent: true,
    });
    expect(patch.hunts).toEqual([hunt]);
    expect('lastChange' in patch).toBe(false);
  });

  it('removes a hunt and clears a dangling active id', () => {
    const a = makeHunt({ id: 'a' });
    const b = makeHunt({ id: 'b' });
    const state = { ...base(), hunts: [a, b], activeHuntId: 'a' };

    expect(applyStateEvent(state, { type: 'hunt-removed', huntId: 'a' }, 1)).toEqual({
      hunts: [b],
      activeHuntId: null,
    });
    expect(applyStateEvent(state, { type: 'hunt-removed', huntId: 'b' }, 1)).toEqual({
      hunts: [a],
    });
  });

  it('applies the simple replacement events', () => {
    const settings = makeSettings({ audio: { volume: 0.1 } });
    const sessions = [makeSession()];
    expect(applyStateEvent(base(), { type: 'active-hunt-changed', activeHuntId: 'x' }, 1)).toEqual({
      activeHuntId: 'x',
    });
    expect(applyStateEvent(base(), { type: 'settings-changed', settings }, 1)).toEqual({
      settings,
    });
    expect(applyStateEvent(base(), { type: 'sessions-changed', sessions }, 1)).toEqual({
      sessions,
    });
  });

  it('swaps everything on state-replaced and clears lastChange and pending confirmations', () => {
    const replacement: AppState = {
      settings: makeSettings({ general: { reducedMotion: 'on' } }),
      hunts: [makeHunt({ id: 'imported' })],
      activeHuntId: 'imported',
      sessions: [],
    };
    const patch = applyStateEvent(
      {
        ...base(),
        lastChange: { huntId: 'old', change: increment, at: 1 },
        shinyArmed: { old: { armedUntil: 5_000, source: 'streamdeck' } },
      },
      { type: 'state-replaced', state: replacement },
      2,
    );
    expect(patch).toEqual({ ...replacement, lastChange: null, shinyArmed: {} });
  });

  it('drops a pending Shiny Found confirmation once the hunt is completed or removed', () => {
    const hunt = makeHunt({ id: 'a' });
    const armed = {
      a: { armedUntil: 5_000, source: 'streamdeck' as const },
      b: { armedUntil: 6_000, source: 'hotkey-global' as const },
    };
    const state = { ...base(), hunts: [hunt], shinyArmed: armed };

    const counted = applyStateEvent(
      state,
      { type: 'hunt-changed', hunt: { ...hunt, count: 1 }, change: increment },
      1,
    );
    expect('shinyArmed' in counted).toBe(false);

    const completed = applyStateEvent(
      state,
      {
        type: 'hunt-changed',
        hunt: { ...hunt, status: 'completed' },
        change: { kind: 'completed', delta: 0, source: 'ui' },
      },
      1,
    );
    expect(completed.shinyArmed).toEqual({ b: armed.b });

    const removed = applyStateEvent(state, { type: 'hunt-removed', huntId: 'b' }, 1);
    expect(removed.shinyArmed).toEqual({ a: armed.a });
  });
});

describe('applyShinyArmedEvent', () => {
  it('arms, re-arms and clears one hunt at a time', () => {
    const armed = applyShinyArmedEvent(
      { shinyArmed: {} },
      { huntId: 'a', armedUntil: 4_000, source: 'streamdeck' },
    );
    expect(armed.shinyArmed).toEqual({ a: { armedUntil: 4_000, source: 'streamdeck' } });

    const rearmed = applyShinyArmedEvent(
      { shinyArmed: armed.shinyArmed ?? {} },
      { huntId: 'a', armedUntil: 9_000, source: 'hotkey-global' },
    );
    expect(rearmed.shinyArmed).toEqual({ a: { armedUntil: 9_000, source: 'hotkey-global' } });

    const cleared = applyShinyArmedEvent(
      { shinyArmed: rearmed.shinyArmed ?? {} },
      { huntId: 'a', armedUntil: null, source: 'hotkey-global' },
    );
    expect(cleared.shinyArmed).toEqual({});
  });

  it('ignores malformed events and clearing what is not armed', () => {
    const state = { shinyArmed: { a: { armedUntil: 4_000, source: 'ui' as const } } };
    expect(
      applyShinyArmedEvent(state, { huntId: '', armedUntil: 1, source: 'streamdeck' }),
    ).toEqual({});
    expect(
      applyShinyArmedEvent(state, { huntId: 'a', armedUntil: Number.NaN, source: 'streamdeck' }),
    ).toEqual({});
    expect(
      applyShinyArmedEvent(state, { huntId: 'zzz', armedUntil: null, source: 'streamdeck' }),
    ).toEqual({});
  });

  it('measures what is left of the window, never more than the window itself', () => {
    expect(shinyArmedRemaining({ armedUntil: 10_000 }, 9_000)).toBe(1_000);
    expect(shinyArmedRemaining({ armedUntil: 10_000 }, 11_000)).toBe(0);
    expect(shinyArmedRemaining({ armedUntil: 1_000_000 }, 0)).toBe(SHINY_CONFIRM_WINDOW_MS);
  });
});

describe('selectors', () => {
  it('resolve the active hunt and hunts by id', () => {
    const a = makeHunt({ id: 'a' });
    const b = makeHunt({ id: 'b' });
    expect(selectActiveHunt({ hunts: [a, b], activeHuntId: 'b' })).toBe(b);
    expect(selectActiveHunt({ hunts: [a, b], activeHuntId: null })).toBeNull();
    expect(selectActiveHunt({ hunts: [a], activeHuntId: 'gone' })).toBeNull();
    expect(selectHunt({ hunts: [a, b] }, 'a')).toBe(a);
    expect(selectHunt({ hunts: [a, b] }, undefined)).toBeNull();
    expect(selectHunt({ hunts: [a, b] }, 'zzz')).toBeNull();
  });
});

describe('initStore', () => {
  it('loads the snapshot, hotkey status and window state', async () => {
    const hunt = makeHunt({ count: 12 });
    installMockBiolume({
      hunts: [hunt],
      activeHuntId: hunt.id,
      sessions: [makeSession({ huntId: hunt.id })],
      settings: makeSettings({ audio: { pack: 'chime' } }),
      hotkeyStatus: { mode: 'active', registrations: [] },
      windowState: { maximized: true },
    });

    expect(useAppStore.getState().ready).toBe(false);
    await initStore();

    const state = useAppStore.getState();
    expect(state.ready).toBe(true);
    expect(state.loadError).toBeNull();
    expect(state.hunts).toEqual([hunt]);
    expect(state.activeHuntId).toBe(hunt.id);
    expect(state.sessions).toHaveLength(1);
    expect(state.settings.audio.pack).toBe('chime');
    expect(state.hotkeyStatus.mode).toBe('active');
    expect(state.windowState.maximized).toBe(true);
    expect(state.lastChange).toBeNull();
    expect(getActiveHunt()).toEqual(hunt);
  });

  it('is idempotent', async () => {
    const mock = installMockBiolume();
    const first = initStore();
    const second = initStore();
    expect(second).toBe(first);
    await first;
    await initStore();
    expect(mock.api.state.get).toHaveBeenCalledTimes(1);
    expect(mock.api.state.subscribe).toHaveBeenCalledTimes(1);
  });

  it('follows state events after boot — and only then changes', async () => {
    const hunt = makeHunt();
    const mock = installMockBiolume({ hunts: [hunt], activeHuntId: hunt.id });
    await initStore();

    // No optimistic write: the call alone must not have touched the store.
    const pending = mock.api.hunts.adjustCount(hunt.id, 3, 'hotkey-global');
    expect(useAppStore.getState().hunts[0]?.count).toBe(0);
    await pending;

    const state = useAppStore.getState();
    expect(state.hunts[0]?.count).toBe(3);
    expect(state.lastChange).toMatchObject({
      huntId: hunt.id,
      change: { kind: 'increment', delta: 3, source: 'hotkey-global' },
    });
    expect(state.sessions).toHaveLength(1);
  });

  it('gives every change a fresh lastChange object', async () => {
    const hunt = makeHunt();
    const mock = installMockBiolume({ hunts: [hunt], activeHuntId: hunt.id });
    await initStore();

    await mock.api.hunts.adjustCount(hunt.id, 1, 'ui');
    const first = useAppStore.getState().lastChange;
    await mock.api.hunts.adjustCount(hunt.id, 1, 'ui');
    const second = useAppStore.getState().lastChange;

    expect(first).not.toBeNull();
    expect(second).not.toBe(first);
    expect(second?.change).toEqual(first?.change);
  });

  it('follows hotkey status and window state pushes', async () => {
    const mock = installMockBiolume();
    await initStore();

    mock.setHotkeyStatus({
      mode: 'active',
      registrations: [{ action: 'increment', accelerator: 'numadd', registered: true }],
    });
    mock.setWindowState({ focused: false, overlayOpen: true });

    const state = useAppStore.getState();
    expect(state.hotkeyStatus.mode).toBe('active');
    expect(state.hotkeyStatus.registrations).toHaveLength(1);
    expect(state.windowState).toMatchObject({ focused: false, overlayOpen: true });
  });

  it('replays events that arrive before the snapshot, without feedback', async () => {
    const hunt = makeHunt({ id: 'h', count: 5 });
    const mock = installMockBiolume({ hunts: [hunt], activeHuntId: 'h' });

    // Hold the snapshot back until an event has been pushed.
    let release: (state: AppState) => void = () => undefined;
    mock.api.state.get.mockImplementationOnce(
      () =>
        new Promise<AppState>((resolve) => {
          release = resolve;
        }),
    );

    const boot = initStore();
    const racing: StateEvent = {
      type: 'hunt-changed',
      hunt: { ...hunt, count: 6 },
      change: increment,
    };
    mock.emit(racing);
    expect(useAppStore.getState().ready).toBe(false);

    // The snapshot was taken before the event: it still says 5.
    release({ settings: makeSettings(), hunts: [hunt], activeHuntId: 'h', sessions: [] });
    await boot;

    const state = useAppStore.getState();
    expect(state.ready).toBe(true);
    expect(state.hunts[0]?.count).toBe(6);
    expect(state.lastChange).toBeNull();
  });

  it('prefers a pushed status over the stale answer to getStatus', async () => {
    const mock = installMockBiolume({ hotkeyStatus: { mode: 'disabled', registrations: [] } });
    mock.api.hotkeys.getStatus.mockImplementationOnce(async () => {
      mock.setHotkeyStatus({ mode: 'active', registrations: [] });
      return { mode: 'disabled', registrations: [] };
    });
    await initStore();
    expect(useAppStore.getState().hotkeyStatus.mode).toBe('active');
  });

  it('records a load failure, unsubscribes and can be retried', async () => {
    const mock = installMockBiolume();
    mock.api.state.get.mockRejectedValueOnce(new Error('userData is not readable'));

    await expect(initStore()).rejects.toThrow('userData is not readable');
    expect(useAppStore.getState()).toMatchObject({
      ready: false,
      loadError: 'userData is not readable',
    });

    await initStore();
    expect(useAppStore.getState()).toMatchObject({ ready: true, loadError: null });
    expect(mock.api.state.get).toHaveBeenCalledTimes(2);
  });

  it('stops following events after resetStore', async () => {
    const hunt = makeHunt();
    const mock = installMockBiolume({ hunts: [hunt], activeHuntId: hunt.id });
    await initStore();
    resetStore();

    await mock.api.hunts.adjustCount(hunt.id, 1, 'ui');
    expect(useAppStore.getState().ready).toBe(false);
    expect(useAppStore.getState().hunts).toEqual([]);
  });
});

describe('actions', () => {
  it('resolve with the result and leave the store to the events', async () => {
    const hunt = makeHunt({ step: 5 });
    const mock = installMockBiolume({ hunts: [hunt], activeHuntId: hunt.id });
    await initStore();

    const updated = await actions.incrementHunt(hunt, 'hotkey-local');
    expect(mock.api.hunts.adjustCount).toHaveBeenCalledWith(hunt.id, 5, 'hotkey-local');
    expect(updated?.count).toBe(5);
    expect(useAppStore.getState().hunts[0]?.count).toBe(5);

    await actions.decrementHunt(hunt);
    expect(mock.api.hunts.adjustCount).toHaveBeenLastCalledWith(hunt.id, -5, 'ui');
    expect(useAppStore.getState().hunts[0]?.count).toBe(0);
  });

  it('turn a rejection into an error toast and a null result', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mock = installMockBiolume();
    await initStore();
    mock.api.hunts.adjustCount.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'biolume:hunts:adjust-count': Error: Unknown hunt: nope",
      ),
    );

    await expect(actions.adjustCount('nope', 1)).resolves.toBeNull();

    const [toast] = useUiStore.getState().toasts;
    expect(toast).toMatchObject({
      tone: 'error',
      title: 'Could not update the counter',
      description: 'Unknown hunt: nope',
    });
    consoleError.mockRestore();
  });

  it('do not stack identical failures', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    installMockBiolume();
    await initStore();

    await actions.adjustCount('missing', 1);
    await actions.adjustCount('missing', 1);
    await actions.adjustCount('missing', 1);

    expect(useUiStore.getState().toasts).toHaveLength(1);
    consoleError.mockRestore();
  });

  it('report an empty undo history as information, not an error', async () => {
    const hunt = makeHunt();
    installMockBiolume({ hunts: [hunt], activeHuntId: hunt.id });
    await initStore();

    await expect(actions.undoHunt(hunt.id)).resolves.toBeNull();
    expect(useUiStore.getState().toasts[0]).toMatchObject({
      tone: 'info',
      title: 'Nothing to undo',
    });
  });

  it('toggle the overlay and the pin from the mirrored window state', async () => {
    const mock = installMockBiolume();
    await initStore();

    await actions.toggleOverlay();
    expect(mock.api.window.setOverlayOpen).toHaveBeenLastCalledWith(true);
    expect(useAppStore.getState().windowState.overlayOpen).toBe(true);
    await actions.toggleOverlay();
    expect(mock.api.window.setOverlayOpen).toHaveBeenLastCalledWith(false);

    await actions.toggleAlwaysOnTop();
    expect(mock.api.window.setAlwaysOnTop).toHaveBeenLastCalledWith(true);
  });

  it('skip the confirmation when the user turned it off', async () => {
    installMockBiolume({ settings: makeSettings({ general: { confirmDestructive: false } }) });
    await initStore();
    await expect(actions.confirmDestructive({ title: 'Delete this hunt?' })).resolves.toBe(true);
  });
});

describe('useUiStore', () => {
  it('opens and closes the phase dialog', () => {
    const { openPhaseDialog, closePhaseDialog } = useUiStore.getState();
    openPhaseDialog({ huntId: 'h1' });
    expect(useUiStore.getState().phaseDialog).toEqual({ open: true, huntId: 'h1' });
    openPhaseDialog({ huntId: 'h1', phaseId: 'p9' });
    expect(useUiStore.getState().phaseDialog).toEqual({ open: true, huntId: 'h1', phaseId: 'p9' });
    closePhaseDialog();
    expect(useUiStore.getState().phaseDialog).toEqual({ open: false, huntId: null });
  });

  it('caps the toast stack and replaces toasts that share an id', () => {
    const { pushToast, dismissToast } = useUiStore.getState();
    for (let index = 0; index < 6; index += 1) pushToast('info', `Toast ${index}`);
    expect(useUiStore.getState().toasts.map((toast) => toast.title)).toEqual([
      'Toast 2',
      'Toast 3',
      'Toast 4',
      'Toast 5',
    ]);

    const id = pushToast('success', 'Saved', { id: 'save' });
    pushToast('error', 'Save failed', { id: 'save' });
    const toasts = useUiStore.getState().toasts;
    expect(toasts.filter((toast) => toast.id === id)).toHaveLength(1);
    expect(toasts.at(-1)).toMatchObject({ id: 'save', tone: 'error', title: 'Save failed' });

    dismissToast('save');
    expect(useUiStore.getState().toasts.some((toast) => toast.id === 'save')).toBe(false);
  });
});

describe('Stream Deck and Shiny Found in the store', () => {
  it('mirrors the Stream Deck bridge status and follows its pushes', async () => {
    const mock = installMockBiolume({ streamDeckStatus: { clients: 1, port: 47_700 } });
    await initStore();
    expect(useAppStore.getState().streamDeckStatus).toMatchObject({
      enabled: true,
      listening: true,
      port: 47_700,
      clients: 1,
    });

    mock.setStreamDeckStatus({ clients: 3 });
    expect(useAppStore.getState().streamDeckStatus.clients).toBe(3);

    // Switching the bridge off in settings stops it (the fake main process mirrors that).
    await actions.updateSettings({ streamDeck: { enabled: false } });
    expect(useAppStore.getState().streamDeckStatus).toMatchObject({
      enabled: false,
      listening: false,
      clients: 0,
    });
  });

  it('boots even when the Stream Deck status cannot be read', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mock = installMockBiolume();
    mock.api.streamDeck.getStatus.mockRejectedValueOnce(new Error('bridge exploded'));

    await initStore();
    expect(useAppStore.getState()).toMatchObject({
      ready: true,
      streamDeckStatus: { listening: false, clients: 0 },
    });
    // A later push still lands.
    mock.setStreamDeckStatus({ listening: true, clients: 2 });
    expect(useAppStore.getState().streamDeckStatus.clients).toBe(2);
    consoleWarn.mockRestore();
  });

  it('arms on the first request, completes on the second and clears the pending state', async () => {
    const hunt = makeHunt();
    const mock = installMockBiolume({ hunts: [hunt], activeHuntId: hunt.id });
    await initStore();

    const first = await actions.requestShinyFound(hunt.id, 'hotkey-local');
    expect(first).toMatchObject({ completed: false });
    expect(mock.api.hunts.requestShinyFound).toHaveBeenCalledWith(hunt.id, 'hotkey-local');
    expect(mock.api.hunts.complete).not.toHaveBeenCalled();
    expect(useAppStore.getState().hunts[0]?.status).toBe('active');
    expect(useAppStore.getState().shinyArmed[hunt.id]).toMatchObject({ source: 'hotkey-local' });

    const second = await actions.requestShinyFound(hunt.id, 'hotkey-local');
    expect(second).toMatchObject({ completed: true, armedUntil: null });
    const state = useAppStore.getState();
    expect(state.hunts[0]?.status).toBe('completed');
    expect(state.shinyArmed).toEqual({});
    expect(state.lastChange?.change).toMatchObject({ kind: 'completed', source: 'hotkey-local' });
  });

  it('drops an armed confirmation at its deadline even if main never says so', async () => {
    vi.useFakeTimers();
    try {
      const hunt = makeHunt();
      const mock = installMockBiolume({ hunts: [hunt], activeHuntId: hunt.id });
      await initStore();

      mock.fireShinyArmed({
        huntId: hunt.id,
        armedUntil: Date.now() + SHINY_CONFIRM_WINDOW_MS,
        source: 'streamdeck',
      });
      expect(useAppStore.getState().shinyArmed[hunt.id]).toBeDefined();

      vi.advanceTimersByTime(SHINY_CONFIRM_WINDOW_MS - 100);
      expect(useAppStore.getState().shinyArmed[hunt.id]).toBeDefined();
      vi.advanceTimersByTime(1_000);
      expect(useAppStore.getState().shinyArmed).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a refused request as an error toast and resolves null', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const hunt = makeHunt({ status: 'completed' });
    installMockBiolume({ hunts: [hunt], activeHuntId: hunt.id });
    await initStore();

    await expect(actions.requestShinyFound(hunt.id, 'streamdeck')).resolves.toBeNull();
    expect(useUiStore.getState().toasts[0]).toMatchObject({
      tone: 'error',
      title: 'Could not confirm Shiny Found',
      description: 'Shiny Found needs an active hunt',
    });
    consoleError.mockRestore();
  });

  it('installs the plugin, or explains why it could not', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mock = installMockBiolume();
    await initStore();

    await expect(actions.installStreamDeckPlugin()).resolves.toBe(true);
    expect(mock.api.streamDeck.installPlugin).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().toasts).toHaveLength(0);

    mock.api.streamDeck.installPlugin.mockResolvedValueOnce({
      ok: false,
      error: 'No application is associated with .streamDeckPlugin files.',
    });
    await expect(actions.installStreamDeckPlugin()).resolves.toBe(false);
    expect(useUiStore.getState().toasts[0]).toMatchObject({
      tone: 'error',
      title: 'Could not install the Stream Deck plugin',
      description: 'No application is associated with .streamDeckPlugin files.',
    });

    mock.api.streamDeck.installPlugin.mockRejectedValueOnce(new Error('IPC down'));
    await expect(actions.installStreamDeckPlugin()).resolves.toBe(false);
    consoleError.mockRestore();
  });
});
