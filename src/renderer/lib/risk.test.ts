import { describe, expect, it } from 'vitest';
import type { RiskMoveData } from '@renderer/data/schema';
import { getMove, predictWildMoveset } from './moveset';
import {
  RISK_SEVERITIES,
  analyzeRisk,
  compareSeverity,
  createRiskAnalyzer,
  riskAnalyzer,
  type RiskAnalysisInput,
} from './risk';

const DAMP_TIP = 'Lead with a Damp Pokémon.';

const FIXTURE: RiskMoveData = {
  version: 1,
  updated: '2026-10-13',
  categories: [
    { id: 'self-ko', label: 'Self-KO', description: 'Faints itself.', severity: 'critical' },
    { id: 'flee', label: 'Flee', description: 'Ends the battle.', severity: 'critical' },
    { id: 'recoil', label: 'Recoil', description: 'Hurts itself.', severity: 'high' },
    { id: 'hp-cost', label: 'HP cost', description: 'Pays HP.', severity: 'medium' },
    { id: 'chip', label: 'Chip damage', description: 'Weather and such.', severity: 'low' },
  ],
  moves: [
    {
      slug: 'self-destruct',
      name: 'Self-Destruct',
      category: 'self-ko',
      severity: 'critical',
      reason: 'The wild Pokémon faints itself.',
      counter: DAMP_TIP,
    },
    {
      slug: 'explosion',
      name: 'Explosion',
      category: 'self-ko',
      severity: 'critical',
      reason: 'The wild Pokémon faints itself.',
      counter: 'Lead with a Damp Pokémon', // same advice, punctuation aside
    },
    {
      slug: 'memento',
      name: 'Memento',
      category: 'self-ko',
      severity: 'critical',
      reason: 'The wild Pokémon faints itself to lower your stats.',
      counter: 'Use Taunt.',
    },
    {
      slug: 'take-down',
      name: 'Take Down',
      category: 'recoil',
      severity: 'high',
      reason: 'Recoil can finish off a weakened target.',
      detail: 'Recoil: 1/4 of damage dealt',
      counter: 'Lead with a Ghost-type.',
    },
    {
      slug: 'double-edge',
      name: 'Double-Edge',
      category: 'recoil',
      severity: 'high',
      reason: 'Recoil can finish off a weakened target.',
      counter: 'Lead with a Ghost-type.',
    },
    {
      slug: 'curse',
      name: 'Curse',
      category: 'hp-cost',
      severity: 'medium',
      reason: 'A Ghost-type user cuts its own HP in half.',
      requiresUserType: 'ghost',
    },
    {
      slug: 'teleport',
      name: 'Teleport',
      category: 'flee',
      severity: 'critical',
      reason: 'The wild Pokémon flees.',
      counter: 'Trap it with Mean Look.',
      maxGeneration: 7,
    },
    {
      slug: 'whirlwind',
      name: 'Whirlwind',
      category: 'flee',
      severity: 'critical',
      reason: 'Blows your Pokémon away and ends the battle.',
    },
    {
      slug: 'hail',
      name: 'Hail',
      category: 'chip',
      severity: 'low',
      reason: 'Chip damage every turn.',
      maxGeneration: 8,
    },
    {
      slug: 'steel-beam',
      name: 'Steel Beam',
      category: 'hp-cost',
      severity: 'high',
      reason: 'Costs half of its HP.',
      minGeneration: 8,
    },
    // Two entries for one move: harmless-ish recoil early on, far worse later.
    {
      slug: 'struggle-bug',
      name: 'Struggle Bug',
      category: 'recoil',
      severity: 'low',
      reason: 'Mild.',
      maxGeneration: 5,
    },
    {
      slug: 'struggle-bug',
      name: 'Struggle Bug',
      category: 'recoil',
      severity: 'high',
      reason: 'Severe.',
      minGeneration: 5,
    },
    {
      slug: 'mystery-move',
      name: '',
      category: 'uncharted',
      severity: 'medium',
      reason: 'Unknown category in the data.',
    },
  ],
  sources: [],
};

