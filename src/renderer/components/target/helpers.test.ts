import { describe, expect, it } from 'vitest';
import { predictWildMoveset } from '@renderer/lib/moveset';
import { EXTERNAL_URL_ALLOWLIST } from '@shared/ipc';
import { FIXTURE_VERSION_GROUP, GEODUDE } from './fixtures';
import {
  buildLearnsetRows,
  buildRiskTimeline,
  bulbapediaUrl,
  catchChance,
  catchDifficulty,
  firstSentence,
  formatDex,
  formatLevelRanges,
  genderSplit,
  hatchSteps,
  MAX_RECENTS,
  parseRecents,
  pushRecent,
  serebiiUrl,
  upcomingAdvice,
} from './helpers';

const GEN9 = { types: GEODUDE.types, generation: 9 };

describe('catching', () => {
  it('follows the main-series formula before and after Gen 5', () => {
    // Gen 4: a = 45 / 3 = 15 → 15 / 255.
    expect(catchChance(45, { hp: 'full', ball: 1, asleep: false, generation: 4 })).toBeCloseTo(
      15 / 255,
      6,
    );
    // Gen 9: a = 3 × 2 (Ultra) × 2.5 (sleep) = 15 → (15 / 255)^0.75.
    expect(catchChance(3, { hp: 'one', ball: 2, asleep: true, generation: 9 })).toBeCloseTo(
      (15 / 255) ** 0.75,
      6,
    );
    expect(catchChance(255, { hp: 'one', ball: 2, asleep: true, generation: 3 })).toBe(1);
    expect(catchChance(0, { hp: 'full', ball: 1, asleep: false, generation: 9 })).toBe(0);
  });

  it('reads capture rates in plain language', () => {
    expect(catchDifficulty(3, 9)?.tier).toBe('brutal');
    expect(catchDifficulty(45, 9)?.tier).toBe('hard');
    expect(catchDifficulty(255, 9)).toMatchObject({ tier: 'very-easy', label: 'Very easy' });
    expect(catchDifficulty(null, 9)).toBeNull();
    const starter = catchDifficulty(45, 9);
    expect(starter && starter.prepared > starter.fullHp).toBe(true);
  });
});

describe('breeding', () => {
  it('turns female eighths into a gender split', () => {
    expect(genderSplit(-1)).toMatchObject({ genderless: true, label: 'Genderless' });
    expect(genderSplit(0).label).toBe('Male only');
    expect(genderSplit(8).label).toBe('Female only');
    expect(genderSplit(1)).toMatchObject({
      female: 0.125,
      male: 0.875,
      label: '87.5% male · 12.5% female',
    });
  });

  it('estimates hatch steps from egg cycles', () => {
    expect(hatchSteps(20)).toBe(5140);
    expect(hatchSteps(null)).toBeNull();
  });
});

