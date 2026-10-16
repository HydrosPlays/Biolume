import { describe, expect, it } from 'vitest';
import {
  ALL_SPECIES,
  DEFAULT_SEARCH_LIMIT,
  GENERATIONS,
  POKEMON_TYPES,
  displayName,
  findByPokemonId,
  findBySlug,
  getForm,
  getSpecies,
  normalizeSearchText,
  searchSpecies,
  toTargetRef,
  type SpeciesSearchResult,
} from './species';
import { SPRITE_BASE_URL } from './sprites';

const names = (results: SpeciesSearchResult[]): string[] => results.map((result) => result.name);
const first = (query: string): SpeciesSearchResult | undefined => searchSpecies(query)[0];

function requireSpecies(id: number) {
  const species = getSpecies(id);
  if (!species) throw new Error(`species ${id} missing from the index`);
  return species;
}

describe('bundled species index', () => {
  it('holds every species of generations 1-9 in National Dex order', () => {
    expect(ALL_SPECIES).toHaveLength(1025);
    expect(ALL_SPECIES.map((species) => species.id)).toEqual(
      Array.from({ length: 1025 }, (_, index) => index + 1),
    );
    expect(GENERATIONS).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const perGeneration = new Map<number, number>();
    for (const species of ALL_SPECIES) {
      perGeneration.set(species.gen, (perGeneration.get(species.gen) ?? 0) + 1);
    }
    expect([...perGeneration.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [1, 151],
      [2, 100],
      [3, 135],
      [4, 107],
      [5, 156],
      [6, 72],
      [7, 88],
      [8, 96],
      [9, 120],
    ]);
  });

  it('uses proper English display names', () => {
    expect(requireSpecies(122).name).toBe('Mr. Mime');
    expect(requireSpecies(83).name).toBe("Farfetch'd");
    expect(requireSpecies(669).name).toBe('Flabébé');
    expect(requireSpecies(772).name).toBe('Type: Null');
    expect(requireSpecies(29).name).toBe('Nidoran♀');
    expect(requireSpecies(32).name).toBe('Nidoran♂');
    expect(requireSpecies(250).name).toBe('Ho-Oh');
    expect(getForm(10103)?.name).toBe('Alolan Vulpix');
    expect(getForm(10166)?.name).toBe("Galarian Farfetch'd");
    expect(getForm(10177)?.name).toBe('Galarian Darmanitan');
  });

  it.each([
    [439, 'mime-jr', 'Mime Jr.'],
    [233, 'porygon2', 'Porygon2'],
    [474, 'porygon-z', 'Porygon-Z'],
    [782, 'jangmo-o', 'Jangmo-o'],
    [784, 'kommo-o', 'Kommo-o'],
    [785, 'tapu-koko', 'Tapu Koko'],
    [865, 'sirfetchd', "Sirfetch'd"],
    [866, 'mr-rime', 'Mr. Rime'],
    [984, 'great-tusk', 'Great Tusk'],
    [1001, 'wo-chien', 'Wo-Chien'],
    [1004, 'chi-yu', 'Chi-Yu'],
    [1025, 'pecharunt', 'Pecharunt'],
  ])('#%i %s is named %s', (id, slug, name) => {
    const species = requireSpecies(id);
    expect(species.slug).toBe(slug);
    expect(species.name).toBe(name);
  });

  // Checked against the live `/pokemon/{id}` responses.
  it.each([
    [10091, 'rattata-alola', 'Alolan Rattata', ['dark', 'normal']],
    [10100, 'raichu-alola', 'Alolan Raichu', ['electric', 'psychic']],
    [10161, 'meowth-galar', 'Galarian Meowth', ['steel']],
    [10168, 'mr-mime-galar', 'Galarian Mr. Mime', ['ice', 'psychic']],
    [10229, 'growlithe-hisui', 'Hisuian Growlithe', ['fire', 'rock']],
    [10231, 'voltorb-hisui', 'Hisuian Voltorb', ['electric', 'grass']],
    [10251, 'tauros-paldea-blaze-breed', 'Paldean Tauros (Blaze Breed)', ['fighting', 'fire']],
    [10253, 'wooper-paldea', 'Paldean Wooper', ['poison', 'ground']],
    [10181, 'zygarde-10', 'Zygarde (10% Forme)', ['dragon', 'ground']],
    [10272, 'ursaluna-bloodmoon', 'Bloodmoon Ursaluna', ['ground', 'normal']],
  ])('form %i %s is %s with its own typing', (pokemonId, slug, name, types) => {
    expect(getForm(pokemonId)).toMatchObject({ slug, name, types });
  });

  it('has every regional form of the four regions', () => {
    const count = (suffix: RegExp): number =>
      ALL_SPECIES.flatMap((species) => species.forms).filter((form) => suffix.test(form.slug))
        .length;
    expect(count(/-alola$/)).toBe(18);
    expect(count(/-galar(-standard)?$/)).toBe(19);
    expect(count(/-hisui$/)).toBe(16);
    expect(count(/-paldea(-|$)/)).toBe(4);
  });

  it('gives every entry valid types, unique ids and unique slugs', () => {
    const pokemonIds = new Set<number>();
    const slugs = new Set<string>();
    for (const species of ALL_SPECIES) {
      for (const entry of [
        { id: species.id, slug: species.pokemonSlug, types: species.types, name: species.name },
        ...species.forms.map((form) => ({
          id: form.pokemonId,
          slug: form.slug,
          types: form.types,
          name: form.name,
        })),
      ]) {
        expect(entry.name).not.toBe('');
        expect(entry.types.length).toBeGreaterThanOrEqual(1);
        expect(entry.types.length).toBeLessThanOrEqual(2);
        for (const type of entry.types) expect(POKEMON_TYPES).toContain(type);
        expect(pokemonIds.has(entry.id)).toBe(false);
        expect(slugs.has(entry.slug)).toBe(false);
        pokemonIds.add(entry.id);
        slugs.add(entry.slug);
      }
      for (const form of species.forms) {
        expect(form.pokemonId).toBeGreaterThan(10000);
        expect(form.speciesId).toBe(species.id);
        expect(form.label).not.toBe('');
      }
    }
  });

  it('lists regional forms and other huntable varieties', () => {
    const formSlugs = (id: number): string[] => requireSpecies(id).forms.map((form) => form.slug);
    expect(formSlugs(37)).toEqual(['vulpix-alola']);
    expect(formSlugs(52)).toEqual(['meowth-alola', 'meowth-galar']);
    expect(formSlugs(58)).toEqual(['growlithe-hisui']);
    expect(formSlugs(194)).toEqual(['wooper-paldea']);
    expect(formSlugs(128)).toEqual([
      'tauros-paldea-combat-breed',
      'tauros-paldea-blaze-breed',
      'tauros-paldea-aqua-breed',
    ]);
    expect(formSlugs(550)).toEqual(['basculin-blue-striped', 'basculin-white-striped']);
    expect(formSlugs(741)).toEqual(['oricorio-pom-pom', 'oricorio-pau', 'oricorio-sensu']);
    expect(getForm(10103)?.types).toEqual(['ice']);
    expect(requireSpecies(37).types).toEqual(['fire']);
  });

  it('leaves out battle-only and otherwise non-huntable varieties', () => {
    const allFormSlugs = ALL_SPECIES.flatMap((species) => species.forms.map((form) => form.slug));
    const banned =
      /-mega(-[xyz])?$|-gmax$|-totem|-primal$|-eternamax$|-cap$|-starter$|-cosplay$|-busted$|-zen$/;
    expect(allFormSlugs.filter((slug) => banned.test(slug))).toEqual([]);
    // Species famous for such forms keep only their huntable ones.
    expect(requireSpecies(25).forms).toEqual([]);
    expect(requireSpecies(6).forms).toEqual([]);
    expect(requireSpecies(382).forms).toEqual([]);
    expect(requireSpecies(890).forms).toEqual([]);
    expect(requireSpecies(555).forms.map((form) => form.slug)).toEqual([
      'darmanitan-galar-standard',
    ]);
    expect(requireSpecies(105).forms.map((form) => form.slug)).toEqual(['marowak-alola']);
  });

  it('records the default variety slug and its form label where they matter', () => {
    const deoxys = requireSpecies(386);
    expect(deoxys.slug).toBe('deoxys');
    expect(deoxys.pokemonSlug).toBe('deoxys-normal');
    expect(deoxys.baseLabel).toBe('Normal Forme');
    expect(deoxys.forms.map((form) => form.label)).toEqual([
      'Attack Forme',
      'Defense Forme',
      'Speed Forme',
    ]);
    const pikachu = requireSpecies(25);
    expect(pikachu.pokemonSlug).toBe('pikachu');
    expect(pikachu.baseLabel).toBeNull();
  });
});