const analyzer = createRiskAnalyzer(FIXTURE);
const analyze = (input: Partial<RiskAnalysisInput>) =>
  analyzer.analyze({ moveset: [], types: ['normal'], generation: 9, ...input });

describe('createRiskAnalyzer', () => {
  it('reports a clean moveset', () => {
    const result = analyze({ moveset: ['tackle', 'growl', 'swift'] });
    expect(result.level).toBe('none');
    expect(result.flags).toEqual([]);
    expect(result.moveset).toEqual([
      { slug: 'tackle', name: 'Tackle', risk: null },
      { slug: 'growl', name: 'Growl', risk: null },
      { slug: 'swift', name: 'Swift', risk: null },
    ]);
    expect(result.counts).toEqual({ 'self-ko': 0, flee: 0, recoil: 0, 'hp-cost': 0, chip: 0 });
    expect(result.summary).toEqual(['No risk moves in the predicted moveset at this level.']);
    expect(result.tips).toEqual([]);
    expect(result.upcoming).toEqual([]);
    expect(result.possible).toEqual([]);
    expect(result.outgrown).toEqual([]);
  });

  it('flags risky moves with their data entry and category', () => {
    const result = analyze({ moveset: ['swift', 'self-destruct', 'light-screen', 'take-down'] });
    expect(result.level).toBe('critical');
    expect(result.moveset.map((entry) => entry.risk?.severity ?? null)).toEqual([
      null,
      'critical',
      null,
      'high',
    ]);
    const [worst, second] = result.flags;
    expect(worst).toMatchObject({
      slug: 'self-destruct',
      name: 'Self-Destruct',
      severity: 'critical',
      status: 'current',
      text: 'Self-Destruct: The wild Pokémon faints itself.',
    });
    expect(worst?.category).toEqual(FIXTURE.categories[0]);
    expect(worst?.move).toBe(FIXTURE.moves[0]);
    expect(second?.slug).toBe('take-down');
    expect(second?.move.detail).toBe('Recoil: 1/4 of damage dealt');
  });

  it('accepts LevelUpMove objects and keeps their level on the flag', () => {
    const result = analyze({
      moveset: [
        { slug: 'swift', level: 20 },
        { slug: 'self-destruct', level: 26 },
      ],
    });
    expect(result.flags[0]?.level).toBe(26);
    expect(analyze({ moveset: ['self-destruct'] }).flags[0]?.level).toBeNull();
  });

  it('takes the overall level from the worst move of the CURRENT moveset only', () => {
    expect(analyze({ moveset: ['take-down'] }).level).toBe('high');
    expect(analyze({ moveset: ['hail'], generation: 8 }).level).toBe('low');
    const calmNow = analyze({
      moveset: ['take-down'],
      known: ['explosion', 'take-down'],
      upcoming: [{ slug: 'self-destruct', level: 40 }],
      eggMoves: ['memento'],
    });
    expect(calmNow.level).toBe('high');
  });

  it('sorts current flags most severe first, keeping moveset order within a severity', () => {
    const result = analyze({
      moveset: ['hail', 'double-edge', 'whirlwind', 'take-down'],
      generation: 8,
    });
    expect(result.flags.map((flag) => flag.slug)).toEqual([
      'whirlwind',
      'double-edge',
      'take-down',
      'hail',
    ]);
    // The per-move list stays aligned with the input.
    expect(result.moveset.map((entry) => entry.slug)).toEqual([
      'hail',
      'double-edge',
      'whirlwind',
      'take-down',
    ]);
  });

  it('counts current flags per category', () => {
    const result = analyze({
      moveset: ['self-destruct', 'explosion', 'take-down', 'tackle'],
      upcoming: [{ slug: 'double-edge', level: 50 }],
    });
    expect(result.counts).toEqual({ 'self-ko': 2, flee: 0, recoil: 1, 'hp-cost': 0, chip: 0 });
  });

  describe('requiresUserType', () => {
    it('only flags Curse on Ghost-types', () => {
      expect(analyze({ moveset: ['curse'], types: ['ghost', 'poison'] }).level).toBe('medium');
      expect(analyze({ moveset: ['curse'], types: ['Ghost'] }).level).toBe('medium');
      const snorlax = analyze({ moveset: ['curse'], types: ['normal'] });
      expect(snorlax.level).toBe('none');
      expect(snorlax.moveset).toEqual([{ slug: 'curse', name: 'Curse', risk: null }]);
    });

    it('applies to upcoming moves too', () => {
      const upcoming = [{ slug: 'curse', level: 40 }];
      expect(analyze({ upcoming, types: ['ghost'] }).upcoming).toHaveLength(1);
      expect(analyze({ upcoming, types: ['rock', 'ground'] }).upcoming).toEqual([]);
    });
  });

  describe('generation limits', () => {
    it('honours maxGeneration', () => {
      expect(analyze({ moveset: ['teleport'], generation: 7 }).level).toBe('critical');
      expect(analyze({ moveset: ['teleport'], generation: 8 }).level).toBe('none');
      expect(analyze({ moveset: ['hail'], generation: 9 }).level).toBe('none');
    });

    it('honours minGeneration', () => {
      expect(analyze({ moveset: ['steel-beam'], generation: 8 }).level).toBe('high');
      expect(analyze({ moveset: ['steel-beam'], generation: 7 }).level).toBe('none');
    });

    it('picks the entry matching the generation when a move has several', () => {
      expect(analyze({ moveset: ['struggle-bug'], generation: 4 }).flags[0]?.move.reason).toBe(
        'Mild.',
      );
      expect(analyze({ moveset: ['struggle-bug'], generation: 6 }).flags[0]?.move.reason).toBe(
        'Severe.',
      );
      // Both apply in Gen 5: the more severe one wins.
      expect(analyze({ moveset: ['struggle-bug'], generation: 5 }).flags[0]?.severity).toBe('high');
    });

    it('warns rather than stays silent when the generation is unusable', () => {
      expect(analyze({ moveset: ['teleport'], generation: Number.NaN }).level).toBe('critical');
    });
  });

  describe('upcoming threats', () => {
    it('lists them by level with a "learns … at Lv." line', () => {
      const result = analyze({
        moveset: ['swift'],
        upcoming: [
          { slug: 'explosion', level: 47 },
          { slug: 'magnet-rise', level: 30 },
          { slug: 'self-destruct', level: 36 },
        ],
      });
      expect(result.level).toBe('none');
      expect(result.upcoming.map((flag) => [flag.slug, flag.level, flag.status])).toEqual([
        ['self-destruct', 36, 'upcoming'],
        ['explosion', 47, 'upcoming'],
      ]);
      expect(result.summary).toEqual([
        'No risk moves in the predicted moveset at this level.',
        'Learns Self-Destruct at Lv. 36.',
        'Learns Explosion at Lv. 47.',
      ]);
    });

    it('reports a move learned at several levels once, at the earliest', () => {
      const result = analyze({
        upcoming: [
          { slug: 'take-down', level: 60 },
          { slug: 'take-down', level: 33 },
        ],
      });
      expect(result.upcoming.map((flag) => flag.level)).toEqual([33]);
    });

    it('does not repeat a move that is already a current threat', () => {
      const result = analyze({
        moveset: ['self-destruct'],
        upcoming: [{ slug: 'self-destruct', level: 50 }],
      });
      expect(result.flags).toHaveLength(1);
      expect(result.upcoming).toEqual([]);
    });
  });

  describe('known, alternate and egg moves', () => {
    it('marks risky moves that were pushed out of the moveset as outgrown', () => {
      const result = analyze({
        moveset: ['swift', 'light-screen'],
        known: [
          { slug: 'take-down', level: 12 },
          { slug: 'swift', level: 20 },
          { slug: 'light-screen', level: 29 },
        ],
      });
      expect(result.level).toBe('none');
      expect(result.outgrown.map((flag) => [flag.slug, flag.status, flag.level])).toEqual([
        ['take-down', 'outgrown', 12],
      ]);
      expect(result.summary.at(-1)).toBe(
        'Take Down was learned earlier and has been replaced by newer moves.',
      );
    });

    it('does not call a current or soon re-learned move outgrown', () => {
      const result = analyze({
        moveset: ['self-destruct'],
        known: ['self-destruct', 'take-down'],
        upcoming: [{ slug: 'take-down', level: 44 }],
      });
      expect(result.outgrown).toEqual([]);
      expect(result.upcoming.map((flag) => flag.slug)).toEqual(['take-down']);
    });

    it('reports alternates and egg moves as possible threats without raising the level', () => {
      const result = analyze({
        moveset: ['tackle'],
        known: ['explosion', 'tackle'],
        alternates: ['explosion'],
        eggMoves: ['memento', 'explosion', 'tackle'],
      });
      expect(result.level).toBe('none');
      expect(result.possible.map((flag) => [flag.slug, flag.status])).toEqual([
        ['explosion', 'alternate'],
        ['memento', 'egg'],
      ]);
      expect(result.outgrown).toEqual([]);
      expect(result.summary).toContain(
        'May know Explosion instead of a listed move (learned at the same level).',
      );
      expect(result.summary).toContain('Memento is an Egg Move — special encounters can carry it.');
      expect(result.tips).toEqual([DAMP_TIP.replace(/\.$/, ''), 'Use Taunt.']);
    });

    it('keeps an egg move in both lists when it is also learned later', () => {
      const result = analyze({
        eggMoves: ['explosion'],
        upcoming: [{ slug: 'explosion', level: 47 }],
      });
      expect(result.possible.map((flag) => flag.status)).toEqual(['egg']);
      expect(result.upcoming.map((flag) => flag.level)).toEqual([47]);
    });
  });

  describe('tips', () => {
    it('de-duplicates countermeasures and orders them by severity', () => {
      const result = analyze({
        moveset: ['take-down', 'double-edge', 'explosion', 'self-destruct'],
      });
      // Explosion comes first in the moveset among the criticals, so its wording is kept.
      expect(result.tips).toEqual(['Lead with a Damp Pokémon', 'Lead with a Ghost-type.']);
    });

    it('skips moves without a counter and ignores upcoming threats', () => {
      const result = analyze({
        moveset: ['whirlwind'],
        upcoming: [{ slug: 'self-destruct', level: 30 }],
      });
      expect(result.tips).toEqual([]);
    });
  });

  it('copes with messy input', () => {
    const result = analyze({
      moveset: [' Self-Destruct ', '', 'self-destruct', 'not-a-real-move'],
      types: [],
    });
    expect(result.flags).toHaveLength(1);
    expect(result.counts['self-ko']).toBe(1);
    expect(result.moveset.map((entry) => entry.slug)).toEqual([
      'self-destruct',
      'self-destruct',
      'not-a-real-move',
    ]);
    expect(result.moveset.at(-1)).toEqual({
      slug: 'not-a-real-move',
      name: 'Not A Real Move',
      risk: null,
    });
  });

  it('synthesises a category and a name the data forgot', () => {
    const result = analyze({ moveset: ['mystery-move'] });
    expect(result.flags[0]?.category).toEqual({
      id: 'uncharted',
      label: 'Uncharted',
      description: '',
      severity: 'medium',
    });
    expect(result.flags[0]?.name).toBe('Mystery Move');
    expect(result.counts.uncharted).toBe(1);
  });

  it('exposes lookups', () => {
    expect(analyzer.data).toBe(FIXTURE);
    expect(analyzer.isListed('curse')).toBe(true);
    expect(analyzer.isListed(' CURSE ')).toBe(true);
    expect(analyzer.isListed('tackle')).toBe(false);
    expect(analyzer.lookup('curse', { types: ['ghost'], generation: 9 })?.slug).toBe('curse');
    expect(analyzer.lookup('curse', { types: ['dark'], generation: 9 })).toBeNull();
    expect(analyzer.lookup('tackle', { types: ['dark'], generation: 9 })).toBeNull();
    expect(analyzer.category('flee')?.label).toBe('Flee');
    expect(analyzer.category('nope')).toBeNull();
  });

  it('works with an empty dataset', () => {
    const empty = createRiskAnalyzer({ ...FIXTURE, categories: [], moves: [] });
    const result = empty.analyze({ moveset: ['explosion'], types: ['rock'], generation: 3 });
    expect(result.level).toBe('none');
    expect(result.counts).toEqual({});
  });

  it('combines with predictWildMoveset', () => {
    const detail = {
      moves: {
        'scarlet-violet': {
          levelUp: [
            { slug: 'tackle', level: 1 },
            { slug: 'take-down', level: 8 },
            { slug: 'swift', level: 20 },
            { slug: 'self-destruct', level: 26 },
            { slug: 'light-screen', level: 29 },
            { slug: 'magnet-rise', level: 36 },
            { slug: 'explosion', level: 47 },
          ],
          other: { machine: [], egg: ['memento'], tutor: [] },
        },
      },
    };
    const prediction = predictWildMoveset(detail, 'scarlet-violet', 36);
    const result = analyzer.analyze({
      ...prediction,
      moveset: prediction.moves,
      types: ['electric'],
      generation: 9,
    });
    expect(result.level).toBe('critical');
    expect(result.flags.map((flag) => [flag.slug, flag.level])).toEqual([['self-destruct', 26]]);
    expect(result.upcoming.map((flag) => [flag.slug, flag.level])).toEqual([['explosion', 47]]);
    expect(result.outgrown.map((flag) => [flag.slug, flag.level])).toEqual([['take-down', 8]]);
  });
});