describe('recent targets', () => {
  it('survives corrupt storage and drops unknown or repeated ids', () => {
    expect(parseRecents(null)).toEqual([]);
    expect(parseRecents('{not json')).toEqual([]);
    expect(parseRecents('{"a":1}')).toEqual([]);
    expect(parseRecents('[74, 74, "25", 999999, 10109, 1.5]')).toEqual([74, 10109]);
    expect(parseRecents(JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toHaveLength(MAX_RECENTS);
  });

  it('moves a repeat to the front and caps the list', () => {
    expect(pushRecent([1, 2, 3], 3)).toEqual([3, 1, 2]);
    const full = Array.from({ length: MAX_RECENTS }, (_, index) => index + 1);
    const next = pushRecent(full, 150);
    expect(next).toHaveLength(MAX_RECENTS);
    expect(next[0]).toBe(150);
    expect(next).not.toContain(MAX_RECENTS);
  });
});

describe('risk across levels', () => {
  it('merges levels that carry the same risk moves into segments covering 1–100', () => {
    expect(buildRiskTimeline(GEODUDE, FIXTURE_VERSION_GROUP, GEN9)).toEqual([
      { from: 1, to: 23, level: 'none', moves: [] },
      { from: 24, to: 35, level: 'critical', moves: ['Self-Destruct'] },
      { from: 36, to: 39, level: 'critical', moves: ['Explosion'] },
      { from: 40, to: 100, level: 'critical', moves: ['Explosion', 'Double-Edge'] },
    ]);
  });

  it('applies generation-limited risks and handles a missing learnset', () => {
    // Bulldoze hits allies only matter in Gen 5–8 multi-wild battles.
    const gen8 = buildRiskTimeline(GEODUDE, FIXTURE_VERSION_GROUP, { ...GEN9, generation: 8 });
    expect(gen8[0]).toEqual({ from: 1, to: 11, level: 'none', moves: [] });
    expect(gen8[1]).toMatchObject({ from: 12, level: 'medium', moves: ['Bulldoze'] });
    expect(buildRiskTimeline(GEODUDE, null, GEN9)).toEqual([]);
  });

  it('marks every learnset row against the predicted moveset', () => {
    const prediction = predictWildMoveset(GEODUDE, FIXTURE_VERSION_GROUP, 25);
    const rows = buildLearnsetRows(prediction, GEN9);
    expect(rows).toHaveLength(14);
    expect(rows.filter((row) => row.state === 'current').map((row) => row.slug)).toEqual([
      'bulldoze',
      'rock-throw',
      'smack-down',
      'self-destruct',
    ]);
    expect(rows.find((row) => row.slug === 'tackle')?.state).toBe('replaced');
    expect(rows.find((row) => row.slug === 'self-destruct')?.risk?.severity).toBe('critical');
    expect(rows.find((row) => row.slug === 'explosion')).toMatchObject({
      state: 'upcoming',
      level: 36,
    });
    expect(rows.find((row) => row.slug === 'bulldoze')?.risk).toBeNull();
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  it('words upcoming threats as advice', () => {
    expect(firstSentence('Lead with Damp: it fails. A Ghost does not help.')).toBe(
      'Lead with Damp: it fails.',
    );
    expect(firstSentence('no full stop')).toBe('no full stop');
    expect(
      upcomingAdvice({
        name: 'Explosion',
        level: 36,
        move: {
          slug: 'explosion',
          name: 'Explosion',
          category: 'self-ko',
          severity: 'critical',
          reason: 'Faints itself.',
          counter: 'Lead with a Damp Pokémon. Or sleep it.',
        },
      }),
    ).toBe('Learns Explosion at Lv. 36 — hunt below that, or prepare: Lead with a Damp Pokémon.');
    expect(
      formatLevelRanges([
        { from: 26, to: 46 },
        { from: 60, to: 60 },
      ]),
    ).toBe('Lv. 26–46, Lv. 60');
  });
});

describe('links out', () => {
  const pikachu = { id: 25, name: 'Pikachu', gen: 1 };
  const mrMime = { id: 122, name: 'Mr. Mime', gen: 1 };

  it('builds wiki URLs on allow-listed https hosts', () => {
    const urls = [
      bulbapediaUrl(mrMime),
      serebiiUrl(pikachu, 4),
      serebiiUrl(pikachu, 9),
      serebiiUrl({ id: 29, name: 'Nidoran♀', gen: 1 }, 8),
    ];
    expect(urls).toEqual([
      'https://bulbapedia.bulbagarden.net/wiki/Mr._Mime_(Pok%C3%A9mon)',
      'https://www.serebii.net/pokedex-dp/025.shtml',
      'https://www.serebii.net/pokedex-sv/pikachu/',
      'https://www.serebii.net/pokedex-swsh/nidoranf/',
    ]);
    for (const url of urls) {
      const parsed = new URL(url);
      expect(parsed.protocol).toBe('https:');
      expect(EXTERNAL_URL_ALLOWLIST).toContain(parsed.hostname);
    }
  });

  it('uses the debut generation when the species is newer than the game', () => {
    expect(serebiiUrl({ id: 906, name: 'Sprigatito', gen: 9 }, 4)).toBe(
      'https://www.serebii.net/pokedex-sv/sprigatito/',
    );
    expect(serebiiUrl(mrMime, 8)).toBe('https://www.serebii.net/pokedex-swsh/mr.mime/');
  });

  it('pads dex numbers', () => {
    expect(formatDex(25)).toBe('#0025');
    expect(formatDex(1025)).toBe('#1025');
  });
});