describe('lookups', () => {
  it('getSpecies / getForm', () => {
    expect(getSpecies(25)?.slug).toBe('pikachu');
    expect(getSpecies(0)).toBeNull();
    expect(getSpecies(1026)).toBeNull();
    expect(getSpecies(10103)).toBeNull();
    expect(getForm(10103)?.slug).toBe('vulpix-alola');
    expect(getForm(37)).toBeNull();
    expect(getForm(99999)).toBeNull();
  });

  it('findByPokemonId resolves base varieties and forms', () => {
    expect(findByPokemonId(37)).toEqual({ species: getSpecies(37), form: null });
    const alolan = findByPokemonId(10103);
    expect(alolan?.species.id).toBe(37);
    expect(alolan?.form?.slug).toBe('vulpix-alola');
    expect(findByPokemonId(10033)).toBeNull(); // Mega Venusaur is not huntable
  });

  it('findBySlug accepts species, default-variety and form slugs', () => {
    expect(findBySlug('deoxys')?.species.id).toBe(386);
    expect(findBySlug('deoxys-normal')).toEqual(findBySlug('deoxys'));
    expect(findBySlug(' Vulpix-Alola ')?.form?.pokemonId).toBe(10103);
    expect(findBySlug('missingno')).toBeNull();
  });

  it('displayName covers both kinds of id', () => {
    expect(displayName(122)).toBe('Mr. Mime');
    expect(displayName(10168)).toBe('Galarian Mr. Mime');
    expect(displayName(424242)).toBeNull();
  });
});

