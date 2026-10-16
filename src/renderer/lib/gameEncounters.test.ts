import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, type UseQueryResult } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePokeApiEncounterSlice } from '@renderer/api/encounters';
import type {
  BundledEncounterFile,
  EncounterRow,
  GameEncounterSlice,
} from '@renderer/data/encounterSchema';
import {
  buildLines,
  bundledEncounterGames,
  encounterOrigin,
  filterLines,
  formatRate,
  groupByLocation,
  KIND_ORDER,
  loadBundledEncounters,
  rowLevels,
  shinySourceOf,
  sliceFromBundled,
  summarizeEncounters,
  useGameEncounters,
  versionLabels,
  versionSlug,
} from './gameEncounters';

vi.mock('@renderer/api/encounters', () => ({
  POKEAPI_ENCOUNTER_GAMES: new Set(['gsc', 'hgss', 'swsh']),
  usePokeApiEncounterSlice: vi.fn(),
}));

/** What TanStack Query returns for a disabled / pending / failed / settled query, as far as the hook reads it. */
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

function slice(rows: EncounterRow[] | null, overrides: Partial<GameEncounterSlice> = {}) {
  return {
    gameId: 'hgss',
    source: 'Test data',
    versions: ['HeartGold', 'SoulSilver'],
    locations: {
      '1': 'Route 1',
      '2': 'Route 2',
      '3': 'Route 2',
      '4': 'Mt. Mortar',
      '9': 'Dragon’s Den',
    },
    pokemon: rows === null ? null : { rows },
    availabilityKnown: true,
    ...overrides,
  } satisfies GameEncounterSlice;
}

afterEach(() => {
  vi.mocked(usePokeApiEncounterSlice).mockReset();
});

// ───────────────────────────── Pure helpers ─────────────────────────────

describe('versionLabels', () => {
  const sv = ['Scarlet', 'Violet'];
  it('omits the label when a row is in every version (or the mask is absent)', () => {
    expect(versionLabels(undefined, sv)).toEqual([]);
    expect(versionLabels(0b11, sv)).toEqual([]);
    expect(versionLabels(0b111, ['Gold', 'Silver', 'Crystal'])).toEqual([]);
    expect(versionLabels(0b1, ['Legends: Z-A'])).toEqual([]);
  });

  it('names the versions a row is exclusive to', () => {
    expect(versionLabels(0b01, sv)).toEqual(['Scarlet']);
    expect(versionLabels(0b10, sv)).toEqual(['Violet']);
    expect(versionLabels(0b101, ['Gold', 'Silver', 'Crystal'])).toEqual(['Gold', 'Crystal']);
  });
});

describe('small formatters', () => {
  it('reads level ranges, treating 0 as unknown', () => {
    expect(rowLevels({ n: 4, x: 7 })).toEqual({ min: 4, max: 7 });
    expect(rowLevels({ n: 9, x: 5 })).toEqual({ min: 5, max: 9 });
    expect(rowLevels({ n: 0, x: 0 })).toBeNull();
  });

  it('formats rates and version slugs', () => {
    expect(formatRate(30)).toBe('30%');
    expect(formatRate(4.5)).toBe('4.5%');
    expect(formatRate(0.25)).toBe('0.25%');
    expect(versionSlug("Let's Go, Pikachu!")).toBe('lets-go-pikachu');
    expect(versionSlug('Black 2')).toBe('black-2');
    expect(versionSlug('Pokémon Scarlet')).toBe('scarlet');
  });
});