describe('severity helpers', () => {
  it('orders severities from critical to low', () => {
    expect(RISK_SEVERITIES).toEqual(['critical', 'high', 'medium', 'low']);
    expect([...RISK_SEVERITIES].reverse().sort(compareSeverity)).toEqual(RISK_SEVERITIES);
  });
});

describe('bundled riskMoves.json', () => {
  const { data } = riskAnalyzer;

  it('references only categories it defines and severities the app knows', () => {
    const categoryIds = new Set(data.categories.map((category) => category.id));
    expect(categoryIds.size).toBe(data.categories.length);
    for (const move of data.moves) {
      expect(categoryIds.has(move.category), `${move.slug} → ${move.category}`).toBe(true);
      expect(RISK_SEVERITIES, move.slug).toContain(move.severity);
    }
  });

  it('uses move slugs that exist in the bundled move index', () => {
    const unknown = data.moves.map((move) => move.slug).filter((slug) => getMove(slug) === null);
    expect(unknown).toEqual([]);
  });

  it('covers the moves the product brief calls out', () => {
    for (const slug of [
      'self-destruct',
      'explosion',
      'memento',
      'take-down',
      'double-edge',
      'curse',
      'teleport',
      'whirlwind',
    ]) {
      expect(riskAnalyzer.isListed(slug), slug).toBe(true);
    }
  });

  it('flags Self-Destruct for anything and Curse only for Ghost-types', () => {
    const boom = analyzeRisk({
      moveset: ['tackle', 'self-destruct'],
      types: ['rock'],
      generation: 4,
    });
    expect(boom.level).not.toBe('none');
    expect(boom.flags[0]?.slug).toBe('self-destruct');
    expect(boom.tips.length).toBeGreaterThan(0);

    const ghost = analyzeRisk({ moveset: ['curse'], types: ['ghost'], generation: 4 });
    const normal = analyzeRisk({ moveset: ['curse'], types: ['normal'], generation: 4 });
    expect(ghost.flags.map((flag) => flag.slug)).toEqual(['curse']);
    expect(normal.flags).toEqual([]);
  });

  // Learnsets transcribed from PokeAPI; the predictions themselves are checked in moveset.test.ts.
  describe('on real wild movesets', () => {
    const learnset = (...entries: [slug: string, level: number][]) => ({
      moves: {
        game: {
          levelUp: entries.map(([slug, level]) => ({ slug, level })),
          other: { machine: [], egg: [], tutor: [] },
        },
      },
    });
    const analyzeWild = (
      detail: ReturnType<typeof learnset>,
      level: number,
      types: string[],
      generation: number,
    ) => {
      const prediction = predictWildMoveset(detail, 'game', level);
      return analyzeRisk({ ...prediction, moveset: prediction.moves, types, generation });
    };
    const flagged = (flags: readonly { slug: string }[]): string[] =>
      flags.map((flag) => flag.slug);

    // Geodude, Scarlet / Violet.
    const geodude = learnset(
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
    );

    it('Geodude at Lv. 30 carries Self-Destruct and has Explosion coming', () => {
      const result = analyzeWild(geodude, 30, ['rock', 'ground'], 9);
      expect(result.moveset.map((entry) => entry.slug)).toEqual([
        'smack-down',
        'self-destruct',
        'stealth-rock',
        'rock-blast',
      ]);
      expect(flagged(result.flags)).toContain('self-destruct');
      expect(result.moveset[1]?.risk?.status).toBe('current');
      expect(result.moveset[1]?.risk?.level).toBe(24);
      expect(result.level).toBe(result.flags[0]?.severity);
      expect(result.upcoming.map((flag) => [flag.slug, flag.level])).toEqual(
        expect.arrayContaining([
          ['explosion', 36],
          ['double-edge', 40],
        ]),
      );
      expect(result.summary).toContain('Learns Explosion at Lv. 36.');
      expect(result.tips.length).toBeGreaterThan(0);
    });

    it('Geodude at Lv. 23 is not a threat yet — Self-Destruct is only upcoming', () => {
      const result = analyzeWild(geodude, 23, ['rock', 'ground'], 9);
      expect(flagged(result.flags)).not.toContain('self-destruct');
      expect(result.upcoming.map((flag) => [flag.slug, flag.level])).toContainEqual([
        'self-destruct',
        24,
      ]);
      // The overall level never looks ahead.
      expect(result.level).toBe(result.flags[0]?.severity ?? 'none');
    });

    it('Geodude at Lv. 36 has swapped Self-Destruct for Explosion', () => {
      const result = analyzeWild(geodude, 36, ['rock', 'ground'], 9);
      expect(flagged(result.flags)).toContain('explosion');
      expect(flagged(result.flags)).not.toContain('self-destruct');
      expect(flagged(result.outgrown)).toContain('self-destruct');
      expect(flagged(result.upcoming)).not.toContain('explosion');
    });

    it('Abra can always Teleport away', () => {
      const result = analyzeWild(learnset(['teleport', 1]), 15, ['psychic'], 4);
      expect(flagged(result.flags)).toEqual(['teleport']);
      expect(result.level).not.toBe('none');
      expect(result.counts[result.flags[0]?.category.id ?? '']).toBe(1);
    });

    it('Gastly at Lv. 22 knows Curse, which only a Ghost-type pays HP for', () => {
      // Gastly, Scarlet / Violet.
      const gastly = learnset(
        ['confuse-ray', 1],
        ['lick', 1],
        ['hypnosis', 4],
        ['mean-look', 8],
        ['payback', 12],
        ['spite', 16],
        ['curse', 20],
        ['hex', 24],
      );
      const ghost = analyzeWild(gastly, 22, ['ghost', 'poison'], 9);
      expect(ghost.moveset.map((entry) => entry.slug)).toContain('curse');
      expect(flagged(ghost.flags)).toContain('curse');
      // The same moveset on a non-Ghost user: Curse is the harmless stat-changing version.
      const notGhost = analyzeWild(gastly, 22, ['normal'], 9);
      expect(flagged(notGhost.flags)).not.toContain('curse');
      expect(notGhost.moveset.find((entry) => entry.slug === 'curse')?.risk).toBeNull();
      // Before Lv. 20 it is an upcoming threat for the Ghost-type only.
      expect(flagged(analyzeWild(gastly, 19, ['ghost', 'poison'], 9).upcoming)).toContain('curse');
      expect(flagged(analyzeWild(gastly, 19, ['normal'], 9).upcoming)).not.toContain('curse');
    });
  });
});
