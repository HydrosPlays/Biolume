/**
 * Pure helpers of the Target view: catch-rate maths, breeding facts, the
 * recent-targets list, the per-level risk timeline and wiki links. Nothing
 * here touches React, the store or the network.
 */
import type { PokemonDetail } from '@renderer/api/pokeapi';
import type { RiskMove } from '@renderer/data/schema';
import { predictWildMoveset, type PredictedMoveset } from '@renderer/lib/moveset';
import {
  compareSeverity,
  riskAnalyzer,
  type RiskContext,
  type RiskFlag,
  type RiskLevel,
} from '@renderer/lib/risk';
import { findByPokemonId, type SpeciesEntry } from '@renderer/lib/species';
import { LIMITS } from '@shared/defaults';

/** `25` → `#0025`. */
export function formatDex(id: number): string {
  return `#${String(id).padStart(4, '0')}`;
}

// ───────────────────────────── Catching ─────────────────────────────

export interface CatchScenario {
  /** `full` = untouched, `one` = left at 1 HP (False Swipe). */
  hp: 'full' | 'one';
  /** Ball multiplier: 1 Poké Ball, 1.5 Great Ball, 2 Ultra Ball, … */
  ball: number;
  asleep: boolean;
  /** Generation of the game — the formula's last step changed in Gen 5. */
  generation: number;
}

/**
 * Approximate chance (0–1) that one thrown ball catches, by the main-series
 * formula: `a = hpFactor × rate × ball × status`. Through Gen 4 the four shake
 * checks multiply out to `a / 255`; from Gen 5 to `(a / 255)^0.75`. Critical
 * captures, level and badge modifiers are ignored — this is a planning figure.
 */
export function catchChance(captureRate: number, scenario: CatchScenario): number {
  if (!Number.isFinite(captureRate) || captureRate <= 0) return 0;
  const modern = scenario.generation >= 5;
  const hpFactor = scenario.hp === 'full' ? 1 / 3 : 1;
  const status = scenario.asleep ? (modern ? 2.5 : 2) : 1;
  const a = Math.min(255, hpFactor * captureRate * scenario.ball * status);
  return Math.min(1, modern ? (a / 255) ** 0.75 : a / 255);
}

export type CatchTier = 'very-easy' | 'easy' | 'moderate' | 'hard' | 'very-hard' | 'brutal';

export interface CatchDifficulty {
  tier: CatchTier;
  label: string;
  /** What that means for the hunt, in one or two sentences. */
  hint: string;
  /** Per-ball chance: full HP, no status, Poké Ball. */
  fullHp: number;
  /** Per-ball chance: 1 HP, asleep, Ultra Ball. */
  prepared: number;
}

const CATCH_TIERS: readonly { max: number; tier: CatchTier; label: string; hint: string }[] = [
  {
    max: 3,
    tier: 'brutal',
    label: 'Brutal',
    hint: 'Legendary-tier catch rate. Even asleep at 1 HP most balls fail, so stock up on Timer, Dusk or Quick Balls — a long fight gives every risk move many turns to fire.',
  },
  {
    max: 25,
    tier: 'very-hard',
    label: 'Very hard',
    hint: 'Stubborn. Weaken it and put it to sleep before throwing; each extra turn is another chance for a risk move.',
  },
  {
    max: 60,
    tier: 'hard',
    label: 'Hard',
    hint: 'Needs preparation: False Swipe plus sleep makes most balls stick within a few throws.',
  },
  {
    max: 120,
    tier: 'moderate',
    label: 'Moderate',
    hint: 'Catchable with light preparation — a status condition is usually enough.',
  },
  {
    max: 190,
    tier: 'easy',
    label: 'Easy',
    hint: 'Goes down easily; a Quick Ball on turn one often ends it before it can move.',
  },
  {
    max: 255,
    tier: 'very-easy',
    label: 'Very easy',
    hint: 'Almost any ball works at full HP — throw first and skip the fight entirely.',
  },
];

/** Plain-language reading of a capture rate (3 hardest – 255 easiest); null when unknown. */
export function catchDifficulty(
  captureRate: number | null,
  generation: number,
): CatchDifficulty | null {
  if (captureRate === null || !Number.isFinite(captureRate)) return null;
  const entry = CATCH_TIERS.find((tier) => captureRate <= tier.max) ?? CATCH_TIERS.at(-1);
  if (!entry) return null;
  return {
    tier: entry.tier,
    label: entry.label,
    hint: entry.hint,
    fullHp: catchChance(captureRate, { hp: 'full', ball: 1, asleep: false, generation }),
    prepared: catchChance(captureRate, { hp: 'one', ball: 2, asleep: true, generation }),
  };
}

// ───────────────────────────── Breeding ─────────────────────────────