describe('groupByLocation', () => {
  it('merges same-named locations and lines that differ only in level', () => {
    const groups = groupByLocation(
      buildLines(
        slice([
          { k: 'wild', l: 2, n: 3, x: 5 },
          { k: 'wild', l: 3, n: 6, x: 8 },
          { k: 'surf', l: 2, n: 10, x: 20, r: 60 },
          { k: 'wild', l: 1, n: 2, x: 4 },
        ]),
      ),
    );

    expect(groups.map((group) => group.name)).toEqual(['Route 1', 'Route 2']);
    const route2 = groups[1];
    expect(route2?.lines.map((line) => [line.kind, line.levels])).toEqual([
      ['wild', { min: 3, max: 8 }],
      ['surf', { min: 10, max: 20 }],
    ]);
    expect(route2?.compact).toBe(false); // the surf line has a rate
    expect(groups[0]?.compact).toBe(true);
  });

  it('lifts shared conditions to the location and lists DLC and unknown locations last', () => {
    const groups = groupByLocation(
      buildLines(
        slice([
          { k: 'wild', l: 4, n: 2, x: 3, c: ['Mega Dimension'] },
          { k: 'alpha', l: 4, n: 9, x: 9, c: ['Mega Dimension'] },
          { k: 'raid', l: 0, n: 60, x: 60, m: 'Tera Raid ★6' },
          { k: 'fishing', l: 9, n: 40, x: 45, m: 'Super Rod', c: ['Night'], v: 0b10 },
          { k: 'gift', l: 1, n: 5, x: 5 },
        ]),
      ),
    );

    expect(groups.map((group) => group.name)).toEqual([
      'Dragon’s Den',
      'Various locations',
      'Mt. Mortar',
    ]);
    const mortar = groups[2];
    expect(mortar).toMatchObject({ shared: ['Mega Dimension'], late: true, compact: true });
    expect(mortar?.lines.every((line) => line.conditions.length === 0)).toBe(true);
    expect(groups[0]?.lines[0]).toMatchObject({
      method: 'Super Rod',
      conditions: ['Night'],
      versions: ['SoulSilver'],
    });
    expect(groups[1]).toMatchObject({ known: false });
  });

  it('orders floors and sectors numerically', () => {
    const groups = groupByLocation(
      buildLines(
        slice(
          [
            { k: 'wild', l: 3, n: 20, x: 22 },
            { k: 'wild', l: 1, n: 20, x: 22 },
            { k: 'wild', l: 2, n: 20, x: 22 },
          ],
          {
            locations: { '1': 'Bell Tower — 10F', '2': 'Bell Tower — 2F', '3': 'Bell Tower — 3F' },
          },
        ),
      ),
    );

    expect(groups.map((group) => group.name)).toEqual([
      'Bell Tower — 2F',
      'Bell Tower — 3F',
      'Bell Tower — 10F',
    ]);
  });
});

describe('shinySourceOf', () => {
  it('prefers wild over fixed, and calls an all-locked Pokémon locked', () => {
    expect(shinySourceOf([{ kind: 'raid', shinyLocked: false }])).toBe('wild');
    expect(
      shinySourceOf([
        { kind: 'wild', shinyLocked: true },
        { kind: 'gift', shinyLocked: false },
      ]),
    ).toBe('fixed');
    expect(shinySourceOf([{ kind: 'static', shinyLocked: true }])).toBe('locked');
    expect(shinySourceOf([])).toBe('none');
  });
});

describe('summarizeEncounters', () => {
  it('tells "not in the game" from "no encounter" and "unknown"', () => {
    expect(summarizeEncounters(slice(null)).presence).toBe('missing');
    expect(summarizeEncounters(slice([])).presence).toBe('empty');
    expect(summarizeEncounters(slice(null, { availabilityKnown: false })).presence).toBe('empty');
  });

  it('collects kinds, filters, level spans and locked fixed encounters', () => {
    const summary = summarizeEncounters(
      slice([
        { k: 'wild', l: 1, n: 2, x: 4 },
        { k: 'fishing', l: 2, n: 10, x: 15, m: 'Good Rod' },
        { k: 'fishing', l: 3, n: 20, x: 25, m: 'Super Rod' },
        { k: 'alpha', l: 1, n: 30, x: 32 },
        { k: 'static', l: 4, n: 40, x: 40, m: 'Legendary', s: 1 },
        { k: 'gift', l: 1, n: 5, x: 5 },
      ]),
    );

    expect(summary.kinds).toEqual(['wild', 'fishing', 'alpha', 'static', 'gift']);
    expect(summary.filters).toEqual([
      { id: 'wild', label: 'Wild', count: 1 },
      { id: 'fishing', label: 'Fishing', count: 1 },
      { id: 'alpha', label: 'Alphas', count: 1 },
      { id: 'fixed', label: 'Static & gifts', count: 2 },
    ]);
    expect(summary.wildLevels).toEqual({ min: 2, max: 25 });
    expect(summary.alphaLevels).toEqual({ min: 30, max: 32 });
    expect(summary.shinySource).toBe('wild');
    expect(summary.lockedFixed).toEqual(['Legendary']);
    expect(summary.huntableKinds).toEqual(['wild', 'fishing', 'alpha']);
    expect(summary.fixed.map((line) => line.kind)).toEqual(['static', 'gift']);
    expect(filterLines(summary.lines, 'fishing')).toHaveLength(2);
  });
});

