import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HuntChange } from '@shared/types';
import * as audio from '@renderer/lib/audio';
import { initStore } from '@renderer/store/appStore';
import { installMockBiolume, makeHunt, makeSettings } from '@renderer/test';
import {
  detectMilestone,
  setMilestoneOddsResolver,
  soundForChange,
  useCounterFeedback,
} from './useCounterFeedback';
import { useMotionPreference, useReducedMotion } from './useReducedMotion';
import { getCurrentView, navigate, parseViewHash, useView, viewHref } from './useView';
import { useViewShortcuts } from './useViewShortcuts';

function change(
  kind: HuntChange['kind'],
  source: HuntChange['source'] = 'ui',
  delta = 0,
): HuntChange {
  return { kind, delta, source };
}

describe('soundForChange', () => {
  it('maps counter activity to sounds', () => {
    expect(soundForChange(change('increment', 'hotkey-global', 1))).toBe('increment');
    expect(soundForChange(change('decrement', 'overlay', -1))).toBe('decrement');
    expect(soundForChange(change('undo'))).toBe('decrement');
    expect(soundForChange(change('phase-logged', 'hotkey-local'))).toBe('phase');
    expect(soundForChange(change('completed'))).toBe('complete');
  });

  it('treats Stream Deck presses like hotkeys', () => {
    expect(soundForChange(change('increment', 'streamdeck', 1))).toBe('increment');
    expect(soundForChange(change('decrement', 'streamdeck', -1))).toBe('decrement');
    expect(soundForChange(change('undo', 'streamdeck', -1))).toBe('decrement');
    expect(soundForChange(change('phase-logged', 'streamdeck'))).toBe('phase');
    expect(soundForChange(change('completed', 'streamdeck'))).toBe('complete');
  });

  it('stays silent for edits and for imported or system changes', () => {
    expect(soundForChange(change('edited'))).toBeNull();
    expect(soundForChange(change('set-count'))).toBeNull();
    expect(soundForChange(change('created'))).toBeNull();
    expect(soundForChange(change('increment', 'import', 500))).toBeNull();
    expect(soundForChange(change('increment', 'system', 1))).toBeNull();
  });
});

describe('detectMilestone', () => {
  const p = 1 / 4096;

  it('detects the 50 %, over-odds and 90 % thresholds exactly once each', () => {
    // 50 % at ceil(ln 0.5 / ln(1 − p)) = 2839, odds at 4096, 90 % at 9431.
    expect(detectMilestone(2837, 2838, p)).toBeNull();
    expect(detectMilestone(2838, 2839, p)).toBe('half');
    expect(detectMilestone(2839, 2840, p)).toBeNull();
    expect(detectMilestone(4095, 4096, p)).toBe('over-odds');
    expect(detectMilestone(9430, 9431, p)).toBe('ninety');
    expect(detectMilestone(9431, 9432, p)).toBeNull();
  });

  it('reports the furthest threshold when a big step crosses several', () => {
    expect(detectMilestone(0, 5000, p)).toBe('over-odds');
    expect(detectMilestone(0, 20_000, p)).toBe('ninety');
  });

  it('ignores decrements and unusable probabilities', () => {
    expect(detectMilestone(4096, 4095, p)).toBeNull();
    expect(detectMilestone(10, 10, p)).toBeNull();
    expect(detectMilestone(0, 10_000, 0)).toBeNull();
    expect(detectMilestone(0, 10_000, 1)).toBeNull();
    expect(detectMilestone(0, 10_000, Number.NaN)).toBeNull();
  });
});

