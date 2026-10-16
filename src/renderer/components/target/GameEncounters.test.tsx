import type { UseQueryResult } from '@tanstack/react-query';
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePokeApiEncounterSlice } from '@renderer/api/encounters';
import { PokeApiError } from '@renderer/api/pokeapi';
import type { GameEncounterSlice } from '@renderer/data/encounterSchema';
import { renderWithProviders } from '@renderer/test';
import { GameEncounters, type GameEncountersProps } from './GameEncounters';

vi.mock('@renderer/api/encounters', () => ({
  POKEAPI_ENCOUNTER_GAMES: new Set(['hgss']),
  usePokeApiEncounterSlice: vi.fn(),
}));

function queryResult(
  state: Partial<UseQueryResult<GameEncounterSlice>>,
): UseQueryResult<GameEncounterSlice> {
  return {
    data: undefined,
    error: null,
    isError: false,
    isPending: true,
    refetch: vi.fn(),
    ...state,
  } as unknown as UseQueryResult<GameEncounterSlice>;
}

const HGSS = 'HeartGold / SoulSilver';

function pokeApiSlice(
  rows: NonNullable<GameEncounterSlice['pokemon']>['rows'],
): GameEncounterSlice {
  return {
    gameId: 'hgss',
    source: 'PokeAPI (pokeapi.co)',
    versions: ['HeartGold', 'SoulSilver'],
    locations: { '1': 'Route 29', '2': 'Route 30', '3': 'Goldenrod City', '4': 'Ilex Forest' },
    pokemon: { rows },
    availabilityKnown: false,
  };
}

async function renderPanel(props: Partial<GameEncountersProps> = {}) {
  const onLevelChange = vi.fn();
  const view = await renderWithProviders(
    <GameEncounters
      gameId="za"
      gameName="Legends: Z-A"
      pokemonId={92}
      name="Gastly"
      level={16}
      onLevelChange={onLevelChange}
      {...props}
    />,
  );
  return { ...view, onLevelChange };
}

beforeEach(() => {
  vi.mocked(usePokeApiEncounterSlice).mockReset();
  vi.mocked(usePokeApiEncounterSlice).mockReturnValue(queryResult({}));
});

describe('GameEncounters — bundled data', () => {
  it('lists locations with clickable level ranges, filters and a collapsed list', async () => {
    const { user, onLevelChange } = await renderPanel();

    // The bundled file is its own chunk: a skeleton first, then the data.
    expect(
      screen.getByRole('region', { name: 'Gastly in Legends: Z-A' }).getAttribute('aria-busy'),
    ).toBe('true');
    expect(await screen.findByText('Lumiose Dex #065')).toBeTruthy();
    const panel = screen.getByRole('region', { name: 'Gastly in Legends: Z-A' });
    expect(panel.getAttribute('aria-busy')).toBeNull();
    expect(
      within(panel).getByText(/Main Missions \/ Side Missions\) is shiny-locked/),
    ).toBeTruthy();
    expect(within(panel).getByText(/^Location data: PKHeX/)).toBeTruthy();

    // Clicking a range analyses the top of it.
    const sector = within(panel).getByText('Vert Sector 1').closest('li');
    expect(sector).not.toBeNull();
    await user.click(within(sector as HTMLElement).getByRole('button', { name: 'Lv. 14–17' }));
    expect(onLevelChange).toHaveBeenCalledWith(17);

    // Six locations until expanded; Hyperspace (Mega Dimension) comes last.
    const list = within(panel).getByRole('list', { name: 'Locations' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(6);
    await user.click(within(panel).getByRole('button', { name: /^Show all \d+ locations$/ }));
    const cards = within(list).getAllByRole('listitem');
    expect(cards.length).toBeGreaterThan(6);
    expect(within(cards.at(-1) as HTMLElement).getByText('Hyperspace Lumiose')).toBeTruthy();
    expect(within(cards.at(-1) as HTMLElement).getByText('Mega Dimension')).toBeTruthy();

    // Filter to alphas only.
    const filters = within(panel).getByRole('group', { name: 'Show encounters by kind' });
    await user.click(within(filters).getByRole('button', { name: /^Alphas/ }));
    expect(within(panel).queryByText('Vert Sector 1')).toBeNull();
    expect(within(panel).getByText('Wild Zone 4')).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Alpha Lv. 21–22' })).toBeTruthy();
    expect(within(panel).queryByRole('list', { name: /Gifts/ })).toBeNull();
  });

  it('shows shiny locks of fixed-only Pokémon', async () => {
    await renderPanel({ pokemonId: 716, name: 'Xerneas' });

    expect(await screen.findByText('Shiny-locked in Legends: Z-A.')).toBeTruthy();
    const fixed = screen.getByRole('list', { name: 'Gifts, static encounters and trades' });
    expect(within(fixed).getByText('Legendary Pokémon')).toBeTruthy();
    expect(within(fixed).getByText('Shiny-locked')).toBeTruthy();
  });

  it('says so when the Pokémon is not in the game', async () => {
    await renderPanel({ pokemonId: 906, name: 'Sprigatito' });

    expect(await screen.findByText('Not in Legends: Z-A.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Sprigatito in Legends: Z-A' })).toBeNull();
  });

  it('explains games without any location data', async () => {
    await renderPanel({ gameId: 'nope', gameName: 'Pokémon Nope' });

    expect(screen.getByText('Location data isn’t available for Pokémon Nope.')).toBeTruthy();
    expect(vi.mocked(usePokeApiEncounterSlice)).toHaveBeenCalledWith('nope', null);
  });
});

