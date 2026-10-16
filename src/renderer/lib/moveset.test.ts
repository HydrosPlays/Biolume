import { describe, expect, it } from 'vitest';
import decidueyeFixture from '@renderer/api/__fixtures__/pokemon-decidueye.json';
import { trimPokemon, type LevelUpMove, type PokemonDetail } from '@renderer/api/pokeapi';
import {
  MOVE_COUNT,
  VERSION_GROUPS,
  canonicalVersionGroup,
  getMove,
  getVersionGroup,
  moveName,
  predictWildMoveset,
  resolveVersionGroup,
  versionGroupLabel,
  wildMoveLevelRanges,
} from './moveset';

type Learnset = readonly (readonly [slug: string, level: number])[];

/** Builds the `moves` part of a PokemonDetail from `[slug, level]` lists, already in learn order. */
function detailOf(groups: Record<string, Learnset>): Pick<PokemonDetail, 'moves'> {
  const moves: PokemonDetail['moves'] = {};
  for (const [versionGroup, learnset] of Object.entries(groups)) {
    moves[versionGroup] = {
      levelUp: learnset.map(([slug, level]) => ({ slug, level })),
      other: { machine: [], egg: [], tutor: [] },
    };
  }
  return { moves };
}

const slugs = (moves: readonly LevelUpMove[]): string[] => moves.map((move) => move.slug);

// Electrode's Scarlet / Violet learnset.
const ELECTRODE: Learnset = [
  ['eerie-impulse', 1],
  ['charge', 1],
  ['magnetic-flux', 1],
  ['tackle', 1],
  ['thunder-shock', 1],
  ['spark', 9],
  ['rollout', 11],
  ['screech', 13],
  ['charge-beam', 16],
  ['swift', 20],
  ['electro-ball', 22],
  ['self-destruct', 26],
  ['light-screen', 29],
  ['magnet-rise', 36],
  ['discharge', 41],
  ['explosion', 47],
  ['gyro-ball', 54],
  ['mirror-coat', 58],
];

describe('bundled move index', () => {
  it('decodes a physical move', () => {
    expect(getMove('self-destruct')).toEqual({
      id: 120,
      slug: 'self-destruct',
      name: 'Self-Destruct',
      type: 'normal',
      class: 'physical',
      power: 200,
      accuracy: 100,
      pp: 5,
      priority: 0,
      gen: 1,
    });
  });

  it('restores omitted stats as null and omitted priority as 0', () => {
    const teleport = getMove('teleport');
    expect(teleport?.class).toBe('status');
    expect(teleport?.power).toBeNull();
    expect(teleport?.accuracy).toBeNull();
    expect(teleport?.priority).toBe(-6);
    const swift = getMove('swift');
    expect(swift?.class).toBe('special');
    expect(swift?.accuracy).toBeNull();
    expect(swift?.power).toBe(60);
    expect(getMove('quick-attack')?.priority).toBe(1);
    expect(getMove('pound')?.priority).toBe(0);
  });

  it('keeps punctuation in display names', () => {
    expect(getMove('kings-shield')?.name).toBe("King's Shield");
    expect(getMove('10-000-000-volt-thunderbolt')?.name).toBe('10,000,000 Volt Thunderbolt');
    expect(getMove('u-turn')?.name).toBe('U-turn');
  });

  it('returns null for unknown slugs, including inherited object keys', () => {
    expect(getMove('not-a-move')).toBeNull();
    expect(getMove('')).toBeNull();
    expect(getMove('constructor')).toBeNull();
    expect(getMove('toString')).toBeNull();
    expect(getMove('__proto__')).toBeNull();
  });

  it('covers every generation of moves', () => {
    expect(MOVE_COUNT).toBeGreaterThan(900);
    expect(getMove('pound')?.gen).toBe(1);
    expect(getMove('malignant-chain')?.gen).toBe(9);
  });

  it('moveName falls back to a title-cased slug', () => {
    expect(moveName('double-edge')).toBe('Double-Edge');
    expect(moveName('brand-new-move')).toBe('Brand New Move');
  });
});