describe('toTargetRef', () => {
  it('snapshots a base species', () => {
    expect(toTargetRef(requireSpecies(386))).toEqual({
      speciesId: 386,
      pokemonId: 386,
      slug: 'deoxys-normal',
      name: 'Deoxys',
      types: ['psychic'],
      spriteUrl: `${SPRITE_BASE_URL}/386.png`,
      shinySpriteUrl: `${SPRITE_BASE_URL}/shiny/386.png`,
    });
  });

  it('snapshots an alternate form with its own id, slug, name, types and sprites', () => {
    const vulpix = requireSpecies(37);
    expect(toTargetRef(vulpix, vulpix.forms[0])).toEqual({
      speciesId: 37,
      pokemonId: 10103,
      slug: 'vulpix-alola',
      name: 'Alolan Vulpix',
      types: ['ice'],
      spriteUrl: `${SPRITE_BASE_URL}/10103.png`,
      shinySpriteUrl: `${SPRITE_BASE_URL}/shiny/10103.png`,
    });
    expect(toTargetRef(vulpix, null).pokemonId).toBe(37);
  });

  it('copies the types so callers cannot mutate the index', () => {
    const species = requireSpecies(1);
    const target = toTargetRef(species);
    target.types.push('fairy');
    expect(species.types).toEqual(['grass', 'poison']);
  });

  it('rejects a form that belongs to another species', () => {
    const alolanVulpix = getForm(10103);
    expect(() => toTargetRef(requireSpecies(25), alolanVulpix)).toThrow(/does not belong/);
  });
});

describe('normalizeSearchText', () => {
  it('strips case, diacritics and joining punctuation', () => {
    expect(normalizeSearchText('Flabébé')).toBe('flabebe');
    expect(normalizeSearchText("Farfetch'd")).toBe('farfetchd');
    expect(normalizeSearchText('Farfetch’d')).toBe('farfetchd');
    expect(normalizeSearchText('Mr. Mime')).toBe('mr mime');
    expect(normalizeSearchText('Type: Null')).toBe('type null');
    expect(normalizeSearchText('Ho-Oh')).toBe('ho oh');
    expect(normalizeSearchText('Nidoran♀')).toBe('nidoran f');
    expect(normalizeSearchText('  Tapu   Koko ')).toBe('tapu koko');
    expect(normalizeSearchText('!?')).toBe('');
  });
});