describe('useCounterFeedback', () => {
  beforeEach(() => {
    vi.spyOn(audio, 'playSound').mockReturnValue(true);
  });
  afterEach(() => {
    setMilestoneOddsResolver(null);
    vi.restoreAllMocks();
  });

  it('plays a sound for counts from any source — including global hotkeys', async () => {
    const hunt = makeHunt();
    const mock = installMockBiolume({ hunts: [hunt], activeHuntId: hunt.id });
    await initStore();
    renderHook(() => useCounterFeedback());

    await mock.api.hunts.adjustCount(hunt.id, 1, 'hotkey-global');
    expect(audio.playSound).toHaveBeenLastCalledWith(
      'increment',
      expect.objectContaining({ pack: 'sonar' }),
    );

    await mock.api.hunts.adjustCount(hunt.id, -1, 'overlay');
    expect(audio.playSound).toHaveBeenLastCalledWith('decrement', expect.anything());

    await mock.api.hunts.logPhase(hunt.id, { speciesId: null, speciesName: '' });
    expect(audio.playSound).toHaveBeenLastCalledWith('phase', expect.anything());

    await mock.api.hunts.complete(hunt.id);
    expect(audio.playSound).toHaveBeenLastCalledWith('complete', expect.anything());
    expect(audio.playSound).toHaveBeenCalledTimes(4);
  });

  it('plays for counts made on the Stream Deck', async () => {
    const hunt = makeHunt();
    const mock = installMockBiolume({ hunts: [hunt], activeHuntId: hunt.id });
    await initStore();
    renderHook(() => useCounterFeedback());

    await mock.api.hunts.adjustCount(hunt.id, 1, 'streamdeck');
    expect(audio.playSound).toHaveBeenLastCalledWith('increment', expect.anything());
    await mock.api.hunts.adjustCount(hunt.id, -1, 'streamdeck');
    expect(audio.playSound).toHaveBeenLastCalledWith('decrement', expect.anything());
  });

  it('stays silent for edits and uses the current audio settings', async () => {
    const hunt = makeHunt();
    const mock = installMockBiolume({ hunts: [hunt], activeHuntId: hunt.id });
    await initStore();
    renderHook(() => useCounterFeedback());

    await mock.api.hunts.update(hunt.id, { name: 'Renamed' });
    expect(audio.playSound).not.toHaveBeenCalled();

    await mock.api.settings.update({ audio: { pack: 'bubble', volume: 0.2 } });
    await mock.api.hunts.adjustCount(hunt.id, 1, 'ui');
    expect(audio.playSound).toHaveBeenLastCalledWith(
      'increment',
      expect.objectContaining({ pack: 'bubble', volume: 0.2 }),
    );
  });

  it('never plays in the overlay window, so sounds do not double up', async () => {
    const hunt = makeHunt();
    const mock = installMockBiolume({
      hunts: [hunt],
      activeHuntId: hunt.id,
      windowKind: 'overlay',
    });
    await initStore();
    renderHook(() => useCounterFeedback());

    await mock.api.hunts.adjustCount(hunt.id, 1, 'overlay');
    expect(audio.playSound).not.toHaveBeenCalled();
  });

  it('adds the milestone chime when a registered odds resolver reports a crossing', async () => {
    vi.useFakeTimers();
    try {
      const hunt = makeHunt({ count: 9, priorCount: 0 });
      const mock = installMockBiolume({ hunts: [hunt], activeHuntId: hunt.id });
      await initStore();
      // 1 in 10: over odds exactly at 10 encounters.
      setMilestoneOddsResolver(() => 0.1);
      renderHook(() => useCounterFeedback());

      await mock.api.hunts.adjustCount(hunt.id, 1, 'ui');
      expect(audio.playSound).toHaveBeenCalledTimes(1);
      act(() => vi.advanceTimersByTime(200));
      expect(audio.playSound).toHaveBeenLastCalledWith('milestone', expect.anything());

      await mock.api.hunts.adjustCount(hunt.id, 1, 'ui');
      act(() => vi.advanceTimersByTime(200));
      expect(audio.playSound).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips the chime when the setting is off', async () => {
    vi.useFakeTimers();
    try {
      const hunt = makeHunt({ count: 9 });
      const mock = installMockBiolume({
        hunts: [hunt],
        activeHuntId: hunt.id,
        settings: makeSettings({ audio: { milestoneChime: false } }),
      });
      await initStore();
      setMilestoneOddsResolver(() => 0.1);
      renderHook(() => useCounterFeedback());

      await mock.api.hunts.adjustCount(hunt.id, 1, 'ui');
      act(() => vi.advanceTimersByTime(500));
      expect(audio.playSound).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops listening on unmount', async () => {
    const hunt = makeHunt();
    const mock = installMockBiolume({ hunts: [hunt], activeHuntId: hunt.id });
    await initStore();
    const { unmount } = renderHook(() => useCounterFeedback());
    unmount();

    await mock.api.hunts.adjustCount(hunt.id, 1, 'ui');
    expect(audio.playSound).not.toHaveBeenCalled();
  });
});

describe('useView', () => {
  it('parses hashes, falling back for unknown ones', () => {
    expect(parseViewHash('#/odds')).toBe('odds');
    expect(parseViewHash('#odds')).toBe('odds');
    expect(parseViewHash('#/log/sessions')).toBe('log');
    expect(parseViewHash('#/log?hunt=3')).toBe('log');
    expect(parseViewHash('#/nope')).toBeNull();
    expect(parseViewHash('')).toBeNull();
    expect(viewHref('sandwich')).toBe('#/sandwich');
  });

  it('defaults to the hunt view and normalises the address', () => {
    const { result } = renderHook(() => useView());
    expect(result.current[0]).toBe('hunt');
    expect(window.location.hash).toBe('#/hunt');
  });

  it('follows location.hash, whoever changes it', async () => {
    const { result } = renderHook(() => useView());

    act(() => result.current[1]('odds'));
    await vi.waitFor(() => expect(result.current[0]).toBe('odds'));
    expect(window.location.hash).toBe('#/odds');

    // The smoke test drives navigation exactly like this.
    act(() => {
      window.location.hash = '#/settings';
    });
    await vi.waitFor(() => expect(result.current[0]).toBe('settings'));

    act(() => {
      window.location.hash = '#/definitely-not-a-view';
    });
    await vi.waitFor(() => expect(result.current[0]).toBe('hunt'));
    await vi.waitFor(() => expect(window.location.hash).toBe('#/hunt'));
  });

  it('navigates imperatively', async () => {
    navigate('log');
    expect(getCurrentView()).toBe('log');
  });
});

describe('useViewShortcuts', () => {
  it('maps Ctrl+1..6 to the views and ignores other chords', () => {
    renderHook(() => useViewShortcuts());
    const press = (code: string, init: KeyboardEventInit = {}): void => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { code, key: code.slice(-1), cancelable: true, ...init }),
      );
    };

    press('Digit3', { ctrlKey: true });
    expect(getCurrentView()).toBe('odds');
    press('Digit6', { ctrlKey: true });
    expect(getCurrentView()).toBe('settings');

    press('Digit1');
    press('Digit1', { ctrlKey: true, shiftKey: true });
    press('Digit9', { ctrlKey: true });
    expect(getCurrentView()).toBe('settings');

    press('Digit1', { metaKey: true });
    expect(getCurrentView()).toBe('hunt');
  });
});

describe('reduced motion', () => {
  it('mirrors the setting onto <html data-motion>', async () => {
    const mock = installMockBiolume({
      settings: makeSettings({ general: { reducedMotion: 'on' } }),
    });
    await initStore();
    const motion = renderHook(() => useReducedMotion());
    renderHook(() => useMotionPreference());

    expect(document.documentElement.dataset.motion).toBe('reduced');
    expect(motion.result.current).toBe(true);

    await mock.api.settings.update({ general: { reducedMotion: 'off' } });
    expect(document.documentElement.dataset.motion).toBe('full');
    expect(motion.result.current).toBe(false);

    await mock.api.settings.update({ general: { reducedMotion: 'system' } });
    expect(document.documentElement.dataset.motion).toBeUndefined();
  });
});
