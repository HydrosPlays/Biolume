import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { QueryClient } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncounterRow, GameEncounterSlice } from '@renderer/data/encounterSchema';
import bidoofFixture from './__fixtures__/pokemon-encounters-bidoof.json';
import eeveeFixture from './__fixtures__/pokemon-encounters-eevee.json';
import gyaradosFixture from './__fixtures__/pokemon-encounters-gyarados.json';
import pidgeyFixture from './__fixtures__/pokemon-encounters-pidgey.json';
import skwovetFixture from './__fixtures__/pokemon-encounters-skwovet.json';
import vocabulary from './__fixtures__/encounter-vocabulary.json';
import {
  ENCOUNTER_METHODS,
  POKEAPI_ENCOUNTER_GAMES,
  POKEAPI_ENCOUNTER_SOURCE,
  areaDisplayName,
  conditionLabel,
  createPokeApiEncounterClient,
  encounterKeys,
  encounterMethod,
  encounterMethodAt,
  pokemonEncountersQueryOptions,
  toGameEncounterSlice,
  trimEncounters,
  usePokeApiEncounterSlice,
} from './encounters';
import { isPokeApiError, titleCaseSlug } from './pokeapi';
import { PokeApiProvider } from './provider';
import {
  createPersistOptions,
  createPokeApiPersister,
  createPokeApiQueryClient,
} from './queryClient';

const API = 'https://pokeapi.co/api/v2';

function slice(raw: unknown, pokemonId: number, gameId: string): GameEncounterSlice {
  return toGameEncounterSlice(trimEncounters(raw, pokemonId), gameId);
}