// ───────────────────────────── Bundled data ─────────────────────────────

describe('bundled encounter files', () => {
  it.each(bundledEncounterGames())('%s.json loads and fits the schema', async (gameId) => {
    const file = await loadBundledEncounters(gameId);

    expect(file).toMatchObject({ version: 2, gameId });
    expect(file.versions.length).toBeGreaterThan(0);
    const every = 2 ** file.versions.length - 1;
    for (const entry of Object.values(file.pokemon)) {
      for (const row of entry.rows) {
        expect(KIND_ORDER).toContain(row.k);
        expect(row.l === 0 || String(row.l) in file.locations).toBe(true);
        if (row.v !== undefined) expect(row.v & every).toBeGreaterThan(0);
      }
    }
  });
});

describe('bundled Legends: Z-A data', () => {
  let za: BundledEncounterFile;
  const summary = (pokemonId: number) => summarizeEncounters(sliceFromBundled(za, pokemonId));

  beforeAll(async () => {
    za = await loadBundledEncounters('za');
  });

  it('is found by the glob and is version 2', () => {
    expect(bundledEncounterGames()).toContain('za');
    expect(za).toMatchObject({ version: 2, gameId: 'za', versions: ['Legends: Z-A'] });
  });

  it('lists wild areas with level ranges for a common wild Pokémon', () => {
    const gastly = summary(92);

    expect(gastly).toMatchObject({ presence: 'listed', dex: 65, dlc: false, shinySource: 'wild' });
    expect(gastly.groups.length).toBeGreaterThan(5);
    expect(gastly.groups.map((group) => group.name)).toContain('Vert Sector 1');
    expect(gastly.wildLevels?.min).toBeGreaterThanOrEqual(1);
    // Base-game areas are listed before Hyperspace (Mega Dimension) ones.
    const late = gastly.groups.map((group) => group.late);
    expect(late).toEqual([...late].sort((a, b) => Number(a) - Number(b)));
    expect(gastly.groups.at(-1)).toMatchObject({
      name: 'Hyperspace Lumiose',
      shared: ['Mega Dimension'],
      compact: true,
    });
    // The mission Gastly is shiny-locked, but that does not make the species locked.
    expect(gastly.lockedFixed).toEqual(['Main Missions / Side Missions']);
  });

  it('flags a Pokémon whose only encounter is shiny-locked', () => {
    const xerneas = summary(716);

    expect(xerneas.groups).toEqual([]);
    expect(xerneas.shinySource).toBe('locked');
    expect(xerneas.fixed[0]).toMatchObject({
      kind: 'static',
      levels: { min: 75, max: 75 },
      shinyLocked: true,
    });
  });

  it('knows a locked gift can still be hunted in the wild', () => {
    const chikorita = summary(152);

    expect(chikorita.lockedFixed).toContain('Z-A Starters');
    expect(chikorita.shinySource).toBe('wild');
    expect(chikorita.alphaLevels).not.toBeNull();
  });

  it('reports huntable fixed encounters such as revived fossils', () => {
    const aerodactyl = summary(142);
    const fossils = aerodactyl.fixed.filter((line) => !line.shinyLocked);

    expect(fossils.map((line) => line.levels?.min).sort()).toEqual([20, 35]);
    expect(fossils.every((line) => line.location === 'the Pokémon Research Lab')).toBe(true);
    expect(fossils.find((line) => line.levels?.min === 35)?.conditions).toEqual(['Alpha']);
  });

  it('includes in-game trades, which are always shiny-locked', () => {
    expect(summary(214).fixed).toEqual([
      expect.objectContaining({ kind: 'trade', shinyLocked: true, location: null }),
    ]);
  });

  it('marks Mega Dimension gifts and statics', () => {
    const latias = summary(380);
    expect(latias).toMatchObject({ dlc: true, shinySource: 'fixed' });
    expect(latias.fixed[0]?.conditions).toEqual(['Mega Dimension']);
  });

  it('reads the wild shiny byte as PKHeX’s Shiny enum (1 = Never, 2 = Always)', () => {
    const rows = (pokemonId: number) => za.pokemon[String(pokemonId)]?.rows ?? [];
    // Wild Zone 18 (location 202): the Lv. 40 Gastly and Lv. 42 Gengar slots are Shiny.Never.
    expect(rows(92)).toContainEqual({ k: 'wild', l: 202, n: 40, x: 40, s: 1 });
    expect(rows(94)).toContainEqual({ k: 'wild', l: 202, n: 42, x: 42, s: 1 });
    // Wild Zone 1 (location 194): the Lv. 11 Mareep slot is Shiny.Always, not locked.
    expect(rows(179)).toContainEqual({ k: 'wild', l: 194, n: 11, x: 11, c: ['Always shiny'] });
    expect(
      rows(179)
        .filter((row) => row.n === 11)
        .every((row) => row.s === undefined),
    ).toBe(true);
  });

  it('resolves regional forms and Pokémon that are not in the game', () => {
    expect(summary(10161)).toMatchObject({ presence: 'listed', dlc: true }); // Galarian Meowth
    expect(summary(906)).toMatchObject({ presence: 'missing', shinySource: 'none' }); // Sprigatito
  });
});