describe('GameEncounters — PokeAPI games', () => {
  const props = { gameId: 'hgss', gameName: HGSS, pokemonId: 25, name: 'Pikachu' };

  it('shows a skeleton while loading', async () => {
    await renderPanel(props);

    const panel = screen.getByRole('region', { name: `Pikachu in ${HGSS}` });
    expect(panel.getAttribute('aria-busy')).toBe('true');
    expect(within(panel).getByLabelText('Loading locations')).toBeTruthy();
    expect(vi.mocked(usePokeApiEncounterSlice)).toHaveBeenCalledWith('hgss', 25);
  });

  it('offers a retry when PokeAPI is unreachable', async () => {
    const refetch = vi.fn();
    vi.mocked(usePokeApiEncounterSlice).mockReturnValue(
      queryResult({
        isError: true,
        isPending: false,
        error: new PokeApiError('offline', 'offline', { url: 'https://pokeapi.co/test' }),
        refetch,
      }),
    );
    const { user } = await renderPanel(props);

    expect(screen.getByText('Locations unavailable')).toBeTruthy();
    expect(screen.getByText(/PokeAPI is unreachable/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('does not claim a Pokémon is missing when PokeAPI lists no location', async () => {
    vi.mocked(usePokeApiEncounterSlice).mockReturnValue(
      queryResult({ data: pokeApiSlice([]), isPending: false }),
    );
    await renderPanel(props);

    expect(
      screen.getByText(
        `No wild locations listed — Pikachu may only be obtainable by evolving, breeding or trading in ${HGSS}.`,
      ),
    ).toBeTruthy();
    expect(screen.getByText('Location data: PokeAPI (pokeapi.co).')).toBeTruthy();
  });

  it('renders methods, conditions, rates and version exclusives', async () => {
    vi.mocked(usePokeApiEncounterSlice).mockReturnValue(
      queryResult({
        isPending: false,
        data: pokeApiSlice([
          { k: 'wild', l: 1, n: 3, x: 5, m: 'Walking', c: ['Morning'], r: 30 },
          { k: 'wild', l: 1, n: 3, x: 5, m: 'Walking', c: ['Night'], r: 10, v: 2 },
          { k: 'fishing', l: 2, n: 10, x: 10, m: 'Old Rod', r: 5 },
          { k: 'surf', l: 2, n: 20, x: 25, m: 'Surfing', r: 4.5 },
          { k: 'gift', l: 3, n: 5, x: 5 },
        ]),
      }),
    );
    const { user } = await renderPanel({ ...props, level: 40 });

    const route29 = screen.getByText('Route 29').closest('li') as HTMLElement;
    expect(within(route29).getAllByText('Walking')).toHaveLength(2);
    expect(within(route29).getByText('Morning')).toBeTruthy();
    expect(within(route29).getByText('30%')).toBeTruthy();
    const silver = within(route29).getByText('SoulSilver');
    expect(silver.dataset.version).toBe('soulsilver');

    const route30 = screen.getByText('Route 30').closest('li') as HTMLElement;
    expect(within(route30).getByText('Fishing')).toBeTruthy();
    expect(within(route30).getByText('Old Rod')).toBeTruthy();
    expect(within(route30).getByText('4.5%')).toBeTruthy();

    // PokeAPI knows no shiny locks: the gift is listed without a verdict.
    const fixed = screen.getByRole('list', { name: 'Gifts, static encounters and trades' });
    expect(within(fixed).getByText('Goldenrod City')).toBeTruthy();
    expect(within(fixed).queryByText('Can be shiny')).toBeNull();

    // Lv. 40 is out of range; the hint jumps to the top of the wild span.
    expect(screen.getByText(/Lv\. 40 is outside the levels Pikachu appears at here/)).toBeTruthy();

    const filters = screen.getByRole('group', { name: 'Show encounters by kind' });
    expect(
      within(filters)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['All', 'Wild 1', 'Water 1', 'Fishing 1', 'Static & gifts 1']);
    await user.click(within(filters).getByRole('button', { name: 'Static & gifts 1' }));
    expect(screen.queryByText('Route 29')).toBeNull();
    expect(screen.getByText('Goldenrod City')).toBeTruthy();
  });
});
