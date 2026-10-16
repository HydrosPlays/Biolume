import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useUiStore } from '@renderer/store';
import { makeHunt, renderWithProviders } from '@renderer/test';
import Counter from '../Counter';
import PhaseDialog from '../PhaseDialog';

const countButton = (): HTMLElement => screen.getByRole('button', { name: /edit the count/i });

describe('Counter (Hunt view)', () => {
  it('counts one step per click and shows what the main process sends back', async () => {
    const hunt = makeHunt({ count: 41, priorCount: 100 });
    const { user, mock } = await renderWithProviders(<Counter />, {
      biolume: { hunts: [hunt], activeHuntId: hunt.id },
    });

    expect(countButton().textContent).toBe('41');

    await user.click(screen.getByRole('button', { name: 'Count encounter' }));

    expect(mock.api.hunts.adjustCount).toHaveBeenCalledWith(hunt.id, 1, 'ui');
    await waitFor(() => expect(countButton().textContent).toBe('42'));
    // Total = prior phases + this phase, in the hero line and the stats strip.
    expect(screen.getAllByText('142').length).toBeGreaterThan(0);
  });

  it('follows changes that come from elsewhere, and sets the count exactly from the numeral', async () => {
    const hunt = makeHunt({ count: 10, step: 5 });
    const { user, mock } = await renderWithProviders(<Counter />, {
      biolume: { hunts: [hunt], activeHuntId: hunt.id },
    });

    // A global hotkey / the overlay: the main process changes the count without this view asking.
    await act(async () => {
      await mock.api.hunts.adjustCount(hunt.id, 5, 'hotkey-global');
    });
    expect(countButton().textContent).toBe('15');

    await user.click(countButton());
    const editor = screen.getByRole('textbox', { name: 'Encounters in this phase' });
    await user.clear(editor);
    await user.type(editor, '1,250{Enter}');

    expect(mock.api.hunts.setCount).toHaveBeenCalledWith(hunt.id, 1250, 'ui');
    await waitFor(() => expect(countButton().textContent).toBe('1,250'));
  });

  it('offers to start a hunt when there is none', async () => {
    const { user, mock } = await renderWithProviders(<Counter />);

    await user.click(screen.getByRole('button', { name: 'Start your first hunt' }));
    const dialog = await screen.findByRole('dialog', { name: 'New hunt' });
    expect(dialog).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Start hunt' }));
    await waitFor(() => expect(mock.api.hunts.create).toHaveBeenCalledTimes(1));
    expect(mock.api.hunts.create.mock.calls[0]?.[0]).toMatchObject({
      name: 'New hunt',
      target: null,
      odds: { gameId: 'sv', methodId: 'full-odds' },
    });
    // The new hunt becomes the active one and the counter appears.
    await waitFor(() => expect(countButton().textContent).toBe('0'));
  });
});

describe('PhaseDialog', () => {
  it('logs the species picked from the search and resets the counter by default', async () => {
    const hunt = makeHunt({ count: 120 });
    const { user, mock } = await renderWithProviders(<PhaseDialog />, {
      biolume: { hunts: [hunt], activeHuntId: hunt.id },
    });
    act(() => useUiStore.getState().openPhaseDialog({ huntId: hunt.id }));

    const field = await screen.findByRole('combobox');
    await user.type(field, 'zigzagoon');
    await user.keyboard('{Enter}'); // picks the highlighted result
    await user.keyboard('{Enter}'); // saves

    await waitFor(() => expect(mock.api.hunts.logPhase).toHaveBeenCalledTimes(1));
    expect(mock.api.hunts.logPhase.mock.calls[0]?.[1]).toMatchObject({
      speciesId: 263,
      speciesName: 'Zigzagoon',
      resetCount: true,
    });
    await waitFor(() => expect(useUiStore.getState().phaseDialog.open).toBe(false));
    expect(mock.getState().hunts[0]).toMatchObject({ count: 0, priorCount: 120 });
  });
});
