import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeHunt, makePhase, makeSettings, renderWithProviders } from '@renderer/test';
import OverlayView from '../OverlayView';
import { overlayOddsLine, unscaledSize } from './overlayModel';

describe('overlay model', () => {
  it('reports the unscaled content size without float noise', () => {
    // 284 px of content at scale 1.25 measures 355 px; 355 / 1.25 is not exactly 284 in binary.
    expect(unscaledSize({ width: 355, height: 127.5 }, 1.25)).toEqual({ width: 284, height: 102 });
    expect(unscaledSize({ width: 300, height: 90 }, 1)).toEqual({ width: 300, height: 90 });
    // A scale outside the limits is clamped the way the main process clamps it.
    expect(unscaledSize({ width: 300, height: 90 }, 9)).toEqual({ width: 200, height: 60 });
  });

  it('computes the odds line over every encounter of the hunt', () => {
    // SV full odds: 1 in 4,096; 2,839 encounters are the 50 % mark.
    const hunt = makeHunt({ count: 839, priorCount: 2_000 });
    expect(overlayOddsLine(hunt)).toBe('1 in 4,096 · 50 % so far');
  });
});

describe('OverlayView', () => {
  it('shows the active hunt and counts by its step from the overlay', async () => {
    const hunt = makeHunt({
      name: 'Gastly in the tower',
      count: 40,
      priorCount: 300,
      step: 5,
      phases: [makePhase(), makePhase()],
    });
    const { user, mock } = await renderWithProviders(<OverlayView />, {
      biolume: {
        windowKind: 'overlay',
        hunts: [hunt],
        activeHuntId: hunt.id,
        settings: makeSettings({ overlay: { scale: 1.25, opacity: 0.6 } }),
      },
    });

    expect(screen.getByText('Gastly in the tower')).not.toBeNull();
    expect(screen.getByLabelText('40 encounters').textContent).toBe('40');
    expect(screen.getByText('Phase 3 · 340 total')).not.toBeNull();
    expect(screen.getByText(/^1 in 4,096 · .+ so far$/)).not.toBeNull();

    // The scale is CSS zoom on the overlay's own element; the opacity only reaches the background.
    const scaler = document.querySelector<HTMLElement>('[data-overlay-scale]');
    expect(scaler?.style.zoom).toBe('1.25');
    expect(scaler?.closest('[data-overlay-root]')).not.toBeNull();
    expect(
      screen
        .getByRole('region', { name: /mini-overlay/i })
        .style.getPropertyValue('--overlay-alpha'),
    ).toBe('60%');

    await user.click(screen.getByRole('button', { name: 'Add 5' }));
    expect(mock.api.hunts.adjustCount).toHaveBeenLastCalledWith(hunt.id, 5, 'overlay');
    expect(screen.getByLabelText('45 encounters')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Subtract 5' }));
    expect(mock.api.hunts.adjustCount).toHaveBeenLastCalledWith(hunt.id, -5, 'overlay');

    await user.click(screen.getByRole('button', { name: 'Back to Biolume' }));
    expect(mock.api.window.setOverlayOpen).toHaveBeenCalledWith(false);
  });

  it('hides the optional lines and locks counting on a completed hunt', async () => {
    const hunt = makeHunt({ status: 'completed', count: 12 });
    await renderWithProviders(<OverlayView />, {
      biolume: {
        windowKind: 'overlay',
        hunts: [hunt],
        activeHuntId: hunt.id,
        settings: makeSettings({
          overlay: { showOdds: false, showPhase: false, showSprite: false, clickThrough: true },
        }),
      },
    });

    expect(screen.getByRole('region', { name: /mini-overlay/i }).getAttribute('data-state')).toBe(
      'completed',
    );
    expect(screen.getByText('Shiny found')).not.toBeNull();
    expect(screen.queryByText(/so far/)).toBeNull();
    expect(screen.queryByText(/^Phase/)).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add 1' }).disabled).toBe(true);
    // Click-through: a hint that names the way out.
    expect(screen.getByText('Click-through · Ctrl + Shift + B closes')).not.toBeNull();
  });

  it('says so when there is no active hunt', async () => {
    const { user, mock } = await renderWithProviders(<OverlayView />, {
      biolume: { windowKind: 'overlay' },
    });
    expect(screen.getByText('No active hunt')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /^Add/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Back to Biolume' }));
    expect(mock.api.window.setOverlayOpen).toHaveBeenCalledWith(false);
  });
});
