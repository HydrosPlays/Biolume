import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SHINY_CONFIRM_WINDOW_MS } from '@shared/streamDeck';
import { initStore } from '@renderer/store/appStore';
import { useUiStore } from '@renderer/store/uiStore';
import { installMockBiolume, makeHunt, makeSettings } from '@renderer/test';
import { useGlobalHotkeyEvents } from './useGlobalHotkeyEvents';
import { describeShinyConfirmation, useShinyConfirmation } from './useShinyConfirmation';
import { describeArmedPrompt, shinyArmedToastId } from './useShinyFoundFeedback';

function toastById(id: string) {
  return useUiStore.getState().toasts.find((entry) => entry.id === id);
}

describe('describeShinyConfirmation', () => {
  it('counts the window down in whole seconds', () => {
    const armed = { armedUntil: 10_000, source: 'streamdeck' as const };
    expect(describeShinyConfirmation(armed, 10_000 - SHINY_CONFIRM_WINDOW_MS)).toMatchObject({
      remainingMs: SHINY_CONFIRM_WINDOW_MS,
      fraction: 1,
      seconds: 3,
    });
    expect(describeShinyConfirmation(armed, 8_500)).toMatchObject({ fraction: 0.5, seconds: 2 });
    expect(describeShinyConfirmation(armed, 9_999)?.seconds).toBe(1);
    expect(describeShinyConfirmation(armed, 10_000)).toBeNull();
    expect(describeShinyConfirmation(null, 0)).toBeNull();
  });
});

describe('useShinyConfirmation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks while armed and ends at the deadline on its own', async () => {
    vi.useFakeTimers();
    const hunt = makeHunt();
    const mock = installMockBiolume({ hunts: [hunt], activeHuntId: hunt.id });
    await initStore();
    const { result } = renderHook(() => useShinyConfirmation(hunt.id));
    expect(result.current).toBeNull();

    mock.fireShinyArmed({
      huntId: hunt.id,
      armedUntil: Date.now() + SHINY_CONFIRM_WINDOW_MS,
      source: 'streamdeck',
    });
    expect(result.current).toMatchObject({ source: 'streamdeck', seconds: 3 });

    act(() => vi.advanceTimersByTime(1_600));
    expect(result.current?.seconds).toBe(2);

    act(() => vi.advanceTimersByTime(1_500));
    expect(result.current).toBeNull();
  });

  it('clears as soon as main reports the confirmation', async () => {
    const hunt = makeHunt();
    const mock = installMockBiolume({ hunts: [hunt], activeHuntId: hunt.id });
    await initStore();
    const { result } = renderHook(() => useShinyConfirmation(hunt.id));

    mock.fireShinyArmed({ huntId: hunt.id, armedUntil: Date.now() + 3_000, source: 'ui' });
    expect(result.current).not.toBeNull();
    mock.fireShinyArmed({ huntId: hunt.id, armedUntil: null, source: 'ui' });
    expect(result.current).toBeNull();
  });
});

describe('describeArmedPrompt', () => {
  it('names the key that has to be pressed again', () => {
    expect(describeArmedPrompt('streamdeck', ['F16'], 3_000, 'Shiny Ralts')).toBe(
      'Press Shiny Found on your Stream Deck again within 3 s to complete “Shiny Ralts”.',
    );
    expect(describeArmedPrompt('hotkey-global', ['F16'], 2_100, 'Shiny Ralts')).toBe(
      'Press F16 again within 3 s to complete “Shiny Ralts”.',
    );
    expect(describeArmedPrompt('hotkey-local', [], 900, null)).toBe(
      'Press Shiny Found again within 1 s to complete the hunt.',
    );
  });
});

describe('Shiny Found toasts (useGlobalHotkeyEvents)', () => {
  it('prompts for the second press while armed and drops the prompt when it expires', async () => {
    const hunt = makeHunt({ name: 'Shiny Ralts' });
    const mock = installMockBiolume({
      hunts: [hunt],
      activeHuntId: hunt.id,
      settings: makeSettings({ hotkeys: { bindings: { shinyFound: ['F16'] } } }),
    });
    await initStore();
    renderHook(() => useGlobalHotkeyEvents());

    mock.fireShinyArmed({ huntId: hunt.id, armedUntil: Date.now() + 3_000, source: 'streamdeck' });
    const prompt = toastById(shinyArmedToastId(hunt.id));
    expect(prompt).toMatchObject({
      tone: 'warning',
      title: 'Press again to confirm Shiny Found',
      description: expect.stringContaining('Stream Deck'),
    });
    expect(prompt?.duration).toBeGreaterThan(2_500);
    expect(prompt?.duration).toBeLessThanOrEqual(3_000);

    mock.fireShinyArmed({ huntId: hunt.id, armedUntil: null, source: 'streamdeck' });
    expect(toastById(shinyArmedToastId(hunt.id))).toBeUndefined();
  });

  it('offers Undo after a confirming press completed the hunt', async () => {
    const hunt = makeHunt({ name: 'Shiny Ralts', count: 812 });
    const mock = installMockBiolume({ hunts: [hunt], activeHuntId: hunt.id });
    await initStore();
    renderHook(() => useGlobalHotkeyEvents());

    await act(async () => {
      await mock.api.hunts.requestShinyFound(hunt.id, 'streamdeck');
    });
    expect(toastById(shinyArmedToastId(hunt.id))).toBeDefined();

    await act(async () => {
      await mock.api.hunts.requestShinyFound(hunt.id, 'streamdeck');
    });
    expect(toastById(shinyArmedToastId(hunt.id))).toBeUndefined();
    const done = toastById(`hunt-completed:${hunt.id}`);
    expect(done).toMatchObject({
      tone: 'success',
      title: 'Shiny found!',
      description: 'Shiny Ralts · 812 encounters',
    });

    await act(async () => {
      done?.action?.onClick();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mock.api.hunts.undo).toHaveBeenCalledWith(hunt.id));
  });

  it('leaves the completion toast of the Hunt view’s own button to that button', async () => {
    const hunt = makeHunt();
    const mock = installMockBiolume({ hunts: [hunt], activeHuntId: hunt.id });
    await initStore();
    renderHook(() => useGlobalHotkeyEvents());

    await act(async () => {
      await mock.api.hunts.complete(hunt.id);
    });
    expect(toastById(`hunt-completed:${hunt.id}`)).toBeUndefined();
  });

  it('stays quiet while the window is hidden', async () => {
    const hunt = makeHunt();
    const mock = installMockBiolume({ hunts: [hunt], activeHuntId: hunt.id });
    await initStore();
    renderHook(() => useGlobalHotkeyEvents());

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      mock.fireShinyArmed({
        huntId: hunt.id,
        armedUntil: Date.now() + 3_000,
        source: 'streamdeck',
      });
      expect(toastById(shinyArmedToastId(hunt.id))).toBeUndefined();
    } finally {
      visibility.mockRestore();
    }
  });

  it('is a no-op in the overlay window', async () => {
    const hunt = makeHunt();
    const mock = installMockBiolume({
      hunts: [hunt],
      activeHuntId: hunt.id,
      windowKind: 'overlay',
    });
    await initStore();
    renderHook(() => useGlobalHotkeyEvents());

    mock.fireShinyArmed({ huntId: hunt.id, armedUntil: Date.now() + 3_000, source: 'streamdeck' });
    expect(useUiStore.getState().toasts).toHaveLength(0);
  });
});