describe('version groups', () => {
  it('lists unique slugs with generations in non-decreasing main-series order', () => {
    const all = VERSION_GROUPS.map((group) => group.slug);
    expect(new Set(all).size).toBe(all.length);
    const mainline = VERSION_GROUPS.filter((group) => !group.secondary);
    const generations = mainline.map((group) => group.generation);
    expect(generations).toEqual([...generations].sort((a, b) => a - b));
    expect(mainline[0]?.slug).toBe('red-blue');
  });

  it('labels groups and tolerates unknown ones', () => {
    expect(versionGroupLabel('sword-shield')).toBe('Sword / Shield');
    expect(versionGroupLabel('scarlet-violet')).toBe('Scarlet / Violet');
    expect(versionGroupLabel('legends-arceus')).toBe('Legends: Arceus');
    expect(versionGroupLabel('some-future-game')).toBe('Some Future Game');
    expect(getVersionGroup('some-future-game')).toBeNull();
    expect(getVersionGroup('emerald')?.generation).toBe(3);
  });

  it('treats both spellings of BDSP as the same group', () => {
    expect(canonicalVersionGroup('brilliant-diamond-and-shining-pearl')).toBe(
      'brilliant-diamond-shining-pearl',
    );
    expect(canonicalVersionGroup('platinum')).toBe('platinum');
    // Inherited object keys are not aliases.
    expect(canonicalVersionGroup('constructor')).toBe('constructor');
    expect(canonicalVersionGroup('toString')).toBe('toString');
    expect(versionGroupLabel('constructor')).toBe('Constructor');
    expect(versionGroupLabel('brilliant-diamond-and-shining-pearl')).toBe(
      'Brilliant Diamond / Shining Pearl',
    );
  });
});

