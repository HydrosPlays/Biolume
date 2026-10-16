import { afterEach, describe, expect, it, vi } from 'vitest';
import decidueyeFixture from './__fixtures__/pokemon-decidueye.json';
import speciesFixture from './__fixtures__/pokemon-species-vulpix.json';
import vulpixFixture from './__fixtures__/pokemon-vulpix-alola.json';
import {
  DEFAULT_RETRIES,
  POKEAPI_BASE_URL,
  PokeApiError,
  createPokeApiClient,
  describePokeApiError,
  fetchPokemon,
  fetchSpecies,
  isPokeApiError,
  titleCaseSlug,
  trimPokemon,
  trimSpecies,
  type PokeApiClientOptions,
  type PokeApiErrorKind,
} from './pokeapi';

const SPRITES = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';

// ───────────────────────────── helpers ─────────────────────────────

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

/** A fetch mock that answers each call with the next queued response (the last one repeats). */
function queuedFetch(...responses: (() => Response | Promise<Response>)[]): FetchMock {
  let call = 0;
  return vi.fn<typeof fetch>(() => {
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    if (!next) return Promise.reject(new Error('no response queued'));
    return Promise.resolve().then(next);
  });
}

/** A fetch that never answers, but rejects like the real one when its signal aborts. */
function hangingFetch(): FetchMock {
  return vi.fn<typeof fetch>(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = (): void =>
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      }),
  );
}

function clientWith(fetchMock: FetchMock, options: PokeApiClientOptions = {}) {
  return createPokeApiClient({ fetch: fetchMock, backoffMs: 0, isOnline: () => true, ...options });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

async function apiRejection(promise: Promise<unknown>): Promise<PokeApiError> {
  const error = await rejection(promise);
  if (!isPokeApiError(error)) throw new Error(`expected a PokeApiError, got ${String(error)}`);
  return error;
}

/** Minimal valid `/pokemon` payload for edge-case tests. */
function rawPokemon(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 25,
    name: 'pikachu',
    height: 4,
    weight: 60,
    species: { name: 'pikachu', url: 'https://pokeapi.co/api/v2/pokemon-species/25/' },
    types: [{ slot: 1, type: { name: 'electric', url: '' } }],
    stats: [{ base_stat: 35, effort: 0, stat: { name: 'hp', url: '' } }],
    abilities: [],
    sprites: {},
    moves: [],
    ...overrides,
  };
}

