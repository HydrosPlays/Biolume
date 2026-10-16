import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PokeApiModule from '@renderer/api/pokeapi';
import { fetchPokemon, fetchSpecies, PokeApiError } from '@renderer/api/pokeapi';
import { makeHunt, makeTarget, renderWithProviders } from '@renderer/test';
import TargetSearch from '../TargetSearch';
import { GEODUDE, GEODUDE_SPECIES } from './fixtures';
import { RECENTS_KEY } from './helpers';

// No network in tests: the query hooks stay real, the fetchers underneath are replaced.
vi.mock('@renderer/api/pokeapi', async (importOriginal) => ({
  ...(await importOriginal<typeof PokeApiModule>()),
  fetchPokemon: vi.fn(),
  fetchSpecies: vi.fn(),
}));

const offline = () => new PokeApiError('offline', 'offline', { url: 'https://pokeapi.co/test' });

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(fetchPokemon).mockImplementation(async (id) => {
    if (id === GEODUDE.id) return GEODUDE;
    throw offline();
  });
  vi.mocked(fetchSpecies).mockImplementation(async (id) => {
    if (id === GEODUDE_SPECIES.id) return GEODUDE_SPECIES;
    throw offline();
  });
});

const geodudeTarget = () =>
  makeTarget({
    speciesId: 74,
    pokemonId: 74,
    slug: 'geodude',
    name: 'Geodude',
    types: ['rock', 'ground'],
  });

describe('TargetSearch', () => {
  it('previews a searched species, flags its risk moves and offers to create a hunt', async () => {
    const { user, mock } = await renderWithProviders(<TargetSearch />);
    expect(screen.getByText('Pick a species to analyse')).toBeTruthy();

    // Keyboard only: type, the first result is highlighted, Enter previews it.
    await user.type(screen.getByRole('combobox', { name: 'Search species' }), 'geodude');
    expect(
      screen.getAllByRole('option').map((option) => option.getAttribute('aria-label')),
    ).toEqual([
      'Geodude, #0074, Rock and Ground, generation 1',
      'Alolan Geodude, #0074, Rock and Electric, generation 1',
    ]);
    await user.keyboard('{Enter}');

    expect(await screen.findByRole('heading', { level: 2, name: 'Geodude' })).toBeTruthy();
    expect(window.localStorage.getItem(RECENTS_KEY)).toBe('[74]');

    // Lv. 25 (no hunt): Bulldoze, Rock Throw, Smack Down and — flagged — Self-Destruct.
    const card = await screen.findByRole('article', { name: 'Self-Destruct' });
    expect(within(card).getByText('Critical risk')).toBeTruthy();
    expect(within(card).getByText(/Lead with a Damp Pokémon/)).toBeTruthy();
    expect(screen.getByRole('article', { name: 'Rock Throw' }).dataset.risk).toBeUndefined();
    expect(screen.getByText('Critical risk · Lv. 25')).toBeTruthy();
    expect(screen.getByText(/^Learns Explosion at Lv\. 36 — hunt below that/)).toBeTruthy();
    expect(screen.getByText('Sand Veil')).toBeTruthy();
    expect(screen.getByText('Very easy')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Create hunt for Geodude' }));
    await waitFor(() =>
      expect(mock.api.hunts.create).toHaveBeenCalledWith(
        expect.objectContaining({
          target: expect.objectContaining({ pokemonId: 74, slug: 'geodude' }),
          targetLevel: 25,
        }),
      ),
    );
    expect(await screen.findByText('Current hunt target')).toBeTruthy();
  });

  it('opens on the hunt target and saves the wild level to the hunt', async () => {
    const hunt = makeHunt({ target: geodudeTarget(), targetLevel: 20 });
    const { user, mock } = await renderWithProviders(<TargetSearch />, {
      biolume: { hunts: [hunt], activeHuntId: hunt.id },
    });

    expect(await screen.findByRole('heading', { level: 2, name: 'Geodude' })).toBeTruthy();
    expect(await screen.findByText('Clear · Lv. 20')).toBeTruthy();

    const level = screen.getByRole('spinbutton', { name: 'Wild level' });
    await user.clear(level);
    await user.type(level, '38{Enter}');

    // Above Lv. 36 Self-Destruct has been pushed out and Explosion has arrived.
    expect(await screen.findByRole('article', { name: 'Explosion' })).toBeTruthy();
    expect(screen.queryByRole('article', { name: 'Self-Destruct' })).toBeNull();
    await waitFor(() =>
      expect(mock.api.hunts.update).toHaveBeenCalledWith(hunt.id, { targetLevel: 38 }),
    );
  });

  it('keeps working from the bundled index when PokeAPI is unreachable', async () => {
    const hunt = makeHunt({ target: geodudeTarget() });
    const { user, mock } = await renderWithProviders(<TargetSearch />, {
      biolume: { hunts: [hunt], activeHuntId: hunt.id },
    });
    await screen.findByRole('heading', { level: 2, name: 'Geodude' });

    await user.type(screen.getByRole('combobox', { name: 'Search species' }), 'abra');
    await user.click(screen.getByRole('option', { name: /^Abra,/ }));

    expect(await screen.findByRole('heading', { level: 2, name: 'Abra' })).toBeTruthy();
    expect(await screen.findByText('Showing bundled data only')).toBeTruthy();
    expect(screen.getByText('Learnset unavailable')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Set as hunt target' }));
    await waitFor(() =>
      expect(mock.api.hunts.update).toHaveBeenCalledWith(
        hunt.id,
        expect.objectContaining({
          target: expect.objectContaining({ pokemonId: 63, slug: 'abra', name: 'Abra' }),
          targetLevel: hunt.targetLevel,
        }),
      ),
    );
  });
});