describe('resolveVersionGroup', () => {
  const tackle: Learnset = [['tackle', 1]];

  it('uses the first preferred group that has level-up data', () => {
    const detail = detailOf({ 'sword-shield': tackle, 'scarlet-violet': tackle });
    expect(resolveVersionGroup(detail, ['scarlet-violet', 'the-teal-mask'])).toEqual({
      versionGroup: 'scarlet-violet',
      fallback: false,
    });
    expect(resolveVersionGroup(detail, ['sword-shield'])).toEqual({
      versionGroup: 'sword-shield',
      fallback: false,
    });
  });

  it('moves on to a later preferred group (DLC) without flagging a fallback', () => {
    const detail = detailOf({ 'sword-shield': tackle, 'the-indigo-disk': tackle });
    expect(
      resolveVersionGroup(detail, ['scarlet-violet', 'the-teal-mask', 'the-indigo-disk']),
    ).toEqual({ versionGroup: 'the-indigo-disk', fallback: false });
  });

  it('skips a preferred group that only has TM / egg data', () => {
    const detail = detailOf({ 'scarlet-violet': [], 'sword-shield': tackle });
    const machineOnly = detail.moves['scarlet-violet'];
    if (machineOnly) machineOnly.other.machine.push('protect');
    expect(resolveVersionGroup(detail, ['scarlet-violet'])).toEqual({
      versionGroup: 'sword-shield',
      fallback: true,
    });
  });

  it('falls back to the closest release', () => {
    const detail = detailOf({ 'x-y': tackle, 'sun-moon': tackle, 'scarlet-violet': tackle });
    // Sword/Shield sits three releases after Sun/Moon and five before Scarlet/Violet.
    expect(resolveVersionGroup(detail, ['sword-shield', 'the-isle-of-armor'])).toEqual({
      versionGroup: 'sun-moon',
      fallback: true,
    });
    expect(resolveVersionGroup(detail, ['legends-za'])).toEqual({
      versionGroup: 'scarlet-violet',
      fallback: true,
    });
    expect(resolveVersionGroup(detail, ['red-blue'])).toEqual({
      versionGroup: 'x-y',
      fallback: true,
    });
  });

  it('prefers the older game when two are equally close', () => {
    const detail = detailOf({
      'scarlet-violet': tackle,
      'brilliant-diamond-shining-pearl': tackle,
    });
    expect(resolveVersionGroup(detail, ['legends-arceus'])).toEqual({
      versionGroup: 'brilliant-diamond-shining-pearl',
      fallback: true,
    });
  });

  it('uses side games only when no main-series game has data', () => {
    const both = detailOf({ xd: tackle, 'diamond-pearl': tackle });
    expect(resolveVersionGroup(both, ['firered-leafgreen'])).toEqual({
      versionGroup: 'diamond-pearl',
      fallback: true,
    });
    const sideOnly = detailOf({ colosseum: tackle });
    expect(resolveVersionGroup(sideOnly, ['firered-leafgreen'])).toEqual({
      versionGroup: 'colosseum',
      fallback: true,
    });
  });

  it('uses the newest game with data when there is no usable preference', () => {
    const detail = detailOf({ 'x-y': tackle, 'sword-shield': tackle, 'red-blue': tackle });
    expect(resolveVersionGroup(detail, [])).toEqual({
      versionGroup: 'sword-shield',
      fallback: true,
    });
    expect(resolveVersionGroup(detail, ['pokemon-go'])).toEqual({
      versionGroup: 'sword-shield',
      fallback: true,
    });
  });

  it('treats version groups it has never heard of as the newest', () => {
    const detail = detailOf({ 'x-y': tackle, 'generation-ten': tackle });
    expect(resolveVersionGroup(detail, ['scarlet-violet'])).toEqual({
      versionGroup: 'generation-ten',
      fallback: true,
    });
    expect(resolveVersionGroup(detail, [])).toEqual({
      versionGroup: 'generation-ten',
      fallback: true,
    });
    expect(resolveVersionGroup(detail, ['generation-ten'])).toEqual({
      versionGroup: 'generation-ten',
      fallback: false,
    });
  });

  it('matches either spelling of a renamed group and returns the key the data uses', () => {
    const current = detailOf({ 'brilliant-diamond-shining-pearl': tackle });
    expect(resolveVersionGroup(current, ['brilliant-diamond-and-shining-pearl'])).toEqual({
      versionGroup: 'brilliant-diamond-shining-pearl',
      fallback: false,
    });
    const legacy = detailOf({ 'brilliant-diamond-and-shining-pearl': tackle });
    expect(resolveVersionGroup(legacy, ['brilliant-diamond-shining-pearl'])).toEqual({
      versionGroup: 'brilliant-diamond-and-shining-pearl',
      fallback: false,
    });
  });

  it('reports null when the Pokémon has no level-up data anywhere', () => {
    expect(resolveVersionGroup(detailOf({}), ['scarlet-violet'])).toEqual({
      versionGroup: null,
      fallback: true,
    });
    expect(resolveVersionGroup(detailOf({ 'scarlet-violet': [] }), ['scarlet-violet'])).toEqual({
      versionGroup: null,
      fallback: true,
    });
  });
});