// ───────────────────────────── Hook ─────────────────────────────

describe('useGameEncounters', () => {
  let client: QueryClient;
  function wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  }

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it('picks the source per game', () => {
    expect(encounterOrigin('za')).toBe('bundled');
    expect(encounterOrigin('hgss')).toBe('pokeapi');
    expect(encounterOrigin('nope')).toBeNull();
  });

  it('lazy-loads a bundled game and keeps PokeAPI idle', async () => {
    vi.mocked(usePokeApiEncounterSlice).mockReturnValue(queryResult({}));
    const { result } = renderHook(() => useGameEncounters('za', 92), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.origin).toBe('bundled');
    expect(result.current.slice).toMatchObject({ availabilityKnown: true, pokemon: { dex: 65 } });
    expect(vi.mocked(usePokeApiEncounterSlice)).toHaveBeenCalledWith('za', null);
  });

  it('passes PokeAPI games through, with loading, error and retry', () => {
    const refetch = vi.fn();
    vi.mocked(usePokeApiEncounterSlice).mockReturnValue(queryResult({ refetch }));
    const { result, rerender } = renderHook(() => useGameEncounters('hgss', 25), { wrapper });

    expect(vi.mocked(usePokeApiEncounterSlice)).toHaveBeenLastCalledWith('hgss', 25);
    expect(result.current.status).toBe('loading');

    const error = new Error('offline');
    vi.mocked(usePokeApiEncounterSlice).mockReturnValue(
      queryResult({ isError: true, isPending: false, error, refetch }),
    );
    rerender();
    expect(result.current).toMatchObject({ status: 'error', error });
    result.current.retry();
    expect(refetch).toHaveBeenCalledTimes(1);

    const data = slice([], { availabilityKnown: false });
    vi.mocked(usePokeApiEncounterSlice).mockReturnValue(
      queryResult({ data, isPending: false, refetch }),
    );
    rerender();
    expect(result.current).toMatchObject({ status: 'ready', origin: 'pokeapi', slice: data });
  });

  it('reports games without any location data as unsupported', () => {
    vi.mocked(usePokeApiEncounterSlice).mockReturnValue(queryResult({}));
    const { result } = renderHook(() => useGameEncounters('nope', 25), { wrapper });

    expect(result.current).toMatchObject({ status: 'unsupported', origin: null, slice: null });
    expect(vi.mocked(usePokeApiEncounterSlice)).toHaveBeenCalledWith('nope', null);
  });
});