function rawMove(
  slug: string,
  details: [versionGroup: string, method: string, level: number, order?: number | null][],
): unknown {
  return {
    move: { name: slug, url: '' },
    version_group_details: details.map(([versionGroup, method, level, order = null]) => ({
      level_learned_at: level,
      order,
      move_learn_method: { name: method, url: '' },
      version_group: { name: versionGroup, url: '' },
    })),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ───────────────────────────── trimming ─────────────────────────────

describe('trimPokemon — recorded /pokemon/10103 response', () => {
  const detail = trimPokemon(vulpixFixture);

  it('keeps identity, typing, stats, abilities and measurements', () => {
    expect(detail).toMatchObject({
      id: 10103,
      slug: 'vulpix-alola',
      speciesId: 37,
      name: 'Alolan Vulpix',
      types: ['ice'],
      stats: { hp: 38, atk: 41, def: 40, spa: 50, spd: 65, spe: 65, total: 299 },
      abilities: [
        { slug: 'snow-cloak', name: 'Snow Cloak', hidden: false },
        { slug: 'snow-warning', name: 'Snow Warning', hidden: true },
      ],
      height: 0.6,
      weight: 9.9,
    });
  });

  it('keeps the six sprite urls the app uses', () => {
    expect(detail.sprites).toEqual({
      pixel: `${SPRITES}/10103.png`,
      pixelShiny: `${SPRITES}/shiny/10103.png`,
      home: `${SPRITES}/other/home/10103.png`,
      homeShiny: `${SPRITES}/other/home/shiny/10103.png`,
      artwork: `${SPRITES}/other/official-artwork/10103.png`,
      artworkShiny: `${SPRITES}/other/official-artwork/shiny/10103.png`,
    });
  });

  it('groups the movepool by version group', () => {
    expect(Object.keys(detail.moves)).toEqual(['scarlet-violet', 'sun-moon', 'sword-shield']);
    expect(detail.moves['sword-shield']?.levelUp).toEqual([
      { slug: 'powder-snow', level: 1 },
      { slug: 'tail-whip', level: 1 },
      { slug: 'ice-shard', level: 8 },
      { slug: 'icy-wind', level: 16 },
      { slug: 'confuse-ray', level: 20 },
      { slug: 'aurora-beam', level: 24 },
      { slug: 'extrasensory', level: 28 },
      { slug: 'ice-beam', level: 32 },
      { slug: 'mist', level: 40 },
      { slug: 'aurora-veil', level: 44 },
      { slug: 'sheer-cold', level: 48 },
      { slug: 'blizzard', level: 56 },
    ]);
  });

  it('orders same-level moves by PokeAPI `order`, not by position in the payload', () => {
    // Both games teach these at level 1, in opposite order.
    const firstTwo = (group: string) =>
      detail.moves[group]?.levelUp.slice(0, 2).map((move) => move.slug);
    expect(firstTwo('sword-shield')).toEqual(['powder-snow', 'tail-whip']);
    expect(firstTwo('scarlet-violet')).toEqual(['tail-whip', 'powder-snow']);
  });

  it('separates machine, egg and tutor moves', () => {
    const other = detail.moves['sword-shield']?.other;
    expect([...(other?.egg ?? [])].sort()).toEqual([
      'baby-doll-eyes',
      'freeze-dry',
      'moonblast',
      'roar',
    ]);
    expect([...(other?.machine ?? [])].sort()).toEqual([
      'blizzard',
      'encore',
      'ice-beam',
      'icy-wind',
      'payback',
    ]);
    expect(other?.tutor).toEqual([]);
    // A move can be both a level-up and a machine move.
    expect(detail.moves['sun-moon']?.other.machine).toContain('ice-beam');
    expect(detail.moves['sun-moon']?.levelUp).toContainEqual({ slug: 'ice-beam', level: 36 });
  });

  it('drops everything else from the payload', () => {
    expect(Object.keys(detail).sort()).toEqual([
      'abilities',
      'height',
      'id',
      'moves',
      'name',
      'slug',
      'speciesId',
      'sprites',
      'stats',
      'types',
      'weight',
    ]);
    const trimmed = JSON.stringify(detail);
    expect(trimmed).not.toContain('pokeapi.co');
    expect(trimmed).not.toContain('version_group_details');
    expect(trimmed).not.toContain('showdown');
    expect(trimmed.length).toBeLessThan(JSON.stringify(vulpixFixture).length / 5);
  });

  it('is JSON-serialisable without loss (it is persisted as JSON)', () => {
    expect(JSON.parse(JSON.stringify(detail))).toEqual(detail);
  });
});

describe('trimPokemon — recorded /pokemon/724 response', () => {
  const detail = trimPokemon(decidueyeFixture);

  it('keeps level-0 evolution moves first, then orders level 1 by `order`', () => {
    expect(detail.moves['sun-moon']?.levelUp.slice(0, 9)).toEqual([
      { slug: 'spirit-shackle', level: 0 },
      { slug: 'spirit-shackle', level: 1 },
      { slug: 'u-turn', level: 1 },
      { slug: 'tackle', level: 1 },
      { slug: 'leafage', level: 1 },
      { slug: 'growl', level: 1 },
      { slug: 'peck', level: 1 },
      { slug: 'growl', level: 4 },
      { slug: 'peck', level: 8 },
    ]);
    expect(detail.moves['scarlet-violet']?.levelUp.slice(0, 4)).toEqual([
      { slug: 'spirit-shackle', level: 0 },
      { slug: 'leafage', level: 1 },
      { slug: 'phantom-force', level: 1 },
      { slug: 'leaf-storm', level: 1 },
    ]);
  });

  it('sorts every learnset by level', () => {
    for (const group of Object.values(detail.moves)) {
      const levels = group.levelUp.map((move) => move.level);
      expect(levels).toEqual([...levels].sort((a, b) => a - b));
    }
  });

  it('names the Pokémon from the bundled index', () => {
    expect(detail).toMatchObject({
      id: 724,
      slug: 'decidueye',
      speciesId: 724,
      name: 'Decidueye',
      types: ['grass', 'ghost'],
    });
    expect(detail.abilities.map((ability) => [ability.slug, ability.hidden])).toEqual([
      ['overgrow', false],
      ['long-reach', true],
    ]);
  });
});

describe('trimPokemon — edge cases', () => {
  it('keeps payload order for same-level moves that all lack an `order`', () => {
    const detail = trimPokemon(
      rawPokemon({
        moves: [
          rawMove('wide-guard', [['scarlet-violet', 'level-up', 56]]),
          rawMove('quick-guard', [['scarlet-violet', 'level-up', 56]]),
          rawMove('close-combat', [['scarlet-violet', 'level-up', 63]]),
          rawMove('leer', [['scarlet-violet', 'level-up', 1]]),
        ],
      }),
    );
    expect(detail.moves['scarlet-violet']?.levelUp).toEqual([
      { slug: 'leer', level: 1 },
      { slug: 'wide-guard', level: 56 },
      { slug: 'quick-guard', level: 56 },
      { slug: 'close-combat', level: 63 },
    ]);
  });

  it('puts the unnumbered move of a partly numbered same-level group first', () => {
    // Hitmonchan in Emerald, as PokeAPI records it: the three punches are learned at Lv. 26 in
    // the order Thunder Punch, Ice Punch, Fire Punch, and only the last two carry an `order`.
    const detail = trimPokemon(
      rawPokemon({
        id: 107,
        name: 'hitmonchan',
        species: { name: 'hitmonchan', url: 'https://pokeapi.co/api/v2/pokemon-species/107/' },
        moves: [
          rawMove('comet-punch', [['emerald', 'level-up', 1, 2]]),
          rawMove('fire-punch', [['emerald', 'level-up', 26, 4]]),
          rawMove('ice-punch', [['emerald', 'level-up', 26, 3]]),
          rawMove('thunder-punch', [['emerald', 'level-up', 26]]),
          rawMove('mega-punch', [['emerald', 'level-up', 35]]),
          rawMove('agility', [['emerald', 'level-up', 7]]),
          rawMove('pursuit', [['emerald', 'level-up', 13]]),
          rawMove('mach-punch', [['emerald', 'level-up', 20]]),
          rawMove('sky-uppercut', [['emerald', 'level-up', 32]]),
          rawMove('revenge', [['emerald', 'level-up', 1, 1]]),
        ],
      }),
    );
    expect(detail.moves.emerald?.levelUp.map((move) => `${move.level}:${move.slug}`)).toEqual([
      '1:revenge',
      '1:comet-punch',
      '7:agility',
      '13:pursuit',
      '20:mach-punch',
      '26:thunder-punch',
      '26:ice-punch',
      '26:fire-punch',
      '32:sky-uppercut',
      '35:mega-punch',
    ]);
  });

  it('leaves out version groups in which no move was kept', () => {
    const detail = trimPokemon(
      rawPokemon({
        moves: [
          rawMove('swords-dance', [
            ['champions', 'train', 0],
            ['scarlet-violet', 'machine', 0],
          ]),
          rawMove('body-slam', [['champions', 'train', 0]]),
        ],
      }),
    );
    expect(Object.keys(detail.moves)).toEqual(['scarlet-violet']);
  });

  it('de-duplicates repeated entries and ignores exotic learn methods', () => {
    const detail = trimPokemon(
      rawPokemon({
        moves: [
          rawMove('surf', [
            ['yellow', 'stadium-surfing-pikachu', 0],
            ['yellow', 'machine', 0],
            ['yellow', 'machine', 0],
          ]),
          rawMove('growl', [
            ['yellow', 'level-up', 1],
            ['yellow', 'level-up', 1],
          ]),
          rawMove('volt-tackle', [['x-y', 'light-ball-egg', 0]]),
          rawMove('iron-tail', [['x-y', 'tutor', 0]]),
          rawMove('charm', [['x-y', 'egg', 0]]),
        ],
      }),
    );
    expect(detail.moves.yellow).toEqual({
      levelUp: [{ slug: 'growl', level: 1 }],
      other: { machine: ['surf'], egg: [], tutor: [] },
    });
    expect(detail.moves['x-y']).toEqual({
      levelUp: [],
      other: { machine: [], egg: ['charm'], tutor: ['iron-tail'] },
    });
  });

  it('tolerates missing optional sections', () => {
    const detail = trimPokemon(
      rawPokemon({
        abilities: null,
        sprites: null,
        moves: undefined,
        height: null,
        weight: undefined,
      }),
    );
    expect(detail.abilities).toEqual([]);
    expect(detail.moves).toEqual({});
    expect(detail.height).toBe(0);
    expect(detail.weight).toBe(0);
    expect(Object.values(detail.sprites).every((url) => url === null)).toBe(true);
    expect(detail.stats).toEqual({ hp: 35, atk: 0, def: 0, spa: 0, spd: 0, spe: 0, total: 35 });
  });

  it('rejects sprite urls that are not https', () => {
    const detail = trimPokemon(
      rawPokemon({
        sprites: { front_default: 'http://example.com/a.png', front_shiny: 'javascript:1' },
      }),
    );
    expect(detail.sprites.pixel).toBeNull();
    expect(detail.sprites.pixelShiny).toBeNull();
  });

  it('sorts types and abilities by slot', () => {
    const detail = trimPokemon(
      rawPokemon({
        types: [
          { slot: 2, type: { name: 'flying' } },
          { slot: 1, type: { name: 'electric' } },
        ],
        abilities: [
          { is_hidden: true, slot: 3, ability: { name: 'lightning-rod' } },
          { is_hidden: false, slot: 1, ability: { name: 'static' } },
          { is_hidden: false, slot: 2, ability: null },
        ],
      }),
    );
    expect(detail.types).toEqual(['electric', 'flying']);
    expect(detail.abilities).toEqual([
      { slug: 'static', name: 'Static', hidden: false },
      { slug: 'lightning-rod', name: 'Lightning Rod', hidden: true },
    ]);
  });

  it('resolves the species through the bundled index when the url is missing', () => {
    const detail = trimPokemon(
      rawPokemon({ id: 10103, name: 'vulpix-alola', species: { name: 'vulpix' } }),
    );
    expect(detail.speciesId).toBe(37);
    expect(detail.name).toBe('Alolan Vulpix');
  });

  it('title-cases the slug of a variety the bundled index does not list', () => {
    const detail = trimPokemon(
      rawPokemon({
        id: 10033,
        name: 'venusaur-mega',
        species: { name: 'venusaur', url: 'https://pokeapi.co/api/v2/pokemon-species/3/' },
      }),
    );
    expect(detail.name).toBe('Venusaur Mega');
    expect(detail.speciesId).toBe(3);
  });

  it('throws invalid-response for payloads that are not a Pokémon', () => {
    for (const bad of [
      null,
      'nope',
      42,
      [],
      {},
      { id: 'x', name: 'pikachu' },
      rawPokemon({ id: -1 }),
    ]) {
      const error = (() => {
        try {
          trimPokemon(bad, 'https://example.test/pokemon/1');
        } catch (thrown) {
          return thrown;
        }
        return null;
      })();
      expect(isPokeApiError(error)).toBe(true);
      expect((error as PokeApiError).kind).toBe('invalid-response');
      expect((error as PokeApiError).url).toBe('https://example.test/pokemon/1');
    }
    expect(() => trimPokemon(rawPokemon({ types: 'electric' }))).toThrow(/at types/);
    expect(() => trimPokemon(rawPokemon({ species: { name: 'who-is-that' } }))).toThrow(
      /which species/,
    );
  });
});

describe('titleCaseSlug', () => {
  it('formats ability-style slugs', () => {
    expect(titleCaseSlug('snow-cloak')).toBe('Snow Cloak');
    expect(titleCaseSlug('power-of-alchemy')).toBe('Power of Alchemy');
    expect(titleCaseSlug('static')).toBe('Static');
    expect(titleCaseSlug('')).toBe('');
  });
});

describe('ability display names', () => {
  const namesOf = (...slugs: string[]): string[] =>
    trimPokemon(
      rawPokemon({
        abilities: slugs.map((slug, index) => ({
          is_hidden: false,
          slot: index + 1,
          ability: { name: slug },
        })),
      }),
    ).abilities.map((ability) => ability.name);

  it('uses the official spelling where title-casing the slug gets it wrong', () => {
    // Every main-series ability whose English name differs from its title-cased slug.
    expect(
      namesOf('dragons-maw', 'minds-eye', 'zero-to-hero', 'soul-heart', 'well-baked-body'),
    ).toEqual(["Dragon's Maw", "Mind's Eye", 'Zero to Hero', 'Soul-Heart', 'Well-Baked Body']);
    expect(namesOf('rks-system', 'as-one-glastrier', 'good-as-gold', 'tablets-of-ruin')).toEqual([
      'RKS System',
      'As One (Glastrier)',
      'Good as Gold',
      'Tablets of Ruin',
    ]);
  });

  it('does not mistake inherited object keys for names or stats', () => {
    const detail = trimPokemon(
      rawPokemon({
        abilities: [{ is_hidden: false, slot: 1, ability: { name: 'constructor' } }],
        stats: [
          { base_stat: 35, stat: { name: 'hp' } },
          { base_stat: 99, stat: { name: 'constructor' } },
        ],
      }),
    );
    expect(detail.abilities[0]?.name).toBe('Constructor');
    expect(detail.stats).toEqual({ hp: 35, atk: 0, def: 0, spa: 0, spd: 0, spe: 0, total: 35 });
  });
});

describe('trimSpecies — recorded /pokemon-species/37 response', () => {
  it('extracts the hunting-relevant facts', () => {
    expect(trimSpecies(speciesFixture)).toEqual({
      id: 37,
      slug: 'vulpix',
      name: 'Vulpix',
      generation: 1,
      captureRate: 190,
      genderRate: 6,
      baseHappiness: 70,
      growthRate: 'medium',
      eggGroups: ['ground'],
      hatchCounter: 20,
      isLegendary: false,
      isMythical: false,
      isBaby: false,
      hasGenderDifferences: false,
      genus: 'Fox Pokémon',
      flavorText:
        'In its belly burns a fire, which Vulpix spits out in the form of fireballs. ' +
        'When young, this Pokémon has but one white tail. ' +
        'As the Pokémon matures, this single tail splits into six.',
      flavorTextVersion: 'legends-arceus',
      varieties: [
        { pokemonId: 37, slug: 'vulpix', isDefault: true },
        { pokemonId: 10103, slug: 'vulpix-alola', isDefault: false },
      ],
    });
  });
});

describe('trimSpecies — edge cases', () => {
  const rawSpecies = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 151,
    name: 'mew',
    ...overrides,
  });
  const en = { name: 'en' };

  it('fills gaps with safe defaults', () => {
    expect(trimSpecies(rawSpecies())).toEqual({
      id: 151,
      slug: 'mew',
      name: 'Mew',
      generation: 1, // from the bundled index
      captureRate: null,
      genderRate: -1,
      baseHappiness: null,
      growthRate: null,
      eggGroups: [],
      hatchCounter: null,
      isLegendary: false,
      isMythical: false,
      isBaby: false,
      hasGenderDifferences: false,
      genus: null,
      flavorText: null,
      flavorTextVersion: null,
      varieties: [],
    });
  });

  it('cleans up game text-box formatting in the Pokédex entry', () => {
    const detail = trimSpecies(
      rawSpecies({
        flavor_text_entries: [
          { flavor_text: 'Old entry.', language: en, version: { name: 'red' } },
          {
            flavor_text: 'So rare that it\nis still said to\nbe a mirage by\fmany ex\u00ad\nperts.',
            language: en,
            version: { name: 'yellow' },
          },
          { flavor_text: 'Nur auf Deutsch.', language: { name: 'de' }, version: { name: 'sword' } },
        ],
      }),
    );
    expect(detail.flavorText).toBe('So rare that it is still said to be a mirage by many experts.');
    expect(detail.flavorTextVersion).toBe('yellow');
  });

  it('has no flavor text or genus without English entries', () => {
    const detail = trimSpecies(
      rawSpecies({
        flavor_text_entries: [
          { flavor_text: 'En français.', language: { name: 'fr' }, version: { name: 'x' } },
        ],
        genera: [{ genus: 'Pokémon Nouveau', language: { name: 'fr' } }],
      }),
    );
    expect(detail.flavorText).toBeNull();
    expect(detail.genus).toBeNull();
  });

  it('reads the generation from the url or the roman numeral', () => {
    const generationOf = (generation: unknown) =>
      trimSpecies(rawSpecies({ id: 99999, name: 'futuremon', generation })).generation;
    expect(
      generationOf({ name: 'generation-ix', url: 'https://pokeapi.co/api/v2/generation/9/' }),
    ).toBe(9);
    expect(generationOf({ name: 'generation-iv' })).toBe(4);
    expect(generationOf({ name: 'generation-viii' })).toBe(8);
    expect(generationOf({ name: 'generation-x' })).toBe(10);
    expect(generationOf({ name: 'something-else' })).toBe(0);
    expect(generationOf(undefined)).toBe(0);
  });

  it('uses the payload name for species the bundled index does not know', () => {
    const detail = trimSpecies(
      rawSpecies({
        id: 99999,
        name: 'future-mon',
        names: [
          { name: 'フューチャー', language: { name: 'ja' } },
          { name: 'Futuremon', language: en },
        ],
      }),
    );
    expect(detail.name).toBe('Futuremon');
    expect(trimSpecies(rawSpecies({ id: 99999, name: 'future-mon' })).name).toBe('Future Mon');
  });

  it('resolves variety ids from urls or the bundled index and skips the rest', () => {
    const detail = trimSpecies(
      rawSpecies({
        id: 37,
        name: 'vulpix',
        varieties: [
          { is_default: true, pokemon: { name: 'vulpix' } },
          { is_default: false, pokemon: { name: 'vulpix-alola' } },
          { pokemon: { name: 'vulpix-mystery' } },
          { pokemon: { name: 'vulpix-other', url: 'https://pokeapi.co/api/v2/pokemon/10999/' } },
        ],
      }),
    );
    expect(detail.varieties).toEqual([
      { pokemonId: 37, slug: 'vulpix', isDefault: true },
      { pokemonId: 10103, slug: 'vulpix-alola', isDefault: false },
      { pokemonId: 10999, slug: 'vulpix-other', isDefault: false },
    ]);
  });

  it('throws invalid-response for payloads that are not a species', () => {
    expect(() => trimSpecies({ name: 'mew' })).toThrow(PokeApiError);
    expect(() => trimSpecies(null)).toThrow(/Unexpected PokeAPI response/);
  });
});

