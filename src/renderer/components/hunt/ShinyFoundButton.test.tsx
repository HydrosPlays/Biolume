import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SHINY_CONFIRM_WINDOW_MS } from '@shared/streamDeck';
import { useGlobalHotkeyEvents } from '@renderer/hooks/useGlobalHotkeyEvents';
import { makeHunt, renderWithProviders } from '@renderer/test';
import Counter from '../Counter';

/** The Hunt view with the shell services that raise its toasts, as the AppShell mounts them. */
function HuntWithShell() {
  useGlobalHotkeyEvents();
  return <Counter />;
}

const shinyButton = (): HTMLElement => screen.getByRole('button', { name: /shiny found!/i });
const armedWrapper = (): Element | null => shinyButton().closest('[data-armed]');

describe('Hunt view — Shiny Found confirmation', () => {
  it('pulses with a countdown while a Stream Deck press has armed it, then clears', async () => {
    const hunt = makeHunt({ name: 'Shiny Ralts' });
    const { mock } = await renderWithProviders(<HuntWithShell />, {
      biolume: { hunts: [hunt], activeHuntId: hunt.id },
    });

    expect(armedWrapper()).toBeNull();
    expect(screen.queryByText('Press again to confirm')).toBeNull();

    mock.fireShinyArmed({
      huntId: hunt.id,
      armedUntil: Date.now() + SHINY_CONFIRM_WINDOW_MS,
      source: 'streamdeck',
    });

    expect(armedWrapper()).not.toBeNull();
    expect(screen.getByText('Press again to confirm')).toBeTruthy();
    expect(screen.getByTestId('shiny-countdown').textContent).toBe('3');
    // The prompt describes the button for assistive tech.
    const hintId = shinyButton().getAttribute('aria-describedby') ?? '';
    expect(
      hintId
        .split(' ')
        .some((id) => document.getElementById(id)?.textContent?.includes('Press again')),
    ).toBe(true);
    // …and the toast tells the same while the window is visible.
    expect(screen.getByText('Press again to confirm Shiny Found')).toBeTruthy();

    // Expired (main announces it with armedUntil null).
    mock.fireShinyArmed({ huntId: hunt.id, armedUntil: null, source: 'streamdeck' });
    expect(armedWrapper()).toBeNull();
    expect(screen.queryByText('Press again to confirm')).toBeNull();
    expect(screen.queryByTestId('shiny-countdown')).toBeNull();
  });

  it('expires by itself when no event arrives', async () => {
    const hunt = makeHunt();
    const { mock } = await renderWithProviders(<Counter />, {
      biolume: { hunts: [hunt], activeHuntId: hunt.id },
    });

    mock.fireShinyArmed({ huntId: hunt.id, armedUntil: Date.now() + 150, source: 'hotkey-global' });
    expect(armedWrapper()).not.toBeNull();
    await waitFor(() => expect(armedWrapper()).toBeNull());
  });

  it('ignores a confirmation armed for another hunt', async () => {
    const hunt = makeHunt();
    const { mock } = await renderWithProviders(<Counter />, {
      biolume: { hunts: [hunt, makeHunt({ id: 'other' })], activeHuntId: hunt.id },
    });

    mock.fireShinyArmed({ huntId: 'other', armedUntil: Date.now() + 3_000, source: 'streamdeck' });
    expect(armedWrapper()).toBeNull();
  });

  it('plays the completion when the second press confirms', async () => {
    const hunt = makeHunt({ name: 'Shiny Ralts' });
    const { mock } = await renderWithProviders(<Counter />, {
      biolume: { hunts: [hunt], activeHuntId: hunt.id },
    });

    await act(async () => {
      await mock.api.hunts.requestShinyFound(hunt.id, 'streamdeck');
    });
    expect(armedWrapper()).not.toBeNull();

    await act(async () => {
      await mock.api.hunts.requestShinyFound(hunt.id, 'streamdeck');
    });
    // The hero gives way to the completed summary; nothing is armed any more.
    await waitFor(() => expect(screen.queryByRole('button', { name: /shiny found!/i })).toBeNull());
    expect(screen.getAllByText(/shiny found/i).length).toBeGreaterThan(0);
    expect(screen.queryByText('Press again to confirm')).toBeNull();
  });

  it('still completes at once from its own button, armed or not', async () => {
    const hunt = makeHunt();
    const { mock, user } = await renderWithProviders(<Counter />, {
      biolume: { hunts: [hunt], activeHuntId: hunt.id },
    });

    mock.fireShinyArmed({ huntId: hunt.id, armedUntil: Date.now() + 3_000, source: 'streamdeck' });
    await user.click(shinyButton());
    expect(mock.api.hunts.complete).toHaveBeenCalledWith(hunt.id, undefined);
    expect(mock.api.hunts.requestShinyFound).not.toHaveBeenCalled();
    await waitFor(() => expect(mock.getState().hunts[0]?.status).toBe('completed'));
  });
});

describe('Hunt view — Stream Deck', () => {
  it('shows a "Stream Deck" chip while the plugin is connected', async () => {
    const hunt = makeHunt();
    const { mock } = await renderWithProviders(<Counter />, {
      biolume: { hunts: [hunt], activeHuntId: hunt.id },
    });
    expect(screen.queryByTestId('stream-deck-chip')).toBeNull();

    mock.setStreamDeckStatus({ clients: 1 });
    expect(screen.getByTestId('stream-deck-chip').textContent).toContain('Stream Deck');

    mock.setStreamDeckStatus({ clients: 0 });
    expect(screen.queryByTestId('stream-deck-chip')).toBeNull();
  });

  it('animates counts from the Stream Deck like any other source', async () => {
    const hunt = makeHunt({ count: 9 });
    const { mock } = await renderWithProviders(<Counter />, {
      biolume: { hunts: [hunt], activeHuntId: hunt.id },
    });
    expect(document.querySelector('.bl-ripple')).toBeNull();

    await act(async () => {
      await mock.api.hunts.adjustCount(hunt.id, 1, 'streamdeck');
    });
    expect(screen.getByRole('button', { name: /edit the count/i }).textContent).toBe('10');
    expect(document.querySelector('.bl-ripple[data-direction="up"]')).not.toBeNull();
  });
});