/** Rows of a slice at one location, by name. */
function rowsAt(result: GameEncounterSlice, location: string): EncounterRow[] {
  const id = Object.entries(result.locations).find(([, name]) => name === location)?.[0];
  expect(id, `location "${location}"`).toBeDefined();
  return (result.pokemon?.rows ?? []).filter((row) => String(row.l) === id);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A slot as PokeAPI reports it: [method, chance, conditions, levels]. */
type SlotSpec = [method: string, chance: number, conditions?: string[], levels?: [number, number]];

/** A hand-made `/pokemon/{id}/encounters` payload: one area, several versions. */
function payloadVersions(area: string, versions: Record<string, SlotSpec[]>): unknown {
  return [
    {
      location_area: { name: area, url: `${API}/location-area/1/` },
      version_details: Object.entries(versions).map(([version, slots]) => ({
        version: { name: version, url: `${API}/version/1/` },
        max_chance: 100,
        encounter_details: slots.map(([method, chance, conditions = [], [min, max] = [5, 5]]) => ({
          min_level: min,
          max_level: max,
          chance,
          method: { name: method, url: `${API}/encounter-method/1/` },
          condition_values: conditions.map((name) => ({ name, url: '' })),
          pokemon_details: null,
        })),
      })),
    },
  ];
}

/** A hand-made `/pokemon/{id}/encounters` payload: one area, one version. */
function payload(area: string, version: string, slots: SlotSpec[]): unknown {
  return payloadVersions(area, { [version]: slots });
}

// ───────────────────────────── Vocabulary ─────────────────────────────

describe('encounter methods', () => {
  it('maps every PokeAPI encounter method explicitly', () => {
    expect(vocabulary.methods).toHaveLength(66);
    const unmapped = vocabulary.methods.filter(
      (method) => !Object.hasOwn(ENCOUNTER_METHODS, method),
    );
    expect(unmapped).toEqual([]);
    for (const method of vocabulary.methods) {
      expect(encounterMethod(method).m.length).toBeGreaterThan(0);
    }
  });

  it('gives each method a kind and a readable label', () => {
    expect(encounterMethod('walk')).toEqual({ k: 'wild', m: 'Grass / cave' });
    expect(encounterMethod('surf')).toEqual({ k: 'surf', m: 'Surfing' });
    expect(encounterMethod('old-rod')).toEqual({ k: 'fishing', m: 'Old Rod' });
    expect(encounterMethod('good-rod')).toEqual({ k: 'fishing', m: 'Good Rod' });
    expect(encounterMethod('super-rod')).toEqual({ k: 'fishing', m: 'Super Rod' });
    expect(encounterMethod('rock-smash')).toEqual({ k: 'interact', m: 'Rock Smash' });
    expect(encounterMethod('headbutt').k).toBe('interact');
    expect(encounterMethod('honey-tree').k).toBe('interact');
    expect(encounterMethod('gift')).toEqual({ k: 'gift', m: 'Gift' });
    expect(encounterMethod('gift-egg')).toEqual({ k: 'gift', m: 'Egg gift' });
    expect(encounterMethod('static').k).toBe('static');
    expect(encounterMethod('pokeflute').k).toBe('static');
    expect(encounterMethod('npc-trade')).toEqual({ k: 'trade', m: 'In-game trade' });
    for (const special of [
      'roaming-grass',
      'sos',
      'dark-grass',
      'grass-spots',
      'horde',
      'island-scan',
    ]) {
      expect(encounterMethod(special).k).toBe('special');
    }
    expect(encounterMethod('hidden-grotto').k).toBe('den');
    expect(encounterMethod('max-raid')).toEqual({ k: 'raid', m: 'Max Raid' });
    expect(encounterMethod('dynamax-adventure').k).toBe('raid');
    expect(encounterMethod('overworld-water').k).toBe('surf');
  });

  it('falls back to a title-cased special method for unknown slugs', () => {
    expect(encounterMethod('moon-portal')).toEqual({ k: 'special', m: 'Moon Portal' });
    expect(encounterMethod('constructor')).toEqual({ k: 'special', m: 'Constructor' });
  });

  it('reads Poké Pelago "gifts" as random visitors', () => {
    expect(encounterMethodAt('gift', 'poke-pelago-poni-island-reached').k).toBe('special');
    expect(encounterMethodAt('gift', 'castelia-city-area')).toEqual({ k: 'gift', m: 'Gift' });
  });
});

describe('condition labels', () => {
  it('labels every PokeAPI condition value, or drops it as a default "off" value', () => {
    expect(vocabulary.conditionValues).toHaveLength(361);
    const fallbacks = vocabulary.conditionValues.filter(
      (value) => conditionLabel(value) === titleCaseSlug(value),
    );
    expect(fallbacks).toEqual([]);
  });

  it('writes conditions in plain English', () => {
    expect(conditionLabel('time-morning')).toBe('Morning');
    expect(conditionLabel('time-night')).toBe('Night');
    expect(conditionLabel('season-spring')).toBe('Spring');
    expect(conditionLabel('swarm-yes')).toBe('Swarm');
    expect(conditionLabel('radar-on')).toBe('Poké Radar');
    expect(conditionLabel('radio-hoenn')).toBe('Hoenn Sound (radio)');
    expect(conditionLabel('slot2-ruby')).toBe('Ruby in slot 2');
    expect(conditionLabel('slot2-leafgreen')).toBe('LeafGreen in slot 2');
    expect(conditionLabel('weather-raining')).toBe('Raining');
    expect(conditionLabel('story-progress-national-dex')).toBe(
      'After obtaining the National Pokédex',
    );
    expect(conditionLabel('starter-froakie')).toBe('Chose Froakie as starter');
    expect(conditionLabel('trade-meowth-galar')).toBe('Give Galarian Meowth');
    expect(conditionLabel('trade-nidoran-m')).toBe('Give Nidoran♂');
    expect(conditionLabel('coins-1200')).toBe('Game Corner prize (1,200 coins)');
    expect(conditionLabel('weekday-friday')).toBe('Fridays');
    expect(conditionLabel('item-helix-fossil')).toBe('Needs the Helix Fossil');
    expect(conditionLabel('great-marsh-daily-slot-2-of-32')).toBe(
      'Great Marsh daily Pokémon (2 of 32 days)',
    );
    expect(conditionLabel('johto-safari-blocks-water-min-6')).toBe(
      'Safari Zone: 6+ Water block points',
    );
    expect(conditionLabel('time-21-00-to-03-59')).toBe('22:00–03:59');
    expect(conditionLabel('story-progress-beat-galactic-coronet')).toBe(
      'After visiting Lake Verity once Team Galactic is beaten at Mt. Coronet',
    );
  });

  it('drops values that only mean the default state', () => {
    for (const off of [
      'swarm-no',
      'radar-off',
      'slot2-none',
      'radio-off',
      'bug-catching-contest-no',
      'johto-safari-blocks-inactive',
      'backlot-not-mentioned',
      'great-marsh-daily-slot-none',
      'story-progress-none',
      'other-none',
      'item-none',
    ]) {
      expect(conditionLabel(off), off).toBeNull();
    }
  });

  it('title-cases unknown values', () => {
    expect(conditionLabel('moon-phase-full')).toBe('Moon Phase Full');
  });
});

// ───────────────────────────── Normalisation ─────────────────────────────

describe('trimEncounters — slots, rates and version masks', () => {
  const gsc = slice(pidgeyFixture, 16, 'gsc');

  it('merges per-slot duplicates and sums their chance, per time of day', () => {
    // Gold / Silver Route 29: 30 % (Lv 2) + 20 % (Lv 3) + 4 % + 1 % (Lv 4), morning and day alike.
    expect(rowsAt(gsc, 'Route 29')).toEqual([
      { k: 'wild', l: 1, n: 2, x: 3, m: 'Grass / cave', v: 0b100, c: ['Morning / Day'], r: 50 },
      { k: 'wild', l: 1, n: 2, x: 4, m: 'Grass / cave', v: 0b011, c: ['Morning / Day'], r: 55 },
    ]);
  });

  it('keeps times of day apart when the rates differ, and sets version bits in display order', () => {
    expect(gsc.versions).toEqual(['Gold', 'Silver', 'Crystal']);
    expect(rowsAt(gsc, 'Route 30')).toEqual([
      { k: 'wild', l: 2, n: 2, x: 4, m: 'Grass / cave', v: 0b001, c: ['Morning'], r: 40 },
      { k: 'wild', l: 2, n: 2, x: 4, m: 'Grass / cave', v: 0b011, c: ['Day'], r: 50 },
      { k: 'wild', l: 2, n: 3, x: 4, m: 'Grass / cave', v: 0b100, c: ['Day'], r: 40 },
      { k: 'wild', l: 2, n: 4, x: 4, m: 'Grass / cave', v: 0b110, c: ['Morning'], r: 10 },
    ]);
  });

  it('gives a swarm its own row and never shows "off" values', () => {
    const route35 = rowsAt(gsc, 'Route 35');
    expect(route35).toContainEqual({
      k: 'wild',
      l: 3,
      n: 14,
      x: 14,
      m: 'Grass / cave',
      v: 0b100,
      c: ['Swarm', 'Morning / Day'],
      r: 5,
    });
    expect(route35.flatMap((row) => row.c ?? [])).not.toContain('Not during a swarm');
    expect(slice(pidgeyFixture, 16, 'dppt').pokemon?.rows).toContainEqual({
      k: 'wild',
      l: 1,
      n: 51,
      x: 51,
      m: 'Grass / cave',
      v: 0b011,
      c: ['Swarm'],
      r: 40,
    });
  });

  it('adds slots that need nothing to the time-specific ones (Diamond / Pearl Route 201)', () => {
    const route201 = rowsAt(slice(bidoofFixture, 399, 'dppt'), 'Route 201');
    // 20 (swarm-no) + 10 + 10 (radar-off) + 5 + 4 (slot2-none) + 1 (radar-off); +10 at night.
    expect(route201.filter((row) => row.v === 0b011)).toEqual([
      { k: 'wild', l: 2, n: 2, x: 3, m: 'Grass / cave', v: 0b011, c: ['Morning / Day'], r: 50 },
      { k: 'wild', l: 2, n: 2, x: 3, m: 'Grass / cave', v: 0b011, c: ['Night'], r: 60 },
    ]);
  });

  it('adds no row for a requirement that leaves the rate unchanged (dual-slot mode)', () => {
    const route202 = rowsAt(slice(bidoofFixture, 399, 'dppt'), 'Route 202');
    expect(route202.find((row) => row.v === 0b011)).toEqual({
      k: 'wild',
      l: 3,
      n: 2,
      x: 4,
      m: 'Grass / cave',
      v: 0b011,
      r: 30,
    });
    expect(route202.flatMap((row) => row.c ?? []).some((label) => label.includes('slot 2'))).toBe(
      false,
    );
  });

  it('counts the slots a requirement adds on top of the regular ones (Great Marsh daily Pokémon)', () => {
    expect(rowsAt(slice(bidoofFixture, 399, 'dppt'), 'Great Marsh — Area 1')).toEqual([
      { k: 'wild', l: 1, n: 26, x: 26, m: 'Grass / cave', v: 0b011, r: 1 },
      {
        k: 'wild',
        l: 1,
        n: 26,
        x: 26,
        m: 'Grass / cave',
        v: 0b011,
        c: ['Great Marsh daily Pokémon (1 of 32 days)', 'Before obtaining the National Pokédex'],
        r: 11,
      },
    ]);
  });

  it('drops versions of games Biolume does not take from PokeAPI', () => {
    const detail = {
      min_level: 5,
      max_level: 5,
      chance: 100,
      method: { name: 'walk' },
      condition_values: [],
    };
    const data = trimEncounters(
      [
        {
          location_area: { name: 'pallet-town-area' },
          version_details: ['red', 'brilliant-diamond', 'scarlet', 'legends-za'].map((name) => ({
            version: { name },
            max_chance: 100,
            encounter_details: [detail],
          })),
        },
      ],
      16,
    );
    expect(Object.keys(data.games).sort()).toEqual([...POKEAPI_ENCOUNTER_GAMES].sort());
    for (const game of Object.values(data.games)) expect(game).toEqual({ areas: [], rows: [] });
  });

  it('rejects payloads that are not an encounter list', () => {
    expect(() => trimEncounters({ id: 16 }, 16)).toThrow(
      expect.objectContaining({ name: 'PokeApiError', kind: 'invalid-response' }),
    );
    expect(trimEncounters([], 16).games.gsc).toEqual({ areas: [], rows: [] });
  });
});

describe('trimEncounters — Sword / Shield', () => {
  const swsh = slice(skwovetFixture, 819, 'swsh');

  it('folds the expansion versions into Sword / Shield with a condition', () => {
    expect(swsh.versions).toEqual(['Sword', 'Shield']);
    const ballimere = rowsAt(swsh, 'Ballimere Lake');
    expect(ballimere.length).toBeGreaterThan(0);
    for (const row of ballimere) {
      expect(row.c?.[0]).toBe('Crown Tundra');
      // Found in both versions → no mask.
      expect(row.v).toBeUndefined();
    }
  });

  it('groups weathers with the same rate, against the weathers the area has', () => {
    // Ballimere Lake never has a snowstorm or a sandstorm: 20 % in four of its
    // seven weathers (Bulbapedia: clear, cloudy, thunderstorm, sun 20 %).
    expect(rowsAt(swsh, 'Ballimere Lake').filter((row) => row.m === 'Overworld')).toEqual([
      {
        k: 'wild',
        l: 1,
        n: 60,
        x: 65,
        m: 'Overworld',
        c: ['Crown Tundra', 'Any weather except Raining / Snowing / Fog'],
        r: 20,
      },
      { k: 'wild', l: 1, n: 60, x: 65, m: 'Overworld', c: ['Crown Tundra', 'Fog'], r: 30 },
      {
        k: 'wild',
        l: 1,
        n: 60,
        x: 65,
        m: 'Overworld',
        c: ['Crown Tundra', 'Raining / Snowing'],
        r: 25,
      },
    ]);
  });

  it('puts the raid rating into the method label', () => {
    expect(rowsAt(swsh, 'Bridge Field — Max Den E')).toEqual([
      { k: 'raid', l: 2, n: 15, x: 20, m: 'Max Raid ★1', c: ['Purple beam (rare den)'], r: 20 },
      { k: 'raid', l: 2, n: 15, x: 20, m: 'Max Raid ★1', c: ['Red beam (common den)'], r: 35 },
      { k: 'raid', l: 2, n: 25, x: 30, m: 'Max Raid ★2', c: ['Purple beam (rare den)'], r: 40 },
    ]);
  });

  it('splits rows before and after the Hall of Fame', () => {
    expect(rowsAt(swsh, 'Dappled Grove')).toEqual([
      {
        k: 'interact',
        l: 3,
        n: 11,
        x: 15,
        m: 'Berry tree',
        c: ['Before entering the Hall of Fame'],
        r: 70,
      },
      {
        k: 'interact',
        l: 3,
        n: 60,
        x: 60,
        m: 'Berry tree',
        c: ['After entering the Hall of Fame'],
        r: 70,
      },
    ]);
  });
});

describe('trimEncounters — special cases', () => {
  const rows = (raw: unknown, gameId: string, pokemonId = 25): EncounterRow[] =>
    slice(raw, pokemonId, gameId).pokemon?.rows ?? [];

  it('gives single fixed spawns no rate and no count (PokeAPI repeats some)', () => {
    const traps = payload('team-rocket-hq-area', 'gold', [
      ['static', 100],
      ['static', 100],
      ['static', 100],
    ]);
    expect(rows(traps, 'gsc', 100)).toEqual([
      { k: 'static', l: 1, n: 5, x: 5, m: 'Static encounter', v: 0b001 },
    ]);
    // FireRed / LeafGreen list the one Moltres twice.
    const moltres = payload('mt-ember-summit', 'firered', [
      ['static', 100, [], [50, 50]],
      ['static', 100, [], [50, 50]],
    ]);
    expect(rows(moltres, 'frlg', 146)).toEqual([
      { k: 'static', l: 1, n: 50, x: 50, m: 'Static encounter', v: 0b01 },
    ]);
    const wanderer = payload('rolling-fields-main', 'sword', [['wanderer', 100]]);
    expect(rows(wanderer, 'swsh')).toEqual([
      { k: 'wild', l: 1, n: 5, x: 5, m: 'Fixed overworld spawn', v: 0b01 },
    ]);
  });

  it('gives no rate where the chance is a group share or roaming odds', () => {
    const honey = payload('route-205', 'diamond', [['honey-tree', 100, ['honey-tree-group-c']]]);
    expect(rows(honey, 'dppt', 446)[0]).toEqual({
      k: 'interact',
      l: 1,
      n: 5,
      x: 5,
      m: 'Honey tree',
      v: 0b001,
      c: ['Honey tree group C (Munchlax trees only, 1%)'],
    });
    const roamer = payload('roaming-johto-area', 'heartgold', [
      ['roaming-grass', 25, ['story-progress-awakened-beasts']],
    ]);
    expect(rows(roamer, 'hgss', 244)[0]?.r).toBeUndefined();
  });

  it('drops the den beam when the Pokémon is in red and purple dens alike', () => {
    const den = payload('giants-bed-max-den-e', 'the-crown-tundra-shield', [
      ['max-raid', 25, ['max-den-rarity-common', 'max-den-rating-3-star']],
      ['max-raid', 25, ['max-den-rarity-rare', 'max-den-rating-3-star']],
      ['max-raid', 10, ['max-den-rarity-rare', 'max-den-rating-5-star'], [55, 60]],
    ]);
    expect(rows(den, 'swsh')).toEqual([
      { k: 'raid', l: 1, n: 5, x: 5, m: 'Max Raid ★3', v: 0b10, c: ['Crown Tundra'], r: 25 },
      {
        k: 'raid',
        l: 1,
        n: 55,
        x: 60,
        m: 'Max Raid ★5',
        v: 0b10,
        c: ['Crown Tundra', 'Purple beam (rare den)'],
        r: 10,
      },
    ]);
  });

  it('names most-of-the-weather rows by the weathers they exclude', () => {
    const weathers = [
      'weather-normal',
      'weather-overcast',
      'weather-raining',
      'weather-thunderstorm',
      'weather-sandstorm',
      'weather-intense-sun',
      'weather-fog',
    ];
    const fields = payload(
      'rolling-fields-main',
      'sword',
      weathers.map((weather): SlotSpec => ['overworld', 20, [weather]]),
    );
    expect(rows(fields, 'swsh')[0]?.c).toEqual(['Any weather except Snowing / Snowstorm']);
  });

  it('only names weathers the area can have', () => {
    // The Isle of Armor never snows: these are all of Loop Lagoon's weathers.
    const allSeven = [
      'weather-normal',
      'weather-overcast',
      'weather-raining',
      'weather-thunderstorm',
      'weather-sandstorm',
      'weather-intense-sun',
      'weather-fog',
    ];
    const lagoon = payload(
      'loop-lagoon-area',
      'the-isle-of-armor-sword',
      allSeven.map((weather): SlotSpec => ['overworld', 20, [weather]]),
    );
    expect(rows(lagoon, 'swsh')[0]?.c).toEqual(['Isle of Armor']);
    // Slippery Slope has no rain, thunderstorm or sandstorm.
    const slope = payload(
      'slippery-slope-area',
      'the-crown-tundra-shield',
      ['normal', 'overcast', 'snowing', 'snowstorm', 'intense-sun'].map((weather): SlotSpec => [
        'walk',
        20,
        [`weather-${weather}`],
      ]),
    );
    expect(rows(slope, 'swsh')[0]?.c).toEqual(['Crown Tundra', 'Any weather except Fog']);
  });

  it("reads Rolling Fields' max-den tag outside raids as before the Hall of Fame", () => {
    const fields = payload('rolling-fields-main', 'sword', [
      ['walk', 10, ['max-den-rarity-special'], [8, 10]],
      ['walk', 10, ['story-progress-hall-of-fame'], [60, 60]],
    ]);
    expect(rows(fields, 'swsh').map((row) => [row.c, row.n, row.r])).toEqual([
      [['Before entering the Hall of Fame'], 8, 10],
      [['After entering the Hall of Fame'], 60, 10],
    ]);
  });

  it('shows Poké Pelago visitors as random visitors, never as locked gifts', () => {
    const pelago = payload('poke-pelago-poni-island-reached', 'ultra-sun', [
      ['gift', 3, [], [37, 43]],
    ]);
    // PKHeX's only fixed Pinsir in Ultra Sun / Ultra Moon (Exeggutor Island, Lv. 42–43) is locked.
    expect(rows(pelago, 'usum', 127)).toEqual([
      {
        k: 'special',
        l: 1,
        n: 37,
        x: 43,
        m: 'Poké Pelago visitor (Isle Abeens)',
        v: 0b01,
        r: 3,
      },
    ]);
  });

  it('combines several state categories without over-generalising', () => {
    const route = payload('sinnoh-route-210-south-towards-solaceon-town', 'platinum', [
      ['walk', 20],
      ['walk', 10, ['time-night']],
      ['walk', 10, ['story-progress-national-dex']],
    ]);
    // Rows of one place and method are ordered by their conditions.
    expect(rows(route, 'dppt').map((row) => [row.c, row.r])).toEqual([
      [['Morning / Day', 'After obtaining the National Pokédex'], 30],
      [['Morning / Day', 'Before obtaining the National Pokédex'], 20],
      [['Night', 'After obtaining the National Pokédex'], 40],
      [['Night', 'Before obtaining the National Pokédex'], 30],
    ]);
  });
});

describe('trimEncounters — PokeAPI slips (checked against Bulbapedia)', () => {
  const rows = (raw: unknown, gameId: string, pokemonId: number): EncounterRow[] =>
    slice(raw, pokemonId, gameId).pokemon?.rows ?? [];
  const superRod = (time?: string): SlotSpec => ['super-rod', 30, time ? [time] : [], [40, 40]];

  it("gives Silver's Super Rod slots back the times Gold has for the same table", () => {
    // Olivine City: Corsola 30 % in the morning and day in all three versions.
    const corsola = payloadVersions('olivine-city-area', {
      gold: [superRod('time-morning'), superRod('time-day')],
      silver: [superRod(), superRod()],
      crystal: [superRod('time-day'), superRod('time-morning')],
    });
    expect(rows(corsola, 'gsc', 222)).toEqual([
      { k: 'fishing', l: 1, n: 40, x: 40, m: 'Super Rod', c: ['Morning / Day'], r: 30 },
    ]);
    const staryu = payloadVersions('olivine-city-area', {
      gold: [superRod('time-night')],
      silver: [superRod()],
    });
    expect(rows(staryu, 'gsc', 120)).toEqual([
      { k: 'fishing', l: 1, n: 40, x: 40, m: 'Super Rod', v: 0b011, c: ['Night'], r: 30 },
    ]);
  });

  it('leaves untagged slots alone when the sibling table differs', () => {
    const different = payloadVersions('olivine-city-area', {
      gold: [superRod('time-night')],
      silver: [superRod(), superRod()],
    });
    expect(rows(different, 'gsc', 120)).toContainEqual({
      k: 'fishing',
      l: 1,
      n: 40,
      x: 40,
      m: 'Super Rod',
      v: 0b010,
      r: 60,
    });
  });

  it("rebuilds Crystal's Route 13 grass times (morning and day alike, night apart)", () => {
    const grass = (copies: number, chance: number, level: number): SlotSpec[] =>
      Array.from({ length: copies }, (): SlotSpec => ['walk', chance, [], [level, level]]);
    const route13 = (slots: SlotSpec[]) =>
      payloadVersions('kanto-route-13-area', { crystal: slots });
    expect(rows(route13(grass(2, 30, 23)), 'gsc', 30)).toEqual([
      { k: 'wild', l: 1, n: 23, x: 23, m: 'Grass / cave', v: 0b100, c: ['Morning / Day'], r: 30 },
    ]);
    expect(rows(route13(grass(1, 30, 23)), 'gsc', 48)).toEqual([
      { k: 'wild', l: 1, n: 23, x: 23, m: 'Grass / cave', v: 0b100, c: ['Night'], r: 30 },
    ]);
    expect(rows(route13(grass(3, 1, 25)), 'gsc', 113)).toEqual([
      { k: 'wild', l: 1, n: 25, x: 25, m: 'Grass / cave', v: 0b100, r: 1 },
    ]);
  });

  it("puts Crystal's Route 42 Golbat at night only", () => {
    const golbat = payloadVersions('johto-route-42-area', {
      crystal: [
        ['walk', 10, ['time-night'], [16, 16]],
        ['walk', 4, ['time-night'], [16, 16]],
        ['walk', 1, [], [16, 16]],
      ],
    });
    expect(rows(golbat, 'gsc', 42)).toEqual([
      { k: 'wild', l: 1, n: 16, x: 16, m: 'Grass / cave', v: 0b100, c: ['Night'], r: 15 },
    ]);
  });

  it('re-files or drops encounters PokeAPI files under the wrong place', () => {
    const roamer = payload('team-flare-secret-hq-area', 'black', [['static', 100, [], [40, 40]]]);
    expect(slice(roamer, 641, 'bw').locations).toEqual({ 1: 'Unova (Roaming)' });

    const eon = payload('roaming-johto-area', 'heartgold', [['roaming-grass', 10, [], [35, 35]]]);
    expect(slice(eon, 380, 'hgss').locations).toEqual({ 1: 'Roaming Kanto' });
    expect(slice(eon, 243, 'hgss').locations).toEqual({ 1: 'Roaming Johto' });

    const mauville = payloadVersions('new-mauville-area', {
      sapphire: [['static', 100, [], [25, 25]]],
      sun: [['static', 100, [], [25, 25]]],
    });
    expect(rows(mauville, 'sm', 100)).toEqual([]);
    expect(rows(mauville, 'rse', 100)).toEqual([
      { k: 'static', l: 1, n: 25, x: 25, m: 'Static encounter', v: 0b010 },
    ]);

    const school = payload('trainers-school-area', 'ultra-sun', [['static', 100, [], [19, 19]]]);
    expect(rows(school, 'usum', 92)).toEqual([]);

    // HeartGold / SoulSilver's broken copy of Vermilion City's water table;
    // Gold / Silver / Crystal's dock table is kept.
    const dock = payloadVersions('vermilion-city-ss-anne-dock', {
      heartgold: [['super-rod', 40, [], [40, 40]]],
      gold: [['super-rod', 40, [], [40, 40]]],
    });
    expect(rows(dock, 'hgss', 129)).toEqual([]);
    expect(rows(dock, 'gsc', 129)).toHaveLength(1);
  });
});

describe('trimEncounters — shiny locks', () => {
  it("keeps PokeAPI's own never-shiny flag (Let's Go, Eevee! partner)", () => {
    expect(slice(eeveeFixture, 133, 'lgpe').pokemon?.rows).toEqual([
      { k: 'gift', l: 1, n: 5, x: 5, m: 'Gift', v: 0b10, s: 1 },
    ]);
  });

  it('adds the locks PKHeX knows and PokeAPI misses (Black 2 / White 2 Castelia Eevee)', () => {
    const castelia = slice(eeveeFixture, 133, 'b2w2').pokemon?.rows ?? [];
    expect(castelia.find((row) => row.k === 'gift')).toEqual({
      k: 'gift',
      l: 1,
      n: 10,
      x: 10,
      m: 'Gift',
      s: 1,
    });
    // Wild Eevee there can be shiny.
    expect(castelia.filter((row) => row.k !== 'gift').every((row) => row.s === undefined)).toBe(
      true,
    );
  });

  it('marks nicknamed Sword / Shield trades as locked', () => {
    expect(rowsAt(slice(skwovetFixture, 819, 'swsh'), 'Motostoke — Pokémon Center')).toEqual([
      { k: 'trade', l: 4, n: 10, x: 10, m: 'In-game trade', c: ['Give Bunnelby'], s: 1 },
    ]);
  });

  it('marks always-shiny encounters (the red Gyarados) and leaves the rest alone', () => {
    const lakeOfRage = slice(gyaradosFixture, 130, 'gsc').pokemon?.rows ?? [];
    expect(lakeOfRage.find((row) => row.k === 'static')).toEqual({
      k: 'static',
      l: 1,
      n: 30,
      x: 30,
      m: 'Static encounter',
      c: ['Always shiny'],
    });
    expect(lakeOfRage.filter((row) => row.k !== 'static').map((row) => [row.m, row.r])).toEqual([
      ['Surfing', 10],
      ['Good Rod', 10],
      ['Super Rod', 30],
    ]);
    expect(lakeOfRage.some((row) => row.s === 1)).toBe(false);
  });
});

// ───────────────────────────── Slices ─────────────────────────────

describe('toGameEncounterSlice', () => {
  it('numbers locations alphabetically and names them from the location index', () => {
    const result = slice(bidoofFixture, 399, 'dppt');
    expect(result.locations).toEqual({
      1: 'Great Marsh — Area 1',
      2: 'Route 201',
      3: 'Route 202',
    });
    expect(result.gameId).toBe('dppt');
    expect(result.source).toBe(POKEAPI_ENCOUNTER_SOURCE);
    expect(result.availabilityKnown).toBe(false);
    for (const row of result.pokemon?.rows ?? []) {
      expect(result.locations[String(row.l)]).toBeDefined();
    }
  });

  it('reports no rows (not "unavailable") when PokeAPI lists nothing for the game', () => {
    const result = slice(bidoofFixture, 399, 'xy');
    expect(result.pokemon).toEqual({ rows: [] });
    expect(result.locations).toEqual({});
    expect(result.versions).toEqual(['X', 'Y']);
    expect(result.availabilityKnown).toBe(false);
  });

  it('names areas from the bundled index, with a readable fallback', () => {
    expect(areaDisplayName('sprout-tower-2f')).toBe('Sprout Tower — 2F');
    expect(areaDisplayName('johto-route-32-area')).toBe('Route 32');
    expect(areaDisplayName('lake-valor-cavern')).toBe('Lake Valor — Cavern');
    expect(areaDisplayName('mt-coronet-1f-route-207')).toBe('Mt. Coronet — 1F Route 207');
    expect(areaDisplayName('brand-new-tower-b2f')).toBe('Brand New Tower B2F');
    expect(areaDisplayName('brand-new-meadow-area')).toBe('Brand New Meadow');
  });

  it('corrects names PokeAPI gets wrong', () => {
    // PokeAPI names the location "Royal Avenue", which is on another island.
    expect(areaDisplayName('thrifty-megamart-abandoned-site')).toBe('Abandoned Thrifty Megamart');
    expect(areaDisplayName('embedded-tower-groundon-room')).toBe("Embedded Tower — Groudon's room");
    expect(areaDisplayName('unova-victory-road-4f-middle-room')).toBe(
      'Victory Road — 4F Middle Room',
    );
    expect(areaDisplayName('mirage-spot-island-west-of-route-104')).toBe(
      'Mirage Island — West of Route 104',
    );
  });
});

// ───────────────────────────── Client ─────────────────────────────

describe('PokeAPI encounter client', () => {
  it('requests /pokemon/{id}/encounters and trims the response', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(json(eeveeFixture)));
    const client = createPokeApiEncounterClient({ fetch: fetchMock, isOnline: () => true });
    const data = await client.fetchEncounters(133);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${API}/pokemon/133/encounters`);
    expect(data.pokemonId).toBe(133);
    expect(data.games.lgpe?.areas).toEqual(['pallet-town-area']);
  });

  it('fails as not-found on a 404 without retrying', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(json({}, 404)));
    const client = createPokeApiEncounterClient({
      fetch: fetchMock,
      backoffMs: 0,
      isOnline: () => true,
    });
    await expect(client.fetchEncounters(99999)).rejects.toMatchObject({ kind: 'not-found' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries server errors', async () => {
    let calls = 0;
    const fetchMock = vi.fn<typeof fetch>(() => {
      calls += 1;
      return Promise.resolve(calls === 1 ? json({}, 503) : json(gyaradosFixture));
    });
    const client = createPokeApiEncounterClient({
      fetch: fetchMock,
      backoffMs: 0,
      isOnline: () => true,
    });
    const data = await client.fetchEncounters(130);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(data.games.gsc?.rows.length).toBeGreaterThan(0);
  });

  it('rejects ids that cannot exist without touching the network', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = createPokeApiEncounterClient({ fetch: fetchMock });
    const error: unknown = await client.fetchEncounters(0).catch((caught: unknown) => caught);
    expect(isPokeApiError(error) && error.kind).toBe('not-found');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('builds versioned query keys under the persisted PokeAPI root', () => {
    expect(encounterKeys.all).toEqual(['pokeapi', 'encounters']);
    expect(pokemonEncountersQueryOptions(16).queryKey).toEqual(encounterKeys.pokemon(16));
    expect(encounterKeys.pokemon(16)[0]).toBe('pokeapi');
  });
});

// ───────────────────────────── Hook ─────────────────────────────

describe('usePokeApiEncounterSlice', () => {
  const fetchMock = vi.fn<typeof fetch>((input) => {
    const url = String(input);
    if (url === `${API}/pokemon/16/encounters`) return Promise.resolve(json(pidgeyFixture));
    return Promise.resolve(json({ status: 404 }, 404));
  });
  let client: QueryClient;

  function wrapper({ children }: { children: ReactNode }) {
    return createElement(PokeApiProvider, {
      client,
      persistOptions: createPersistOptions(createPokeApiPersister({ storage: undefined })),
      children,
    });
  }

  beforeEach(() => {
    client = createPokeApiQueryClient();
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    client.clear();
    vi.unstubAllGlobals();
  });

  it('covers Gold / Silver / Crystal through Sword / Shield', () => {
    expect([...POKEAPI_ENCOUNTER_GAMES].sort()).toEqual(
      [
        'b2w2',
        'bw',
        'dppt',
        'frlg',
        'gsc',
        'hgss',
        'lgpe',
        'oras',
        'rse',
        'sm',
        'swsh',
        'usum',
        'xy',
      ].sort(),
    );
  });

  it('stays idle without data for games PokeAPI has no locations for, and without an id', async () => {
    for (const [gameId, pokemonId] of [
      ['bdsp', 16],
      ['pla', 16],
      ['sv', 16],
      ['za', 16],
      ['nope', 16],
      ['gsc', null],
    ] as const) {
      const { result, unmount } = renderHook(() => usePokeApiEncounterSlice(gameId, pokemonId), {
        wrapper,
      });
      await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
      expect(result.current.isPending).toBe(true);
      expect(result.current.data).toBeUndefined();
      unmount();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('loads a game slice, and serves every other game from the same request', async () => {
    const { result, rerender } = renderHook(
      ({ gameId }: { gameId: string }) => usePokeApiEncounterSlice(gameId, 16),
      { wrapper, initialProps: { gameId: 'gsc' } },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.gameId).toBe('gsc');
    expect(result.current.data?.locations).toEqual({ 1: 'Route 29', 2: 'Route 30', 3: 'Route 35' });

    rerender({ gameId: 'dppt' });
    await waitFor(() => expect(result.current.data?.gameId).toBe('dppt'));
    expect(result.current.data?.locations).toEqual({ 1: 'Route 229' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${API}/pokemon/16/encounters`);
  });

  it('surfaces PokeAPI errors', async () => {
    const { result } = renderHook(() => usePokeApiEncounterSlice('gsc', 99999), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(isPokeApiError(result.current.error) && result.current.error.kind).toBe('not-found');
  });
});