// ───────────────────────────── transport ─────────────────────────────

describe('PokeAPI client — requests', () => {
  it('fetches and trims a Pokémon by id', async () => {
    const fetchMock = queuedFetch(() => jsonResponse(vulpixFixture));
    const detail = await clientWith(fetchMock).fetchPokemon(10103);
    expect(detail.name).toBe('Alolan Vulpix');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${POKEAPI_BASE_URL}/pokemon/10103`);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('fetches and trims a species', async () => {
    const fetchMock = queuedFetch(() => jsonResponse(speciesFixture));
    const detail = await clientWith(fetchMock).fetchSpecies(37);
    expect(detail.captureRate).toBe(190);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${POKEAPI_BASE_URL}/pokemon-species/37`);
  });

  it('normalises slugs and the base url', async () => {
    const fetchMock = queuedFetch(() => jsonResponse(vulpixFixture));
    const client = clientWith(fetchMock, { baseUrl: 'https://mirror.test/api/v2//' });
    await client.fetchPokemon('  Vulpix-Alola ');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://mirror.test/api/v2/pokemon/vulpix-alola');
  });

  it('rejects identifiers that cannot name a resource without touching the network', async () => {
    const fetchMock = queuedFetch(() => jsonResponse(vulpixFixture));
    const client = clientWith(fetchMock);
    for (const bad of [
      '',
      '   ',
      '../ability/1',
      'pika chu',
      'pikachu?x=1',
      'a/b',
      0,
      -3,
      2.5,
      Number.NaN,
    ]) {
      const error = await apiRejection(client.fetchPokemon(bad));
      expect(error.kind, String(bad)).toBe('not-found');
    }
    expect((await apiRejection(client.fetchSpecies('%2e%2e'))).kind).toBe('not-found');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a malformed success body as invalid-response without retrying', async () => {
    const notJson = queuedFetch(() => new Response('<html>gateway</html>', { status: 200 }));
    const error = await apiRejection(clientWith(notJson).fetchPokemon(1));
    expect(error.kind).toBe('invalid-response');
    expect(error.status).toBe(200);
    expect(notJson).toHaveBeenCalledTimes(1);

    const wrongShape = queuedFetch(() => jsonResponse({ detail: 'maintenance' }));
    expect((await apiRejection(clientWith(wrongShape).fetchPokemon(1))).kind).toBe(
      'invalid-response',
    );
    expect(wrongShape).toHaveBeenCalledTimes(1);
  });

  it('exposes module-level fetchers bound to the global fetch', async () => {
    const fetchMock = vi.fn<typeof fetch>((input) =>
      Promise.resolve(
        jsonResponse(String(input).includes('pokemon-species') ? speciesFixture : vulpixFixture),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect((await fetchPokemon('vulpix-alola')).id).toBe(10103);
    expect((await fetchSpecies(37)).slug).toBe('vulpix');
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://pokeapi.co/api/v2/pokemon/vulpix-alola',
      'https://pokeapi.co/api/v2/pokemon-species/37',
    ]);
  });
});