export interface GenderSplit {
  genderless: boolean;
  /** Fractions 0–1; both 0 for genderless species. */
  female: number;
  male: number;
  label: string;
}

function percentLabel(fraction: number): string {
  return `${(fraction * 100).toFixed(1).replace(/\.0$/, '')}%`;
}

/** Reads PokeAPI's `gender_rate` (female eighths, -1 = genderless). */
export function genderSplit(genderRate: number): GenderSplit {
  if (!Number.isFinite(genderRate) || genderRate < 0) {
    return { genderless: true, female: 0, male: 0, label: 'Genderless' };
  }
  const female = Math.min(8, genderRate) / 8;
  const male = 1 - female;
  const label =
    female === 0
      ? 'Male only'
      : male === 0
        ? 'Female only'
        : `${percentLabel(male)} male · ${percentLabel(female)} female`;
  return { genderless: false, female, male, label };
}

/** Steps in one Egg cycle from Gen 5 on (256 in Gen 2–3, 255 in Gen 4 — close enough to plan with). */
export const STEPS_PER_EGG_CYCLE = 257;

/** Approximate steps to hatch; null when the cycle count is unknown. */
export function hatchSteps(eggCycles: number | null): number | null {
  if (eggCycles === null || !Number.isFinite(eggCycles) || eggCycles < 0) return null;
  return eggCycles * STEPS_PER_EGG_CYCLE;
}

const BREEDING_METHODS: ReadonlySet<string> = new Set([
  'breeding',
  'masuda-method',
  'shiny-breeding',
  'odd-egg',
]);

/** Methods of `oddsMethods.json` that hatch Eggs — there is no wild battle to analyse. */
export function isBreedingMethod(methodId: string): boolean {
  return BREEDING_METHODS.has(methodId);
}

const EGG_MOVE_METHODS: ReadonlySet<string> = new Set([
  'dexnav',
  'brilliant-aura',
  'grand-underground',
]);

/** Methods whose wild Pokémon can carry an Egg Move on top of the level-up moveset. */
export function addsEggMoves(methodId: string): boolean {
  return EGG_MOVE_METHODS.has(methodId);
}

// ───────────────────────────── Recent targets ─────────────────────────────

export const RECENTS_KEY = 'biolume.target.recents';
export const MAX_RECENTS = 6;

/** Decodes the stored list: `pokemon` ids known to the bundled index, newest first, no repeats. */
export function parseRecents(raw: string | null): number[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const ids: number[] = [];
  for (const value of parsed) {
    if (typeof value !== 'number' || !Number.isInteger(value)) continue;
    if (ids.includes(value) || findByPokemonId(value) === null) continue;
    ids.push(value);
    if (ids.length >= MAX_RECENTS) break;
  }
  return ids;
}

/** Moves `pokemonId` to the front of the list, dropping the oldest entry beyond the cap. */
export function pushRecent(list: readonly number[], pokemonId: number): number[] {
  return [pokemonId, ...list.filter((id) => id !== pokemonId)].slice(0, MAX_RECENTS);
}

// ───────────────────────────── Risk ─────────────────────────────

export interface RiskVerdict {
  /** One word for badges and the timeline legend. */
  label: string;
  /** Headline of the risk banner. */
  title: string;
}

const VERDICTS: Record<RiskLevel, RiskVerdict> = {
  critical: { label: 'Critical', title: 'This encounter can end itself' },
  high: { label: 'High', title: 'It can knock itself out once weakened' },
  medium: { label: 'Medium', title: 'Manageable, but plan around it' },
  low: { label: 'Low', title: 'Nuisance moves only' },
  none: { label: 'Clear', title: 'No risk moves in the wild moveset' },
};

export function riskVerdict(level: RiskLevel): RiskVerdict {
  return VERDICTS[level];
}

/** The text up to the first sentence end; the whole text when it has none. */
export function firstSentence(text: string): string {
  const trimmed = text.trim();
  const match = /^.*?[.!?](?=\s|$)/.exec(trimmed);
  return match?.[0] ?? trimmed;
}

/** "Learns Explosion at Lv. 36 — hunt below that, or prepare: Lead with a Damp Pokémon …". */
export function upcomingAdvice(flag: Pick<RiskFlag, 'name' | 'level' | 'move'>): string {
  const when = flag.level === null ? 'at a higher level' : `at Lv. ${flag.level}`;
  const counter = flag.move.counter?.trim();
  return counter
    ? `Learns ${flag.name} ${when} — hunt below that, or prepare: ${firstSentence(counter)}`
    : `Learns ${flag.name} ${when} — hunt below that level.`;
}

/** `[{ from: 26, to: 46 }, { from: 60, to: 60 }]` → `Lv. 26–46, Lv. 60`. */
export function formatLevelRanges(ranges: readonly { from: number; to: number }[]): string {
  return ranges
    .map((range) =>
      range.from === range.to ? `Lv. ${range.from}` : `Lv. ${range.from}–${range.to}`,
    )
    .join(', ');
}