describe('predictWildMoveset', () => {
  const electrode = detailOf({ 'scarlet-violet': ELECTRODE });

  it('returns the four most recently learned moves at or below the level', () => {
    const prediction = predictWildMoveset(electrode, 'scarlet-violet', 30);
    expect(prediction.versionGroup).toBe('scarlet-violet');
    expect(prediction.level).toBe(30);
    expect(prediction.moves).toEqual([
      { slug: 'swift', level: 20 },
      { slug: 'electro-ball', level: 22 },
      { slug: 'self-destruct', level: 26 },
      { slug: 'light-screen', level: 29 },
    ]);
  });

  it('lists everything learned so far and everything still to come', () => {
    const prediction = predictWildMoveset(electrode, 'scarlet-violet', 30);
    expect(slugs(prediction.known)).toEqual(ELECTRODE.slice(0, 13).map(([slug]) => slug));
    expect(prediction.upcoming).toEqual([
      { slug: 'magnet-rise', level: 36 },
      { slug: 'discharge', level: 41 },
      { slug: 'explosion', level: 47 },
      { slug: 'gyro-ball', level: 54 },
      { slug: 'mirror-coat', level: 58 },
    ]);
    expect(prediction.alternates).toEqual([]);
  });

  it('includes a move learned exactly at the level and excludes the next one', () => {
    expect(slugs(predictWildMoveset(electrode, 'scarlet-violet', 26).moves)).toContain(
      'self-destruct',
    );
    expect(slugs(predictWildMoveset(electrode, 'scarlet-violet', 25).moves)).not.toContain(
      'self-destruct',
    );
    const before = predictWildMoveset(electrode, 'scarlet-violet', 25);
    expect(before.upcoming[0]).toEqual({ slug: 'self-destruct', level: 26 });
  });

  it('keeps the LAST four of a level-1 list longer than four', () => {
    const prediction = predictWildMoveset(electrode, 'scarlet-violet', 1);
    expect(slugs(prediction.moves)).toEqual(['charge', 'magnetic-flux', 'tackle', 'thunder-shock']);
    expect(slugs(prediction.known)).toEqual([
      'eerie-impulse',
      'charge',
      'magnetic-flux',
      'tackle',
      'thunder-shock',
    ]);
    // Which level-1 move got dropped depends on same-level order: flag it.
    expect(slugs(prediction.alternates)).toEqual(['eerie-impulse']);
  });

  it('reports same-level moves cut from a split group as alternates', () => {
    // At Lv. 11 the level-1 block is cut between tackle and thunder-shock.
    const prediction = predictWildMoveset(electrode, 'scarlet-violet', 11);
    expect(slugs(prediction.moves)).toEqual(['tackle', 'thunder-shock', 'spark', 'rollout']);
    expect(slugs(prediction.alternates)).toEqual(['eerie-impulse', 'charge', 'magnetic-flux']);
    // Once the whole block is gone, nothing is ambiguous any more.
    expect(predictWildMoveset(electrode, 'scarlet-violet', 16).alternates).toEqual([]);
  });

  it('returns fewer than four moves when fewer are known', () => {
    const detail = detailOf({
      'red-blue': [
        ['tackle', 1],
        ['growl', 1],
        ['ember', 9],
      ],
    });
    const prediction = predictWildMoveset(detail, 'red-blue', 5);
    expect(slugs(prediction.moves)).toEqual(['tackle', 'growl']);
    expect(prediction.upcoming).toEqual([{ slug: 'ember', level: 9 }]);
    expect(prediction.alternates).toEqual([]);
  });

  describe('level-0 evolution moves', () => {
    // Decidueye, Scarlet / Violet.
    const decidueye = detailOf({
      'scarlet-violet': [
        ['spirit-shackle', 0],
        ['leafage', 1],
        ['phantom-force', 1],
        ['leaf-storm', 1],
        ['u-turn', 1],
        ['astonish', 1],
        ['tackle', 1],
        ['spite', 1],
        ['growl', 1],
        ['peck', 9],
        ['shadow-sneak', 12],
        ['razor-leaf', 15],
      ],
    });

    it('counts them as known but lets later moves push them out', () => {
      const prediction = predictWildMoveset(decidueye, 'scarlet-violet', 5);
      expect(slugs(prediction.moves)).toEqual(['astonish', 'tackle', 'spite', 'growl']);
      expect(prediction.known[0]).toEqual({ slug: 'spirit-shackle', level: 0 });
      expect(slugs(prediction.moves)).not.toContain('spirit-shackle');
      expect(slugs(predictWildMoveset(decidueye, 'scarlet-violet', 12).moves)).toEqual([
        'spite',
        'growl',
        'peck',
        'shadow-sneak',
      ]);
    });

    it('keeps one while there is room for it', () => {
      const detail = detailOf({
        'sword-shield': [
          ['evo-move', 0],
          ['tackle', 1],
          ['growl', 1],
          ['bite', 30],
        ],
      });
      expect(predictWildMoveset(detail, 'sword-shield', 20).moves).toEqual([
        { slug: 'evo-move', level: 0 },
        { slug: 'tackle', level: 1 },
        { slug: 'growl', level: 1 },
      ]);
    });
  });

  describe('duplicate entries', () => {
    const detail = detailOf({
      'sun-moon': [
        ['spirit-shackle', 0],
        ['spirit-shackle', 1], // listed again while still known
        ['tackle', 1],
        ['growl', 1],
        ['tackle', 5], // still known → not re-taught
        ['peck', 7],
        ['astonish', 9], // pushes spirit-shackle out
        ['razor-leaf', 11], // pushes tackle out
        ['pluck', 13], // pushes growl out
        ['tackle', 20], // forgotten by now → taught again as the newest move
      ],
    });

    it('does not re-teach a move that is still in the moveset', () => {
      expect(predictWildMoveset(detail, 'sun-moon', 6).moves).toEqual([
        { slug: 'spirit-shackle', level: 0 },
        { slug: 'tackle', level: 1 },
        { slug: 'growl', level: 1 },
      ]);
      expect(slugs(predictWildMoveset(detail, 'sun-moon', 7).moves)).toEqual([
        'spirit-shackle',
        'tackle',
        'growl',
        'peck',
      ]);
    });

    it('teaches it again after it has been pushed out', () => {
      expect(slugs(predictWildMoveset(detail, 'sun-moon', 13).moves)).toEqual([
        'peck',
        'astonish',
        'razor-leaf',
        'pluck',
      ]);
      expect(predictWildMoveset(detail, 'sun-moon', 20).moves).toEqual([
        { slug: 'astonish', level: 9 },
        { slug: 'razor-leaf', level: 11 },
        { slug: 'pluck', level: 13 },
        { slug: 'tackle', level: 20 },
      ]);
    });

    it('lists a move once in `known` (first level) and keeps re-learns in `upcoming`', () => {
      const prediction = predictWildMoveset(detail, 'sun-moon', 13);
      expect(prediction.known).toEqual([
        { slug: 'spirit-shackle', level: 0 },
        { slug: 'tackle', level: 1 },
        { slug: 'growl', level: 1 },
        { slug: 'peck', level: 7 },
        { slug: 'astonish', level: 9 },
        { slug: 'razor-leaf', level: 11 },
        { slug: 'pluck', level: 13 },
      ]);
      expect(prediction.upcoming).toEqual([{ slug: 'tackle', level: 20 }]);
    });
  });

  it('clamps the level to 1–100 and floors fractions', () => {
    expect(predictWildMoveset(electrode, 'scarlet-violet', 0).level).toBe(1);
    expect(predictWildMoveset(electrode, 'scarlet-violet', -20).level).toBe(1);
    expect(predictWildMoveset(electrode, 'scarlet-violet', 250).level).toBe(100);
    expect(predictWildMoveset(electrode, 'scarlet-violet', Number.NaN).level).toBe(1);
    expect(predictWildMoveset(electrode, 'scarlet-violet', 26.9).level).toBe(26);
    const max = predictWildMoveset(electrode, 'scarlet-violet', 250);
    expect(slugs(max.moves)).toEqual(['discharge', 'explosion', 'gyro-ball', 'mirror-coat']);
    expect(max.upcoming).toEqual([]);
  });

  it('yields an empty prediction for a missing version group', () => {
    const empty = { level: 30, moves: [], known: [], upcoming: [], alternates: [] };
    expect(predictWildMoveset(electrode, 'sword-shield', 30)).toEqual({
      versionGroup: null,
      ...empty,
    });
    expect(predictWildMoveset(electrode, null, 30)).toEqual({ versionGroup: null, ...empty });
    expect(predictWildMoveset(detailOf({}), 'scarlet-violet', 30)).toEqual({
      versionGroup: null,
      ...empty,
    });
  });

  it('accepts the legacy spelling of a version group', () => {
    const detail = detailOf({ 'brilliant-diamond-shining-pearl': ELECTRODE });
    const prediction = predictWildMoveset(detail, 'brilliant-diamond-and-shining-pearl', 30);
    expect(prediction.versionGroup).toBe('brilliant-diamond-shining-pearl');
    expect(prediction.moves).toHaveLength(4);
  });

  it('does not mutate the learnset', () => {
    const snapshot = JSON.stringify(electrode);
    predictWildMoveset(electrode, 'scarlet-violet', 47);
    wildMoveLevelRanges(electrode, 'scarlet-violet', 'explosion');
    expect(JSON.stringify(electrode)).toBe(snapshot);
  });

  it('works end to end on a recorded PokeAPI response', () => {
    const decidueye = trimPokemon(decidueyeFixture);
    const { versionGroup, fallback } = resolveVersionGroup(decidueye, ['scarlet-violet']);
    expect({ versionGroup, fallback }).toEqual({ versionGroup: 'scarlet-violet', fallback: false });

    const prediction = predictWildMoveset(decidueye, versionGroup, 36);
    expect(prediction.moves).toEqual([
      { slug: 'razor-leaf', level: 15 },
      { slug: 'synthesis', level: 20 },
      { slug: 'pluck', level: 25 },
      { slug: 'nasty-plot', level: 30 },
    ]);
    expect(prediction.upcoming[0]).toEqual({ slug: 'sucker-punch', level: 37 });
    expect(prediction.known[0]).toEqual({ slug: 'spirit-shackle', level: 0 });

    // Sun/Moon lists Spirit Shackle at level 0 and again at level 1.
    const alola = predictWildMoveset(decidueye, 'sun-moon', 1);
    expect(slugs(alola.moves)).toEqual(['tackle', 'leafage', 'growl', 'peck']);
    expect(slugs(alola.known).filter((slug) => slug === 'spirit-shackle')).toHaveLength(1);
  });
});