describe('PokeAPI client — 404', () => {
  it('fails as not-found immediately, without retrying', async () => {
    const fetchMock = queuedFetch(() => jsonResponse({ status: 404, message: 'Not Found' }, 404));
    const error = await apiRejection(clientWith(fetchMock).fetchPokemon(99999));
    expect(error).toBeInstanceOf(PokeApiError);
    expect(error.kind).toBe('not-found');
    expect(error.status).toBe(404);
    expect(error.retryable).toBe(false);
    expect(error.url).toBe(`${POKEAPI_BASE_URL}/pokemon/99999`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry other client errors either', async () => {
    const fetchMock = queuedFetch(() => jsonResponse({}, 400));
    const error = await apiRejection(clientWith(fetchMock).fetchPokemon(1));
    expect(error.kind).toBe('http');
    expect(error.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('PokeAPI client — retries', () => {
  it('retries a 5xx and succeeds', async () => {
    const fetchMock = queuedFetch(
      () => jsonResponse({}, 503),
      () => jsonResponse(vulpixFixture),
    );
    const detail = await clientWith(fetchMock).fetchPokemon(10103);
    expect(detail.id).toBe(10103);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up as `server` after the configured number of retries', async () => {
    const fetchMock = queuedFetch(() => jsonResponse({}, 500));
    const error = await apiRejection(clientWith(fetchMock).fetchPokemon(1));
    expect(error.kind).toBe('server');
    expect(error.status).toBe(500);
    expect(error.retryable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(DEFAULT_RETRIES + 1);
  });

  it('honours `retries`', async () => {
    const none = queuedFetch(() => jsonResponse({}, 502));
    await rejection(clientWith(none, { retries: 0 }).fetchPokemon(1));
    expect(none).toHaveBeenCalledTimes(1);

    const five = queuedFetch(() => jsonResponse({}, 502));
    await rejection(clientWith(five, { retries: 5 }).fetchPokemon(1));
    expect(five).toHaveBeenCalledTimes(6);
  });

  it('retries network failures and reports them as offline', async () => {
    const down = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('Failed to fetch')));
    const error = await apiRejection(clientWith(down).fetchPokemon(1));
    expect(error.kind).toBe('offline');
    expect(error.status).toBeNull();
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(down).toHaveBeenCalledTimes(DEFAULT_RETRIES + 1);

    const flaky = queuedFetch(
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => jsonResponse(speciesFixture),
    );
    expect((await clientWith(flaky).fetchSpecies(37)).id).toBe(37);
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('retries when the connection drops while the body is still arriving', async () => {
    // `response.json()` rejects with a TypeError (not a SyntaxError) when the stream breaks.
    const brokenBody = (): Response => {
      const response = jsonResponse({});
      vi.spyOn(response, 'json').mockRejectedValue(new TypeError('network error'));
      return response;
    };
    const flaky = queuedFetch(brokenBody, () => jsonResponse(vulpixFixture));
    expect((await clientWith(flaky).fetchPokemon(10103)).id).toBe(10103);
    expect(flaky).toHaveBeenCalledTimes(2);

    const dead = queuedFetch(brokenBody);
    const error = await apiRejection(clientWith(dead).fetchPokemon(1));
    expect(error.kind).toBe('offline');
    expect(error.retryable).toBe(true);
    expect(error.status).toBe(200);
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(dead).toHaveBeenCalledTimes(DEFAULT_RETRIES + 1);
  });

  it('retries a 429', async () => {
    const fetchMock = queuedFetch(
      () => jsonResponse({}, 429),
      () => jsonResponse({}, 429),
      () => jsonResponse(vulpixFixture),
    );
    expect((await clientWith(fetchMock).fetchPokemon(10103)).id).toBe(10103);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const always = queuedFetch(() => jsonResponse({}, 429, { 'retry-after': '0' }));
    const error = await apiRejection(clientWith(always).fetchPokemon(1));
    expect(error.kind).toBe('rate-limited');
    expect(error.retryAfterMs).toBe(0);
  });

  it('backs off exponentially between attempts', async () => {
    vi.useFakeTimers();
    const fetchMock = queuedFetch(() => jsonResponse({}, 500));
    const pending = rejection(clientWith(fetchMock, { backoffMs: 100 }).fetchPokemon(1));

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // 100 ms after the first failure
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); // 200 ms after the second
    expect(fetchMock).toHaveBeenCalledTimes(3);

    expect(isPokeApiError(await pending)).toBe(true);
  });

  it('waits for Retry-After, capped by maxBackoffMs', async () => {
    vi.useFakeTimers();
    const fetchMock = queuedFetch(
      () => jsonResponse({}, 429, { 'retry-after': '2' }),
      () => jsonResponse({}, 429, { 'retry-after': '3600' }),
      () => jsonResponse(vulpixFixture),
    );
    const pending = clientWith(fetchMock, { backoffMs: 100, maxBackoffMs: 5_000 }).fetchPokemon(1);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((await pending).id).toBe(10103);
  });

  it('fails fast as offline when the device reports no connection', async () => {
    const fetchMock = queuedFetch(() => jsonResponse(vulpixFixture));
    const error = await apiRejection(
      clientWith(fetchMock, { isOnline: () => false }).fetchPokemon(1),
    );
    expect(error.kind).toBe('offline');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('PokeAPI client — timeout', () => {
  it('aborts an attempt that takes too long and reports a timeout', async () => {
    vi.useFakeTimers();
    const fetchMock = hangingFetch();
    const pending = apiRejection(
      clientWith(fetchMock, { timeoutMs: 12_000, retries: 0 }).fetchPokemon(1),
    );

    await vi.advanceTimersByTimeAsync(11_999);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);

    const error = await pending;
    expect(error.kind).toBe('timeout');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('12000');
  });

  it('retries after a timeout and can still succeed', async () => {
    vi.useFakeTimers();
    const hang = hangingFetch();
    let calls = 0;
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      calls += 1;
      return calls === 1 ? hang(input, init) : Promise.resolve(jsonResponse(vulpixFixture));
    });
    const pending = clientWith(fetchMock, { timeoutMs: 1_000, backoffMs: 50 }).fetchPokemon(10103);
    await vi.advanceTimersByTimeAsync(1_000); // first attempt times out
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50); // backoff, then the second attempt answers
    expect((await pending).id).toBe(10103);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('also covers a body that stalls after the headers arrived', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>((_input, init) => {
      const response = jsonResponse({});
      vi.spyOn(response, 'json').mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      );
      return Promise.resolve(response);
    });
    const pending = apiRejection(
      clientWith(fetchMock, { timeoutMs: 500, retries: 0 }).fetchPokemon(1),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect((await pending).kind).toBe('timeout');
  });
});

describe('PokeAPI client — caller abort', () => {
  it('does not start a request for an already aborted signal', async () => {
    const fetchMock = queuedFetch(() => jsonResponse(vulpixFixture));
    const controller = new AbortController();
    controller.abort();
    const error = await rejection(
      clientWith(fetchMock).fetchPokemon(1, { signal: controller.signal }),
    );
    expect(isPokeApiError(error)).toBe(false);
    expect((error as Error).name).toBe('AbortError');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects with the abort reason mid-flight and does not retry', async () => {
    const fetchMock = hangingFetch();
    const controller = new AbortController();
    const pending = rejection(clientWith(fetchMock).fetchPokemon(1, { signal: controller.signal }));
    await Promise.resolve();
    controller.abort();
    const error = await pending;
    expect(isPokeApiError(error)).toBe(false);
    expect((error as Error).name).toBe('AbortError');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('stops waiting when aborted during a backoff', async () => {
    vi.useFakeTimers();
    const fetchMock = queuedFetch(() => jsonResponse({}, 500));
    const controller = new AbortController();
    const pending = rejection(
      clientWith(fetchMock, { backoffMs: 60_000, maxBackoffMs: 60_000 }).fetchPokemon(1, {
        signal: controller.signal,
      }),
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    controller.abort(new Error('navigated away'));
    const error = await pending;
    expect((error as Error).message).toBe('navigated away');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('PokeApiError', () => {
  it('is a real Error with a kind', () => {
    const cause = new TypeError('boom');
    const error = new PokeApiError('server', 'bad gateway', { url: 'u', status: 502, cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('PokeApiError');
    expect(error.message).toBe('bad gateway');
    expect(error.cause).toBe(cause);
    expect(error.retryAfterMs).toBeNull();
    expect(isPokeApiError(error)).toBe(true);
    expect(isPokeApiError(new Error('x'))).toBe(false);
    expect(isPokeApiError(null)).toBe(false);
  });

  it('marks only transient kinds as retryable', () => {
    const retryable: Record<PokeApiErrorKind, boolean> = {
      offline: true,
      timeout: true,
      'rate-limited': true,
      server: true,
      'not-found': false,
      http: false,
      'invalid-response': false,
    };
    for (const [kind, expected] of Object.entries(retryable)) {
      const error = new PokeApiError(kind as PokeApiErrorKind, 'x', { url: 'u' });
      expect(error.retryable, kind).toBe(expected);
    }
  });

  it('has a user-facing description for every kind', () => {
    const kinds: PokeApiErrorKind[] = [
      'offline',
      'timeout',
      'not-found',
      'rate-limited',
      'server',
      'http',
      'invalid-response',
    ];
    const lines = kinds.map((kind) =>
      describePokeApiError(new PokeApiError(kind, 'x', { url: 'u' })),
    );
    expect(lines.every((line) => line.length > 10)).toBe(true);
    expect(new Set(lines).size).toBe(kinds.length - 1); // http and invalid-response share a line
    expect(describePokeApiError(new Error('x'))).toMatch(/went wrong/);
  });
});
