import { describe, expect, it, vi } from 'vitest';
import { SHINY_CONFIRM_WINDOW_MS } from '@shared/streamDeck';
import type { ShinyArmedEvent, StateEvent } from '@shared/types';
import { installMockBiolume, makeHunt, makePhase, makeSettings } from './index';

function record(mock: ReturnType<typeof installMockBiolume>): StateEvent[] {
  const events: StateEvent[] = [];
  mock.api.state.subscribe((event) => events.push(event));
  return events;
}

describe('installMockBiolume', () => {
  it('installs itself as window.biolume and removes itself again', () => {
    const mock = installMockBiolume({ windowKind: 'overlay', platform: 'darwin' });
    expect(window.biolume).toBe(mock.api);
    expect(window.biolume.windowKind).toBe('overlay');
    expect(window.biolume.platform).toBe('darwin');
    mock.restore();
    expect((window as { biolume?: unknown }).biolume).toBeUndefined();
  });

  it('serves a deep copy of the seeded state', async () => {
    const hunt = makeHunt({ count: 3 });
    const mock = installMockBiolume({ hunts: [hunt], activeHuntId: hunt.id });

    const snapshot = await mock.api.state.get();
    expect(snapshot.hunts).toEqual([hunt]);
    expect(snapshot.hunts[0]).not.toBe(hunt);

    const first = snapshot.hunts[0];
    if (first) first.count = 999;
    expect(mock.getState().hunts[0]?.count).toBe(3);
  });

  it('creates hunts, activates them and broadcasts both events', async () => {
    const mock = installMockBiolume();
    const events = record(mock);

    const hunt = await mock.api.hunts.create({ name: 'Shiny Eevee', step: 5 });

    expect(hunt).toMatchObject({ name: 'Shiny Eevee', step: 5, count: 0, status: 'active' });
    expect(mock.getState().activeHuntId).toBe(hunt.id);
    expect(events.map((event) => event.type)).toEqual(['hunt-changed', 'active-hunt-changed']);

    const background = await mock.api.hunts.create({ name: 'Later', activate: false });
    expect(mock.getState().activeHuntId).toBe(hunt.id);
    expect(mock.getState().hunts.map((entry) => entry.id)).toEqual([hunt.id, background.id]);
  });

  it('adjusts counts, clamps at zero and reports the real delta', async () => {
    const hunt = makeHunt({ count: 2 });
    const mock = installMockBiolume({ hunts: [hunt], activeHuntId: hunt.id });
    const events = record(mock);

    const up = await mock.api.hunts.adjustCount(hunt.id, 3, 'hotkey-global');
    expect(up.count).toBe(5);

    const down = await mock.api.hunts.adjustCount(hunt.id, -50, 'ui');
    expect(down.count).toBe(0);

    const changes = events.flatMap((event) =>
      event.type === 'hunt-changed' ? [event.change] : [],
    );
    expect(changes).toEqual([
      { kind: 'increment', delta: 3, source: 'hotkey-global' },
      { kind: 'decrement', delta: -5, source: 'ui' },
    ]);
    // Counting opens a session.
    expect(mock.getState().sessions).toHaveLength(1);
    expect(mock.getState().sessions[0]).toMatchObject({
      huntId: hunt.id,
      startCount: 2,
      endCount: 0,
    });
  });

  it('logs phases, folding the count into priorCount unless told otherwise', async () => {
    const hunt = makeHunt({ count: 120, priorCount: 30 });
    const mock = installMockBiolume({ hunts: [hunt], activeHuntId: hunt.id });

    const logged = await mock.api.hunts.logPhase(hunt.id, {
      speciesId: 263,
      speciesName: 'Zigzagoon',
    });
    expect(logged).toMatchObject({ count: 0, priorCount: 150 });
    expect(logged.phases[0]).toMatchObject({
      speciesName: 'Zigzagoon',
      encounters: 120,
      totalEncounters: 150,
    });

    const kept = await mock.api.hunts.logPhase(hunt.id, {
      speciesId: null,
      speciesName: '',
      resetCount: false,
    });
    expect(kept).toMatchObject({ count: 0, priorCount: 150 });
    expect(kept.phases).toHaveLength(2);

    const phaseId = kept.phases[1]?.id ?? '';
    const named = await mock.api.hunts.updatePhase(hunt.id, phaseId, { speciesName: 'Poochyena' });
    expect(named.phases[1]?.speciesName).toBe('Poochyena');

    const removed = await mock.api.hunts.removePhase(hunt.id, phaseId);
    expect(removed.phases).toHaveLength(1);
    // Removing a log entry leaves the counts alone.
    expect(removed).toMatchObject({ count: 0, priorCount: 150 });
  });

  it('undoes count, phase and completion changes in reverse order', async () => {
    const hunt = makeHunt({ count: 10 });
    const mock = installMockBiolume({ hunts: [hunt], activeHuntId: hunt.id });

    await mock.api.hunts.adjustCount(hunt.id, 5, 'ui');
    await mock.api.hunts.logPhase(hunt.id, { speciesId: null, speciesName: '' });
    await mock.api.hunts.complete(hunt.id, { notes: 'Finally!' });
    expect(mock.getState().hunts[0]).toMatchObject({ status: 'completed', notes: 'Finally!' });

    expect(await mock.api.hunts.undo(hunt.id)).toMatchObject({
      status: 'active',
      completedAt: null,
    });
    expect(await mock.api.hunts.undo(hunt.id)).toMatchObject({
      count: 15,
      priorCount: 0,
      phases: [],
    });
    expect(await mock.api.hunts.undo(hunt.id)).toMatchObject({ count: 10 });
    expect(await mock.api.hunts.undo(hunt.id)).toBeNull();
  });

  it('rejects unknown hunts and phases like the real bridge', async () => {
    const hunt = makeHunt({ phases: [makePhase({ id: 'p1' })] });
    const mock = installMockBiolume({ hunts: [hunt] });

    await expect(mock.api.hunts.adjustCount('nope', 1, 'ui')).rejects.toThrow('Unknown hunt: nope');
    await expect(mock.api.hunts.setActive('nope')).rejects.toThrow('Unknown hunt');
    await expect(mock.api.hunts.updatePhase(hunt.id, 'p2', { notes: '' })).rejects.toThrow(
      'Unknown phase: p2',
    );
    await expect(mock.api.shell.openExternal('https://example.com')).rejects.toThrow(
      'Blocked external URL',
    );
    await expect(
      mock.api.shell.openExternal('https://pokeapi.co/docs/v2'),
    ).resolves.toBeUndefined();
  });

  it('removes hunts and clears the active id', async () => {
    const hunt = makeHunt();
    const mock = installMockBiolume({ hunts: [hunt], activeHuntId: hunt.id });
    const events = record(mock);

    await mock.api.hunts.remove(hunt.id);

    expect(mock.getState()).toMatchObject({ hunts: [], activeHuntId: null });
    expect(events).toEqual([
      { type: 'hunt-removed', huntId: hunt.id },
      { type: 'active-hunt-changed', activeHuntId: null },
    ]);
  });

  it('merges settings patches per section and per binding', async () => {
    const mock = installMockBiolume({ settings: makeSettings({ audio: { volume: 0.9 } }) });

    const settings = await mock.api.settings.update({
      audio: { pack: 'click' },
      hotkeys: { bindings: { undo: ['CommandOrControl+Z'] } },
    });

    expect(settings.audio).toMatchObject({ volume: 0.9, pack: 'click', enabled: true });
    expect(settings.hotkeys.bindings.undo).toEqual(['CommandOrControl+Z']);
    expect(settings.hotkeys.bindings.increment).toEqual(['numadd']);
    expect((await mock.api.settings.reset()).audio.volume).toBe(0.5);
  });

  it('tracks hotkey capture and window state, notifying listeners', async () => {
    const mock = installMockBiolume({ hotkeyStatus: { mode: 'active', registrations: [] } });
    const onStatus = vi.fn();
    const onWindow = vi.fn();
    const stopStatus = mock.api.hotkeys.onStatus(onStatus);
    mock.api.window.onState(onWindow);

    await mock.api.hotkeys.setCapturing(true);
    expect(onStatus).toHaveBeenLastCalledWith({ mode: 'capturing', registrations: [] });
    await mock.api.hotkeys.setCapturing(false);
    expect(onStatus).toHaveBeenLastCalledWith({ mode: 'active', registrations: [] });

    await mock.api.window.setOverlayOpen(true);
    mock.api.window.toggleMaximize();
    expect(onWindow).toHaveBeenLastCalledWith(
      expect.objectContaining({ overlayOpen: true, maximized: true }),
    );
    expect(await mock.api.window.getState()).toMatchObject({ overlayOpen: true, maximized: true });

    stopStatus();
    mock.setHotkeyStatus({ mode: 'disabled', registrations: [] });
    expect(onStatus).toHaveBeenCalledTimes(2);
  });

  it('needs two Shiny Found requests within the window, announcing each step', async () => {
    vi.useFakeTimers();
    try {
      const hunt = makeHunt();
      const mock = installMockBiolume({ hunts: [hunt], activeHuntId: hunt.id });
      const armedEvents: ShinyArmedEvent[] = [];
      mock.api.hunts.onShinyArmed((event) => armedEvents.push(event));
      const events = record(mock);

      const first = await mock.api.hunts.requestShinyFound(hunt.id, 'streamdeck');
      expect(first).toMatchObject({ completed: false, hunt: { status: 'active' } });
      expect(first.armedUntil).toBe(Date.now() + SHINY_CONFIRM_WINDOW_MS);

      // The window runs out: the next press arms again instead of completing.
      vi.advanceTimersByTime(SHINY_CONFIRM_WINDOW_MS);
      const again = await mock.api.hunts.requestShinyFound(hunt.id, 'streamdeck');
      expect(again.completed).toBe(false);

      const confirmed = await mock.api.hunts.requestShinyFound(hunt.id, 'streamdeck');
      expect(confirmed).toMatchObject({ completed: true, armedUntil: null });
      expect(mock.getState().hunts[0]?.status).toBe('completed');
      expect(armedEvents.map((event) => event.armedUntil === null)).toEqual([
        false,
        true,
        false,
        true,
      ]);
      expect(events.at(-1)).toMatchObject({
        type: 'hunt-changed',
        change: { kind: 'completed', source: 'streamdeck' },
      });

      await expect(mock.api.hunts.requestShinyFound(hunt.id, 'streamdeck')).rejects.toThrow(
        'needs an active hunt',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a Stream Deck bridge that follows settings.streamDeck.enabled', async () => {
    const mock = installMockBiolume({ streamDeckStatus: { clients: 2 } });
    const onStatus = vi.fn();
    mock.api.streamDeck.onStatus(onStatus);

    expect(await mock.api.streamDeck.getStatus()).toMatchObject({
      enabled: true,
      listening: true,
      clients: 2,
      pluginBundled: true,
    });
    await mock.api.settings.update({ streamDeck: { enabled: false } });
    expect(onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false, listening: false, port: null, clients: 0 }),
    );
    await expect(mock.api.streamDeck.installPlugin()).resolves.toEqual({ ok: true });

    mock.setStreamDeckStatus({ pluginBundled: false });
    await expect(mock.api.streamDeck.installPlugin()).resolves.toMatchObject({ ok: false });
  });

  it('lets a test inject failures and custom results through the vi.fn spies', async () => {
    const mock = installMockBiolume();
    mock.api.data.exportData.mockResolvedValueOnce({ canceled: true, filePath: null, records: 0 });
    mock.api.hunts.create.mockRejectedValueOnce(new Error('disk full'));

    await expect(
      mock.api.data.exportData({ dataset: 'backup', format: 'json' }),
    ).resolves.toMatchObject({
      canceled: true,
    });
    await expect(mock.api.hunts.create({})).rejects.toThrow('disk full');
    await expect(
      mock.api.data.exportData({ dataset: 'sessions', format: 'csv' }),
    ).resolves.toMatchObject({
      canceled: false,
      records: 0,
    });
  });
});