describe('searchSpecies ranking', () => {
  it('puts an exact name above longer names that merely start with it', () => {
    const results = searchSpecies('mew');
    expect(names(results).slice(0, 2)).toEqual(['Mew', 'Mewtwo']);
    expect(results[0]?.match).toBe('exact');
    expect(results[1]?.match).toBe('prefix');
  });

  it('orders prefix matches by National Dex number, then substring matches', () => {
    const results = searchSpecies('char');
    expect(names(results)).toEqual([
      'Charmander',
      'Charmeleon',
      'Charizard',
      'Charjabug',
      'Charcadet',
      'Chimchar',
      'Pecharunt',
    ]);
    expect(results.map((result) => result.match)).toEqual([
      'prefix',
      'prefix',
      'prefix',
      'prefix',
      'prefix',
      'substring',
      'substring',
    ]);
  });

  it('ranks prefix above word-start', () => {
    const results = searchSpecies('mime');
    expect(names(results)).toEqual(['Mime Jr.', 'Mr. Mime', 'Galarian Mr. Mime']);
    expect(results.map((result) => result.match)).toEqual(['prefix', 'word', 'word']);
  });

  it('ranks word-start above substring', () => {
    // "Tapu Koko" starts a word with "ko"; "Drakloak" only contains it.
    const results = searchSpecies('koko');
    expect(names(results)).toEqual(['Tapu Koko']);
    const mixed = searchSpecies('bulu', { limit: 50 });
    expect(mixed[0]?.name).toBe('Tapu Bulu');
    expect(mixed[0]?.match).toBe('word');
  });

  it('ranks prefix above substring regardless of dex order', () => {
    const results = searchSpecies('ee', { limit: 50 });
    const kinds = results.map((result) => result.match);
    expect(names(results).slice(0, 3)).toEqual(['Eevee', 'Eelektrik', 'Eelektross']);
    expect(kinds.slice(0, 3)).toEqual(['prefix', 'prefix', 'prefix']);
    // Weedle (#13) comes before Eevee (#133) in the dex but only contains "ee".
    const weedle = results.findIndex((result) => result.name === 'Weedle');
    expect(weedle).toBeGreaterThan(2);
    expect(kinds[weedle]).toBe('substring');
    // Tiers never interleave.
    const rank = { dex: 0, exact: 1, prefix: 2, word: 3, substring: 4, fuzzy: 5, all: 6 } as const;
    const ranks = kinds.map((kind) => rank[kind]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('finds substrings', () => {
    const results = searchSpecies('saur');
    expect(names(results)).toEqual(['Bulbasaur', 'Ivysaur', 'Venusaur']);
    expect(results.every((result) => result.match === 'substring')).toBe(true);
  });

  it('does not match substrings across word boundaries', () => {
    // "mr-mime-galar" would contain "mega" if words were glued together.
    expect(names(searchSpecies('mega', { limit: 50 }))).toEqual(['Meganium', 'Yanmega']);
  });

  it('lists species before forms that only match through their own wording', () => {
    const results = searchSpecies('a', { limit: 400 });
    expect(names(results).slice(0, 3)).toEqual(['Arbok', 'Arcanine', 'Hisuian Arcanine']);
    const lastSpeciesPrefix = results.findLastIndex(
      (result) => result.match === 'prefix' && result.form === null,
    );
    const firstAlolan = results.findIndex((result) => result.name.startsWith('Alolan '));
    expect(firstAlolan).toBeGreaterThan(lastSpeciesPrefix);
    expect(results[firstAlolan]?.match).toBe('prefix');
    // …while a region name on its own still lists that region's forms.
    expect(names(searchSpecies('alolan', { limit: 3 }))).toEqual([
      'Alolan Rattata',
      'Alolan Raticate',
      'Alolan Raichu',
    ]);
  });

  it('tolerates small typos when nothing matches outright', () => {
    for (const [typo, expected] of [
      ['pikachi', 'Pikachu'],
      ['charzard', 'Charizard'],
      ['bulbsaur', 'Bulbasaur'],
      ['gengr', 'Gengar'],
      ['rayquaza', 'Rayquaza'],
      ['raquaza', 'Rayquaza'],
      ['mewto', 'Mewtwo'],
      ['pikahcu', 'Pikachu'],
      ['hoho', 'Ho-Oh'],
    ] as const) {
      expect(first(typo)?.name, typo).toBe(expected);
    }
    expect(first('pikachi')?.match).toBe('fuzzy');
    expect(first('rayquaza')?.match).toBe('exact');
  });

  it('tolerates a typo while the name is still being typed', () => {
    expect(first('bulbsa')?.name).toBe('Bulbasaur');
    expect(first('chairz')?.name).toBe('Charizard');
  });

  it('does not pad real matches with fuzzy near-misses', () => {
    const results = searchSpecies('pik', { limit: 50 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((result) => result.match === 'fuzzy')).toBe(false);
    expect(names(results)).toContain('Pikachu');
    expect(names(results)).not.toContain('Pidgey');
  });

  it('returns nothing for gibberish', () => {
    expect(searchSpecies('zzzzzzzz')).toEqual([]);
    expect(searchSpecies('qx')).toEqual([]);
    expect(searchSpecies('abc')).toEqual([]); // too short to guess a typo in
    expect(searchSpecies('!!!')).toEqual([]);
  });

  it('does not let a filter turn a correct name into a fuzzy guess', () => {
    // Pikachu is Gen 1; "Pichu" (Gen 2) is two edits away and must not stand in for it.
    expect(searchSpecies('pikachu', { generation: 2 })).toEqual([]);
    expect(names(searchSpecies('pikachi', { generation: 1 }))).toEqual(['Pikachu']);
    expect(searchSpecies('pikachi', { generation: 2 })).toEqual([]);
  });

  it('is case-insensitive and deterministic', () => {
    expect(searchSpecies('PIKACHU')).toEqual(searchSpecies('pikachu'));
    expect(searchSpecies('eevee')).toEqual(searchSpecies('eevee'));
    expect(first('PiKaChU')?.pokemonId).toBe(25);
  });
});

describe('searchSpecies — dex numbers', () => {
  it('finds a species by number, with or without # and padding', () => {
    for (const query of ['25', '#25', '#025', '025', '0025', 'no. 25', 'No 25', ' #25 ']) {
      const result = first(query);
      expect(result?.name, query).toBe('Pikachu');
      expect(result?.match, query).toBe('dex');
    }
    expect(first('#1025')?.name).toBe('Pecharunt');
    expect(first('1')?.name).toBe('Bulbasaur');
  });

  it('follows the exact number with numbers that start with it', () => {
    expect(
      searchSpecies('25', { limit: 4 }).map((result) => [result.pokemonId, result.match]),
    ).toEqual([
      [25, 'dex'],
      [250, 'dex'],
      [251, 'dex'],
      [252, 'dex'],
    ]);
  });

  it('takes a zero-padded number literally', () => {
    expect(names(searchSpecies('#025'))).toEqual(['Pikachu']);
  });

  it('returns nothing for numbers outside the dex', () => {
    expect(searchSpecies('#9999')).toEqual([]);
    expect(searchSpecies('9999')).toEqual([]);
    expect(searchSpecies('#0')).toEqual([]);
  });

  it('still matches digits that are part of a name', () => {
    expect(first('porygon2')?.name).toBe('Porygon2');
    expect(names(searchSpecies('10', { limit: 100 }))).toContain('Zygarde (10% Forme)');
  });
});

describe('searchSpecies — diacritics and punctuation', () => {
  it.each([
    ['flabebe', 'Flabébé'],
    ['Flabébé', 'Flabébé'],
    ['mr mime', 'Mr. Mime'],
    ['mr. mime', 'Mr. Mime'],
    ['mrmime', 'Mr. Mime'],
    ['mr-mime', 'Mr. Mime'],
    ['farfetchd', "Farfetch'd"],
    ["farfetch'd", "Farfetch'd"],
    ['farfetch’d', "Farfetch'd"],
    ['sirfetchd', "Sirfetch'd"],
    ['type null', 'Type: Null'],
    ['type: null', 'Type: Null'],
    ['typenull', 'Type: Null'],
    ['nidoran f', 'Nidoran♀'],
    ['nidoran♀', 'Nidoran♀'],
    ['nidoran female', 'Nidoran♀'],
    ['nidoran-m', 'Nidoran♂'],
    ['nidoran male', 'Nidoran♂'],
    ['ho-oh', 'Ho-Oh'],
    ['ho oh', 'Ho-Oh'],
    ['hooh', 'Ho-Oh'],
    ['porygon z', 'Porygon-Z'],
    ['porygonz', 'Porygon-Z'],
    ['jangmo o', 'Jangmo-o'],
    ['mime jr', 'Mime Jr.'],
    ['tapu koko', 'Tapu Koko'],
    ['wo chien', 'Wo-Chien'],
    ['great tusk', 'Great Tusk'],
  ])('%s → %s', (query, expected) => {
    const result = first(query);
    expect(result?.name).toBe(expected);
    expect(result?.match).toBe('exact');
  });

  it('lists both Nidoran for the bare name', () => {
    expect(names(searchSpecies('nidoran')).slice(0, 2)).toEqual(['Nidoran♀', 'Nidoran♂']);
  });

  it('folds full-width input from an IME', () => {
    expect(normalizeSearchText('ｐｉｋａｃｈｕ')).toBe('pikachu');
    expect(first('ｐｉｋａｃｈｕ')?.name).toBe('Pikachu');
    expect(first('Ｐｏｒｙｇｏｎ２')?.name).toBe('Porygon2');
    expect(names(searchSpecies('＃０２５'))).toEqual(['Pikachu']);
    expect(first('２５')?.match).toBe('dex');
    expect(searchSpecies('　')).toEqual(searchSpecies('')); // ideographic space only: browse mode
  });
});

describe('searchSpecies — every entry is reachable', () => {
  const entries = ALL_SPECIES.flatMap((species) => [
    { pokemonId: species.id, name: species.name, slugs: [species.slug, species.pokemonSlug] },
    ...species.forms.map((form) => ({
      pokemonId: form.pokemonId,
      name: form.name,
      slugs: [form.slug],
    })),
  ]);

  it('finds each species and form first, as an exact match, by its name and by its slugs', () => {
    const misses: string[] = [];
    for (const entry of entries) {
      for (const query of [entry.name, entry.name.toUpperCase(), ...entry.slugs]) {
        const [top] = searchSpecies(query, { limit: 1 });
        if (top?.pokemonId !== entry.pokemonId || top.match !== 'exact') misses.push(query);
      }
    }
    expect(misses).toEqual([]);
  });

  it('recovers a dropped letter, and never mixes guesses with real matches', () => {
    // Drop one letter from the middle of every plain name. Either the misspelling matches other
    // names as typed (then no guess is made at all), or the Pokémon itself is among the guesses.
    let recovered = 0;
    for (const entry of entries) {
      if (entry.name.length < 6 || !/^[A-Za-z]+$/.test(entry.name)) continue;
      const middle = Math.floor(entry.name.length / 2);
      const typo = entry.name.slice(0, middle) + entry.name.slice(middle + 1);
      const results = searchSpecies(typo, { limit: 5 });
      const kinds = new Set(results.map((result) => result.match));
      if (!kinds.has('fuzzy')) {
        expect(results.length, typo).toBeGreaterThan(0);
        continue;
      }
      expect(kinds.size, typo).toBe(1);
      expect(
        results.map((result) => result.pokemonId),
        typo,
      ).toContain(entry.pokemonId);
      recovered += 1;
    }
    expect(recovered).toBeGreaterThan(700);
  });
});

describe('searchSpecies — forms', () => {
  it('finds a form by its display name', () => {
    const result = first('alolan vulpix');
    expect(result?.form?.slug).toBe('vulpix-alola');
    expect(result?.species.id).toBe(37);
    expect(result?.pokemonId).toBe(10103);
    expect(result?.types).toEqual(['ice']);
    expect(result?.match).toBe('exact');
  });

  it('finds a form by its slug wording and in any word order', () => {
    expect(first('vulpix alola')?.form?.slug).toBe('vulpix-alola');
    expect(first('vulpix-alola')?.form?.slug).toBe('vulpix-alola');
    expect(first('alola vulpix')?.form?.slug).toBe('vulpix-alola');
    expect(first('vulpix alolan')?.form?.slug).toBe('vulpix-alola');
    expect(first('galarian mr mime')?.form?.slug).toBe('mr-mime-galar');
    expect(first('tauros blaze')?.form?.slug).toBe('tauros-paldea-blaze-breed');
    expect(first('hisuian zorua')?.form?.slug).toBe('zorua-hisui');
    expect(first('paldean wooper')?.form?.slug).toBe('wooper-paldea');
  });

  it('lists a species first and its forms right after it', () => {
    const results = searchSpecies('vulpix');
    expect(names(results)).toEqual(['Vulpix', 'Alolan Vulpix']);
    expect(results[0]?.form).toBeNull();
    expect(names(searchSpecies('meow'))).toEqual([
      'Meowth',
      'Alolan Meowth',
      'Galarian Meowth',
      'Meowstic',
      'Female Meowstic',
      'Meowscarada',
      'Glameow', // substring match, after every prefix match
    ]);
  });

  it('lists every form of a region for the regional adjective', () => {
    const results = searchSpecies('hisuian', { limit: 100 });
    expect(results).toHaveLength(16);
    expect(results.every((result) => result.form?.slug.endsWith('-hisui'))).toBe(true);
  });

  it('can be restricted to base species', () => {
    expect(names(searchSpecies('vulpix', { includeForms: false }))).toEqual(['Vulpix']);
    expect(searchSpecies('alolan vulpix', { includeForms: false })).toEqual([]);
  });
});

describe('searchSpecies — filters and limits', () => {
  it('lists the dex for an empty query', () => {
    const results = searchSpecies('');
    expect(results).toHaveLength(DEFAULT_SEARCH_LIMIT);
    expect(names(results).slice(0, 4)).toEqual(['Bulbasaur', 'Ivysaur', 'Venusaur', 'Charmander']);
    expect(results.every((result) => result.match === 'all')).toBe(true);
    expect(searchSpecies('   ')).toEqual(results);
  });

  it('filters by generation', () => {
    const paldea = searchSpecies('', { generation: 9, limit: 3 });
    expect(names(paldea)).toEqual(['Sprigatito', 'Floragato', 'Meowscarada']);
    expect(names(searchSpecies('char', { generation: 1 }))).toEqual([
      'Charmander',
      'Charmeleon',
      'Charizard',
    ]);
    expect(searchSpecies('pikachu', { generation: 2 })).toEqual([]);
    // Forms follow their species' generation.
    expect(names(searchSpecies('vulpix', { generation: 1 }))).toEqual(['Vulpix', 'Alolan Vulpix']);
    expect(searchSpecies('alolan vulpix', { generation: 7 })).toEqual([]);
  });

  it('filters by type using each variety’s own typing', () => {
    expect(names(searchSpecies('vulpix', { type: 'ice' }))).toEqual(['Alolan Vulpix']);
    expect(names(searchSpecies('vulpix', { type: 'fire' }))).toEqual(['Vulpix']);
    expect(names(searchSpecies('vulpix', { type: 'ICE ' }))).toEqual(['Alolan Vulpix']);
    const dragons = searchSpecies('', { type: 'dragon', limit: 500 });
    expect(dragons.length).toBeGreaterThan(40);
    expect(dragons.every((result) => result.types.includes('dragon'))).toBe(true);
    expect(searchSpecies('pikachu', { type: 'water' })).toEqual([]);
  });

  it('combines filters', () => {
    const results = searchSpecies('', { generation: 1, type: 'dragon', limit: 50 });
    expect(names(results)).toEqual(['Alolan Exeggutor', 'Dratini', 'Dragonair', 'Dragonite']);
  });

  it('treats null filters as absent', () => {
    expect(searchSpecies('char', { generation: null, type: null })).toEqual(searchSpecies('char'));
  });

  it('honours the limit', () => {
    expect(searchSpecies('a', { limit: 3 })).toHaveLength(3);
    expect(searchSpecies('a')).toHaveLength(DEFAULT_SEARCH_LIMIT);
    expect(searchSpecies('pikachu', { limit: 0 })).toEqual([]);
    expect(searchSpecies('pikachu', { limit: -5 })).toEqual([]);
    expect(searchSpecies('pikachu', { limit: Number.NaN })).toEqual([]);
    expect(searchSpecies('', { limit: Number.POSITIVE_INFINITY }).length).toBeGreaterThan(1100);
  });
});

describe('searchSpecies — performance', () => {
  it('answers a query in well under a millisecond', () => {
    const queries = [
      'p',
      'pi',
      'pik',
      'pika',
      'pikachu',
      'char',
      'alolan vulpix',
      'vulpix alola',
      'mr mime',
      '25',
      '#025',
      'saur',
      'ee',
      'charzard',
      'bulbsaur',
      'zzzzzzzz',
      '',
      'tauros blaze',
      'flabebe',
      'iron',
    ];
    for (const query of queries) searchSpecies(query); // warm-up

    const samples: number[] = [];
    for (let round = 0; round < 25; round += 1) {
      for (const query of queries) {
        const start = performance.now();
        searchSpecies(query);
        samples.push(performance.now() - start);
      }
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)] ?? Number.POSITIVE_INFINITY;
    // The median keeps this robust against scheduler hiccups on a busy machine.
    expect(median).toBeLessThan(1);
  });
});