// Level-up learnsets transcribed from PokeAPI (`/pokemon/{id}`, already in level + `order` order).
describe('predictWildMoveset — real learnsets', () => {
  const geodude = detailOf({
    'scarlet-violet': [
      ['tackle', 1],
      ['defense-curl', 1],
      ['rock-polish', 6],
      ['rollout', 10],
      ['bulldoze', 12],
      ['rock-throw', 16],
      ['smack-down', 18],
      ['self-destruct', 24],
      ['stealth-rock', 28],
      ['rock-blast', 30],
      ['earthquake', 34],
      ['explosion', 36],
      ['double-edge', 40],
      ['stone-edge', 42],
    ],
    'red-blue': [
      ['tackle', 1],
      ['defense-curl', 11],
      ['rock-throw', 16],
      ['self-destruct', 21],
      ['harden', 26],
      ['earthquake', 31],
      ['explosion', 36],
    ],
  });

  it('Geodude (Scarlet / Violet): Self-Destruct from 24, Explosion from 36', () => {
    expect(slugs(predictWildMoveset(geodude, 'scarlet-violet', 23).moves)).toEqual([
      'rollout',
      'bulldoze',
      'rock-throw',
      'smack-down',
    ]);
    expect(slugs(predictWildMoveset(geodude, 'scarlet-violet', 30).moves)).toEqual([
      'smack-down',
      'self-destruct',
      'stealth-rock',
      'rock-blast',
    ]);
    // Explosion is the fourth move after Self-Destruct, so it takes its slot.
    expect(slugs(predictWildMoveset(geodude, 'scarlet-violet', 36).moves)).toEqual([
      'stealth-rock',
      'rock-blast',
      'earthquake',
      'explosion',
    ]);
    expect(wildMoveLevelRanges(geodude, 'scarlet-violet', 'self-destruct')).toEqual([
      { from: 24, to: 35 },
    ]);
    // Only two moves follow Explosion: it is never pushed out.
    expect(wildMoveLevelRanges(geodude, 'scarlet-violet', 'explosion')).toEqual([
      { from: 36, to: 100 },
    ]);
  });

  it('Geodude (Red / Blue): a short learnset keeps Self-Destruct to level 100', () => {
    expect(slugs(predictWildMoveset(geodude, 'red-blue', 36).moves)).toEqual([
      'self-destruct',
      'harden',
      'earthquake',
      'explosion',
    ]);
    expect(wildMoveLevelRanges(geodude, 'red-blue', 'self-destruct')).toEqual([
      { from: 21, to: 100 },
    ]);
  });

  it('Voltorb (Scarlet / Violet): Self-Destruct 26–40, then Explosion', () => {
    const voltorb = detailOf({
      'scarlet-violet': [
        ['charge', 1],
        ['tackle', 1],
        ['thunder-shock', 4],
        ['eerie-impulse', 6],
        ['spark', 9],
        ['rollout', 11],
        ['screech', 13],
        ['charge-beam', 16],
        ['swift', 20],
        ['electro-ball', 22],
        ['self-destruct', 26],
        ['light-screen', 29],
        ['magnet-rise', 34],
        ['discharge', 37],
        ['explosion', 41],
        ['gyro-ball', 46],
        ['mirror-coat', 50],
      ],
    });
    const at40 = predictWildMoveset(voltorb, 'scarlet-violet', 40);
    expect(slugs(at40.moves)).toEqual([
      'self-destruct',
      'light-screen',
      'magnet-rise',
      'discharge',
    ]);
    expect(at40.upcoming[0]).toEqual({ slug: 'explosion', level: 41 });
    expect(slugs(predictWildMoveset(voltorb, 'scarlet-violet', 41).moves)).toEqual([
      'light-screen',
      'magnet-rise',
      'discharge',
      'explosion',
    ]);
    expect(wildMoveLevelRanges(voltorb, 'scarlet-violet', 'self-destruct')).toEqual([
      { from: 26, to: 40 },
    ]);
    expect(wildMoveLevelRanges(voltorb, 'scarlet-violet', 'explosion')).toEqual([
      { from: 41, to: 100 },
    ]);
  });

  it('Abra: Teleport is its whole moveset at every level', () => {
    const abra = detailOf({ 'sword-shield': [['teleport', 1]] });
    for (const level of [1, 10, 55, 100]) {
      const prediction = predictWildMoveset(abra, 'sword-shield', level);
      expect(prediction.moves).toEqual([{ slug: 'teleport', level: 1 }]);
      expect(prediction.upcoming).toEqual([]);
    }
    // Abra is not in Scarlet / Violet: the data comes from the closest game instead.
    expect(resolveVersionGroup(abra, ['scarlet-violet'])).toEqual({
      versionGroup: 'sword-shield',
      fallback: true,
    });
  });

  it('Gastly (Scarlet / Violet): carries Curse from 20 to 35', () => {
    const gastly = detailOf({
      'scarlet-violet': [
        ['confuse-ray', 1],
        ['lick', 1],
        ['hypnosis', 4],
        ['mean-look', 8],
        ['payback', 12],
        ['spite', 16],
        ['curse', 20],
        ['hex', 24],
        ['night-shade', 28],
        ['sucker-punch', 32],
        ['dark-pulse', 36],
        ['shadow-ball', 40],
        ['destiny-bond', 44],
        ['dream-eater', 48],
      ],
    });
    expect(slugs(predictWildMoveset(gastly, 'scarlet-violet', 22).moves)).toEqual([
      'mean-look',
      'payback',
      'spite',
      'curse',
    ]);
    expect(wildMoveLevelRanges(gastly, 'scarlet-violet', 'curse')).toEqual([{ from: 20, to: 35 }]);
  });

  it('Electrode (Platinum): level-1 moves listed again later are not learned twice', () => {
    const electrode = detailOf({
      platinum: [
        ['charge', 1],
        ['tackle', 1],
        ['sonic-boom', 1],
        ['spark', 1],
        ['tackle', 5],
        ['sonic-boom', 8],
        ['spark', 12],
        ['rollout', 15],
        ['screech', 19],
        ['light-screen', 22],
        ['charge-beam', 26],
        ['self-destruct', 29],
      ],
    });
    expect(slugs(predictWildMoveset(electrode, 'platinum', 12).moves)).toEqual([
      'charge',
      'tackle',
      'sonic-boom',
      'spark',
    ]);
    expect(slugs(predictWildMoveset(electrode, 'platinum', 19).moves)).toEqual([
      'sonic-boom',
      'spark',
      'rollout',
      'screech',
    ]);
    const at12 = predictWildMoveset(electrode, 'platinum', 12);
    expect(slugs(at12.known)).toEqual(['charge', 'tackle', 'sonic-boom', 'spark']);
    expect(at12.upcoming[0]).toEqual({ slug: 'rollout', level: 15 });
  });

  it('Hitmonchan (Emerald): a partly numbered same-level group is cut in game order', () => {
    const move = (slug: string, level: number, order: number | null = null): unknown => ({
      move: { name: slug },
      version_group_details: [
        {
          level_learned_at: level,
          order,
          move_learn_method: { name: 'level-up' },
          version_group: { name: 'emerald' },
        },
      ],
    });
    // Payload order and `order` values as PokeAPI serves them.
    const hitmonchan = trimPokemon({
      id: 107,
      name: 'hitmonchan',
      species: { name: 'hitmonchan', url: 'https://pokeapi.co/api/v2/pokemon-species/107/' },
      types: [{ slot: 1, type: { name: 'fighting' } }],
      stats: [],
      moves: [
        move('comet-punch', 1, 2),
        move('mega-punch', 35),
        move('fire-punch', 26, 4),
        move('ice-punch', 26, 3),
        move('thunder-punch', 26),
        move('agility', 7),
        move('pursuit', 13),
        move('mach-punch', 20),
        move('revenge', 1, 1),
        move('sky-uppercut', 32),
      ],
    });
    // In the game the punches are learned Thunder → Ice → Fire, so Thunder Punch goes first.
    const prediction = predictWildMoveset(hitmonchan, 'emerald', 35);
    expect(slugs(prediction.moves)).toEqual([
      'ice-punch',
      'fire-punch',
      'sky-uppercut',
      'mega-punch',
    ]);
    expect(slugs(prediction.alternates)).toEqual(['thunder-punch']);
  });
});

