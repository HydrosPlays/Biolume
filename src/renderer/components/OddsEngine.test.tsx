import { act, renderHook, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { oddsEngine } from '@renderer/lib/oddsData';
import { initStore } from '@renderer/store';
import { installMockBiolume, makeHunt, makeSession, renderWithProviders } from '@renderer/test';
import OddsEngine from './OddsEngine';
import {
  ODDS_WRITE_DELAY_MS,
  resetStandaloneSelection,
  useOddsSelection,
} from './odds/useOddsSelection';

afterEach(() => {
  resetStandaloneSelection();
  vi.useRealTimers();
});

describe('OddsEngine view', () => {
  it('works as a standalone calculator without an active hunt', async () => {
    const { user, mock } = await renderWithProviders(<OddsEngine />);

    expect(screen.getByText(/standalone calculator/i)).not.toBeNull();
    const hero = screen.getByRole('region', { name: 'Shiny odds' });
    expect(within(hero).getByText('4,096')).not.toBeNull();
    expect(within(hero).getByText('Full odds')).not.toBeNull();

    await user.click(screen.getByRole('switch', { name: /shiny charm/i }));
    expect(within(hero).getByText('1,365.7')).not.toBeNull();
    expect(within(hero).getByText(/×3 better than full odds/)).not.toBeNull();
    // Base roll + charm rolls in the breakdown.
    expect(within(hero).getByText('+2 rolls')).not.toBeNull();
    expect(mock.api.hunts.update).not.toHaveBeenCalled();
  });

  it('is bound to the active hunt and saves changes to it', async () => {
    const hunt = makeHunt({
      odds: oddsEngine.defaultSelection('sv', 'mass-outbreak'),
      count: 700,
      priorCount: 300,
    });
    const { user, mock } = await renderWithProviders(<OddsEngine />, {
      biolume: {
        hunts: [hunt],
        activeHuntId: hunt.id,
        sessions: [
          makeSession({
            huntId: hunt.id,
            startedAt: '2026-10-13T10:00:00.000Z',
            endedAt: '2026-10-13T11:00:00.000Z',
            encounters: 400,
          }),
        ],
      },
    });

    expect(screen.getByText(new RegExp(`Bound to ${hunt.name}`))).not.toBeNull();
    // The chart describes the hunt's position, the milestones use its pace.
    expect(screen.getByText(/is at 1,000 encounters/)).not.toBeNull();
    expect(screen.getByText(/400 encounters per hour \(1 session of this hunt\)/)).not.toBeNull();

    await user.click(screen.getByRole('switch', { name: /shiny charm/i }));
    expect(mock.api.hunts.update).toHaveBeenCalledTimes(1);
    expect(mock.api.hunts.update).toHaveBeenCalledWith(hunt.id, {
      odds: { ...oddsEngine.normalizeSelection(hunt.odds), shinyCharm: true },
    });
    // The main process is the source of truth: its event carries the new selection back.
    expect(mock.getState().hunts[0]?.odds.shinyCharm).toBe(true);
    expect(screen.getByRole('switch', { name: /shiny charm/i }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('renders the method inputs from its definition, with a chain shortcut', async () => {
    const dexnav = makeHunt({ odds: oddsEngine.defaultSelection('oras', 'dexnav'), count: 42 });
    const { user, mock } = await renderWithProviders(<OddsEngine />, {
      biolume: { hunts: [dexnav], activeHuntId: dexnav.id },
    });
    expect(screen.getByRole('spinbutton', { name: 'Search Level' })).not.toBeNull();
    expect(screen.getByRole('spinbutton', { name: 'Chain length' })).not.toBeNull();
    expect(screen.getByRole('slider', { name: 'Chain length slider' })).not.toBeNull();
    expect(screen.getByRole('radiogroup', { name: 'Curve model' })).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Use current count (42)' }));
    expect(mock.api.hunts.update).toHaveBeenCalledWith(
      dexnav.id,
      expect.objectContaining({
        odds: expect.objectContaining({ inputs: { searchLevel: 0, chain: 42 } }),
      }),
    );
  });

  it('disables the Shiny Charm with the reason when the game has none', async () => {
    const rse = makeHunt({ odds: oddsEngine.defaultSelection('rse') });
    await renderWithProviders(<OddsEngine />, { biolume: { hunts: [rse], activeHuntId: rse.id } });
    const charm = screen.getByRole<HTMLButtonElement>('switch', { name: /shiny charm/i });
    expect(charm.disabled).toBe(true);
    const description = (charm.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(description).toMatch(/has no Shiny Charm/);
  });
});

describe('useOddsSelection', () => {
  it('debounces rapid edits into one write and flushes on demand', async () => {
    const hunt = makeHunt({ odds: oddsEngine.defaultSelection('oras', 'dexnav') });
    const mock = installMockBiolume({ hunts: [hunt], activeHuntId: hunt.id });
    await initStore();
    vi.useFakeTimers();

    const { result } = renderHook(() => useOddsSelection());
    const withChain = (chain: number) =>
      oddsEngine.updateSelection(result.current.selection, { inputs: { chain } });

    act(() => result.current.change(withChain(1), { debounce: true }));
    act(() => result.current.change(withChain(2), { debounce: true }));
    act(() => result.current.change(withChain(3), { debounce: true }));
    // The draft follows every edit at once; nothing has been written yet.
    expect(result.current.selection.inputs.chain).toBe(3);
    expect(mock.api.hunts.update).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ODDS_WRITE_DELAY_MS);
    });
    expect(mock.api.hunts.update).toHaveBeenCalledTimes(1);
    expect(mock.api.hunts.update).toHaveBeenLastCalledWith(hunt.id, { odds: withChain(3) });

    act(() => result.current.change(withChain(9), { debounce: true }));
    act(() => result.current.flush());
    expect(mock.api.hunts.update).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(result.current.selection.inputs.chain).toBe(9);
    expect(mock.getState().hunts[0]?.odds.inputs.chain).toBe(9);
  });

  it('adopts a selection changed elsewhere and writes a pending edit when the view closes', async () => {
    const hunt = makeHunt({ odds: oddsEngine.defaultSelection('sv') });
    const mock = installMockBiolume({ hunts: [hunt], activeHuntId: hunt.id });
    await initStore();

    const { result, unmount } = renderHook(() => useOddsSelection());
    const outside = oddsEngine.defaultSelection('swsh', 'masuda-method');
    await act(async () => {
      await mock.api.hunts.update(hunt.id, { odds: outside });
    });
    expect(result.current.selection).toEqual(outside);

    mock.api.hunts.update.mockClear();
    const edited = oddsEngine.updateSelection(outside, { shinyCharm: true });
    act(() => result.current.change(edited, { debounce: true }));
    expect(mock.api.hunts.update).not.toHaveBeenCalled();
    unmount();
    expect(mock.api.hunts.update).toHaveBeenCalledWith(hunt.id, { odds: edited });
  });
});