export interface RiskSegment {
  /** Inclusive wild-level range sharing one set of risk moves. */
  from: number;
  to: number;
  level: RiskLevel;
  /** Display names of the risk moves carried in this range, most severe first. */
  moves: string[];
}

/**
 * How the risk of the predicted wild moveset changes across levels 1–100:
 * consecutive levels carrying the same risk moves are merged into one segment.
 * Empty when there is no learnset to predict from.
 */
export function buildRiskTimeline(
  detail: Pick<PokemonDetail, 'moves'>,
  versionGroup: string | null,
  context: RiskContext,
): RiskSegment[] {
  if (versionGroup === null) return [];
  const segments: RiskSegment[] = [];
  let open: RiskSegment | null = null;
  let openKey = '';
  for (let level = LIMITS.targetLevel.min; level <= LIMITS.targetLevel.max; level += 1) {
    const flagged = predictWildMoveset(detail, versionGroup, level)
      .moves.map((move) => riskAnalyzer.lookup(move.slug, context))
      .filter((move): move is RiskMove => move !== null)
      .sort((a, b) => compareSeverity(a.severity, b.severity) || a.name.localeCompare(b.name));
    const key = flagged.map((move) => move.slug).join('|');
    if (open && key === openKey) {
      open.to = level;
    } else {
      open = {
        from: level,
        to: level,
        level: flagged[0]?.severity ?? 'none',
        moves: flagged.map((move) => move.name),
      };
      openKey = key;
      segments.push(open);
    }
  }
  return segments;
}

/**
 * - `current`  — in the predicted moveset
 * - `replaced` — learned at or below the level, since pushed out
 * - `upcoming` — learned above the level
 */
export type LearnsetState = 'current' | 'replaced' | 'upcoming';

export interface LearnsetRow {
  key: string;
  slug: string;
  /** Level learned at; 0 = on evolution. */
  level: number;
  state: LearnsetState;
  /** The applicable risk entry, or null for a harmless move. */
  risk: RiskMove | null;
}

/** The whole level-up learnset in learn order, each move marked against the predicted moveset. */
export function buildLearnsetRows(
  prediction: Pick<PredictedMoveset, 'moves' | 'known' | 'upcoming'>,
  context: RiskContext,
): LearnsetRow[] {
  const current = new Set(prediction.moves.map((move) => move.slug));
  const rows: LearnsetRow[] = [];
  for (const move of prediction.known) {
    rows.push({
      key: `known:${move.slug}`,
      slug: move.slug,
      level: move.level,
      state: current.has(move.slug) ? 'current' : 'replaced',
      risk: riskAnalyzer.lookup(move.slug, context),
    });
  }
  prediction.upcoming.forEach((move, index) => {
    rows.push({
      key: `upcoming:${index}:${move.slug}`,
      slug: move.slug,
      level: move.level,
      state: 'upcoming',
      risk: riskAnalyzer.lookup(move.slug, context),
    });
  });
  return rows;
}

// ───────────────────────────── Links out ─────────────────────────────

/** Bulbapedia article of the species (forms share their species' article). */
export function bulbapediaUrl(species: Pick<SpeciesEntry, 'name'>): string {
  const title = encodeURIComponent(species.name.replaceAll(' ', '_'));
  return `https://bulbapedia.bulbagarden.net/wiki/${title}_(Pok%C3%A9mon)`;
}

/** Serebii keeps one Pokédex per generation; Gen 1–7 pages are numbered, Gen 8+ pages are named. */
const SEREBII_DEX: Record<number, string> = {
  1: 'pokedex',
  2: 'pokedex-gs',
  3: 'pokedex-rs',
  4: 'pokedex-dp',
  5: 'pokedex-bw',
  6: 'pokedex-xy',
  7: 'pokedex-sm',
  8: 'pokedex-swsh',
  9: 'pokedex-sv',
};

/**
 * Serebii Pokédex page of the species for the generation being hunted in —
 * or, when the species is newer than that game, for its debut generation.
 */
export function serebiiUrl(
  species: Pick<SpeciesEntry, 'id' | 'name' | 'gen'>,
  generation: number,
): string {
  const wanted = Number.isFinite(generation) ? Math.floor(generation) : species.gen;
  const gen = Math.min(9, Math.max(1, species.gen, wanted));
  const dex = SEREBII_DEX[gen] ?? 'pokedex-sv';
  if (gen < 8) return `https://www.serebii.net/${dex}/${String(species.id).padStart(3, '0')}.shtml`;
  const name = species.name.toLowerCase().replace('♀', 'f').replace('♂', 'm').replaceAll(' ', '');
  return `https://www.serebii.net/${dex}/${encodeURIComponent(name)}/`;
}