describe('wildMoveLevelRanges', () => {
  const electrode = detailOf({ 'scarlet-violet': ELECTRODE });

  it('gives the window in which a move sits in the wild moveset', () => {
    // Learned at 26, pushed out by the fourth later move (Explosion at 47).
    expect(wildMoveLevelRanges(electrode, 'scarlet-violet', 'self-destruct')).toEqual([
      { from: 26, to: 46 },
    ]);
    expect(wildMoveLevelRanges(electrode, 'scarlet-violet', 'explosion')).toEqual([
      { from: 47, to: 100 },
    ]);
    // First of five level-1 moves: never makes the cut.
    expect(wildMoveLevelRanges(electrode, 'scarlet-violet', 'eerie-impulse')).toEqual([]);
    expect(wildMoveLevelRanges(electrode, 'scarlet-violet', 'thunder-shock')).toEqual([
      { from: 1, to: 15 },
    ]);
  });

  it('returns one range per stint for a re-learned move', () => {
    const detail = detailOf({
      'sun-moon': [
        ['tackle', 1],
        ['growl', 3],
        ['peck', 5],
        ['astonish', 7],
        ['pluck', 9],
        ['tackle', 20],
      ],
    });
    expect(wildMoveLevelRanges(detail, 'sun-moon', 'tackle')).toEqual([
      { from: 1, to: 8 },
      { from: 20, to: 100 },
    ]);
  });

  it('is empty for moves outside the learnset or unknown version groups', () => {
    expect(wildMoveLevelRanges(electrode, 'scarlet-violet', 'surf')).toEqual([]);
    expect(wildMoveLevelRanges(electrode, 'sword-shield', 'explosion')).toEqual([]);
    expect(wildMoveLevelRanges(electrode, null, 'explosion')).toEqual([]);
  });
});
