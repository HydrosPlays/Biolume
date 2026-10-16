/**
 * Moves: the bundled move index, PokeAPI version-group metadata, and the
 * prediction of what a wild Pokémon knows at a given level.
 */
import moveIndex from '@renderer/data/moveIndex.json';
import type { LevelUpMove, PokemonDetail } from '@renderer/api/pokeapi';
import { LIMITS } from '@shared/defaults';

// ───────────────────────────── Move index ─────────────────────────────

export type MoveClass = 'physical' | 'special' | 'status';

export interface MoveInfo {
  /** PokeAPI move id. */
  id: number;
  /** PokeAPI move slug, e.g. `self-destruct`. */
  slug: string;
  /** English display name, e.g. `Self-Destruct`. */
  name: string;
  /** Type slug. */
  type: string;
  class: MoveClass;
  /** Base power in the latest games; null for status and variable-power moves. */
  power: number | null;
  /** Accuracy in percent; null for moves that cannot miss. */
  accuracy: number | null;
  pp: number | null;
  /** Priority bracket, 0 for most moves. */
  priority: number;
  /** Generation the move was introduced in. */
  gen: number;
}

/** Row shape of `moveIndex.json`; absent stats are null, absent priority is 0. */
interface RawMove {
  i: number;
  n: string;
  t: string;
  /** Index into the file's `classes` table. */
  c: number;
  p?: number;
  a?: number;
  pp?: number;
  pr?: number;
  g: number;
}

const rawMoves: Record<string, RawMove> = moveIndex.moves;
const moveCache = new Map<string, MoveInfo>();

function toMoveClass(value: string | undefined): MoveClass {
  return value === 'physical' || value === 'special' ? value : 'status';
}

/** Number of moves in the bundled index. */
export const MOVE_COUNT = Object.keys(rawMoves).length;

/** Looks a move up by PokeAPI slug; null when the bundled index does not know it. */
export function getMove(slug: string): MoveInfo | null {
  const cached = moveCache.get(slug);
  if (cached) return cached;
  // `hasOwn` keeps inherited keys such as "constructor" from reading as moves.
  if (!Object.hasOwn(rawMoves, slug)) return null;
  const raw = rawMoves[slug];
  if (!raw) return null;
  const move: MoveInfo = {
    id: raw.i,
    slug,
    name: raw.n,
    type: raw.t,
    class: toMoveClass(moveIndex.classes[raw.c]),
    power: raw.p ?? null,
    accuracy: raw.a ?? null,
    pp: raw.pp ?? null,
    priority: raw.pr ?? 0,
    gen: raw.g,
  };
  moveCache.set(slug, move);
  return move;
}

/** Display name of a move; unknown slugs are title-cased (`new-move` → `New Move`). */
export function moveName(slug: string): string {
  return (
    getMove(slug)?.name ??
    slug
      .split('-')
      .filter((word) => word !== '')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
  );
}

// ───────────────────────────── Version groups ─────────────────────────────

export interface VersionGroupInfo {
  /** PokeAPI `version-group` slug. */
  slug: string;
  /** Display name, e.g. `Sword / Shield`. */
  label: string;
  generation: number;
  /**
   * Not a game a hunt would use as a learnset reference — side games and
   * regional duplicates. Only used as a fallback when nothing else has data.
   */
  secondary?: boolean;
}

/** Every PokeAPI version group in release order (PokeAPI's own `order` column). */
export const VERSION_GROUPS: readonly VersionGroupInfo[] = [
  { slug: 'red-green-japan', label: 'Red / Green (Japan)', generation: 1, secondary: true },
  { slug: 'blue-japan', label: 'Blue (Japan)', generation: 1, secondary: true },
  { slug: 'red-blue', label: 'Red / Blue', generation: 1 },
  { slug: 'yellow', label: 'Yellow', generation: 1 },
  { slug: 'gold-silver', label: 'Gold / Silver', generation: 2 },
  { slug: 'crystal', label: 'Crystal', generation: 2 },
  { slug: 'ruby-sapphire', label: 'Ruby / Sapphire', generation: 3 },
  { slug: 'emerald', label: 'Emerald', generation: 3 },
  { slug: 'colosseum', label: 'Colosseum', generation: 3, secondary: true },
  { slug: 'xd', label: 'XD: Gale of Darkness', generation: 3, secondary: true },
  { slug: 'firered-leafgreen', label: 'FireRed / LeafGreen', generation: 3 },
  { slug: 'diamond-pearl', label: 'Diamond / Pearl', generation: 4 },
  { slug: 'platinum', label: 'Platinum', generation: 4 },
  { slug: 'heartgold-soulsilver', label: 'HeartGold / SoulSilver', generation: 4 },
  { slug: 'black-white', label: 'Black / White', generation: 5 },
  { slug: 'black-2-white-2', label: 'Black 2 / White 2', generation: 5 },
  { slug: 'x-y', label: 'X / Y', generation: 6 },
  { slug: 'omega-ruby-alpha-sapphire', label: 'Omega Ruby / Alpha Sapphire', generation: 6 },
  { slug: 'sun-moon', label: 'Sun / Moon', generation: 7 },
  { slug: 'ultra-sun-ultra-moon', label: 'Ultra Sun / Ultra Moon', generation: 7 },
  { slug: 'lets-go-pikachu-lets-go-eevee', label: "Let's Go, Pikachu! / Eevee!", generation: 7 },
  { slug: 'sword-shield', label: 'Sword / Shield', generation: 8 },
  { slug: 'the-isle-of-armor', label: 'The Isle of Armor', generation: 8 },
  { slug: 'the-crown-tundra', label: 'The Crown Tundra', generation: 8 },
  {
    slug: 'brilliant-diamond-shining-pearl',
    label: 'Brilliant Diamond / Shining Pearl',
    generation: 8,
  },
  { slug: 'legends-arceus', label: 'Legends: Arceus', generation: 8 },
  { slug: 'scarlet-violet', label: 'Scarlet / Violet', generation: 9 },
  { slug: 'the-teal-mask', label: 'The Teal Mask', generation: 9 },
  { slug: 'the-indigo-disk', label: 'The Indigo Disk', generation: 9 },
  { slug: 'legends-za', label: 'Legends: Z-A', generation: 9 },
  { slug: 'mega-dimension', label: 'Mega Dimension', generation: 9 },
  { slug: 'champions', label: 'Champions', generation: 9, secondary: true },
];

/** Spellings PokeAPI has used for the same version group → the current slug. */
const VERSION_GROUP_ALIASES: Record<string, string> = {
  'brilliant-diamond-and-shining-pearl': 'brilliant-diamond-shining-pearl',
};

const versionGroupOrder = new Map(VERSION_GROUPS.map((group, index) => [group.slug, index]));

/** Maps a historical spelling to the current PokeAPI slug; other slugs pass through. */
export function canonicalVersionGroup(slug: string): string {
  // `hasOwn` keeps inherited keys such as "constructor" from reading as aliases.
  return Object.hasOwn(VERSION_GROUP_ALIASES, slug) ? (VERSION_GROUP_ALIASES[slug] ?? slug) : slug;
}

/** Metadata for a version group (either spelling); null for groups newer than this build. */
export function getVersionGroup(slug: string): VersionGroupInfo | null {
  const index = versionGroupOrder.get(canonicalVersionGroup(slug));
  return index === undefined ? null : (VERSION_GROUPS[index] ?? null);
}

/** Display name of a version group, e.g. `sword-shield` → `Sword / Shield`. */
export function versionGroupLabel(slug: string): string {
  return (
    getVersionGroup(slug)?.label ??
    slug
      .split('-')
      .filter((word) => word !== '')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
  );
}

type MoveSource = Pick<PokemonDetail, 'moves'>;

/** The key under which `detail.moves` stores a version group, whichever spelling was asked for. */
function findMovesKey(detail: MoveSource, versionGroup: string): string | null {
  if (Object.hasOwn(detail.moves, versionGroup)) return versionGroup;
  const canonical = canonicalVersionGroup(versionGroup);
  for (const key of Object.keys(detail.moves)) {
    if (canonicalVersionGroup(key) === canonical) return key;
  }
  return null;
}

function hasLevelUpData(detail: MoveSource, key: string): boolean {
  return (detail.moves[key]?.levelUp.length ?? 0) > 0;
}

export interface ResolvedVersionGroup {
  /** Key into `detail.moves`, or null when the Pokémon has no level-up data at all. */
  versionGroup: string | null;
  /** True when the data comes from a game other than the requested ones. */
  fallback: boolean;
}

/**
 * Picks the version group whose learnset should be shown for a hunt.
 *
 * `preferred` is the game's `versionGroups` list (most relevant first). The
 * first of them with level-up data for this Pokémon wins. When none has any —
 * PokeAPI coverage is incomplete, and not every Pokémon exists in every game —
 * the closest release with data is returned and flagged `fallback: true` so
 * the UI can say "showing data from <other game>":
 * closeness is measured in release order from the first preferred group, ties
 * go to the older game, and side games are only used when nothing else exists.
 * With no recognisable preference the most recent game with data is used.
 */
export function resolveVersionGroup(
  detail: MoveSource,
  preferred: readonly string[],
): ResolvedVersionGroup {
  for (const slug of preferred) {
    const key = findMovesKey(detail, slug);
    if (key !== null && hasLevelUpData(detail, key)) return { versionGroup: key, fallback: false };
  }

  const available = Object.keys(detail.moves).filter((key) => hasLevelUpData(detail, key));
  if (available.length === 0) return { versionGroup: null, fallback: true };

  // Groups this build has never heard of are assumed to be newer than all known ones.
  const orderOf = (key: string): number =>
    versionGroupOrder.get(canonicalVersionGroup(key)) ?? VERSION_GROUPS.length;
  const mainline = available.filter((key) => !getVersionGroup(key)?.secondary);
  const candidates = (mainline.length > 0 ? mainline : available).sort(
    (a, b) => orderOf(a) - orderOf(b) || a.localeCompare(b),
  );

  const anchor = preferred
    .map((slug) => versionGroupOrder.get(canonicalVersionGroup(slug)))
    .find((order) => order !== undefined);
  if (anchor === undefined) {
    return { versionGroup: candidates.at(-1) ?? null, fallback: true };
  }

  let best = candidates[0] ?? null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const key of candidates) {
    // Candidates are in release order, so a strict `<` keeps the older game on a tie.
    const distance = Math.abs(orderOf(key) - anchor);
    if (distance < bestDistance) {
      best = key;
      bestDistance = distance;
    }
  }
  return { versionGroup: best, fallback: true };
}

// ───────────────────────────── Wild moveset prediction ─────────────────────────────

/** Moves a Pokémon can know at once. */
export const MOVESET_SIZE = 4;

export interface PredictedMoveset {
  /** The `detail.moves` key the prediction is based on; null when there was no data. */
  versionGroup: string | null;
  /** The level used, after clamping to 1–100. */
  level: number;
  /**
   * The predicted moveset: at most four moves in slot order (oldest first,
   * most recently learned last), each with the level it was learned at.
   */
  moves: LevelUpMove[];
  /** Every level-up move learned at or below the level, in learn order, one entry per move. */
  known: LevelUpMove[];
  /** Level-up entries above the level, ascending — including re-learns of moves already known. */
  upcoming: LevelUpMove[];
  /**
   * Moves left out of `moves` only because of their position within a group
   * of moves learned at the same level as the oldest kept move. Which members
   * of such a group survive depends on the in-game order of same-level moves,
   * which PokeAPI records less reliably than the levels themselves — treat
   * these as "may know instead".
   */
  alternates: LevelUpMove[];
}

function clampLevel(level: number): number {
  const { min, max } = LIMITS.targetLevel;
  if (!Number.isFinite(level)) return min;
  return Math.min(max, Math.max(min, Math.floor(level)));
}

/** Runs the games' initial-moveset routine over a learnset (see {@link predictWildMoveset}). */
function fillMoveset(levelUp: readonly LevelUpMove[], level: number): LevelUpMove[] {
  const slots: LevelUpMove[] = [];
  for (const entry of levelUp) {
    if (entry.level > level) break;
    if (slots.some((slot) => slot.slug === entry.slug)) continue;
    slots.push(entry);
    if (slots.length > MOVESET_SIZE) slots.shift();
  }
  return slots;
}

/**
 * Predicts the moveset of a wild Pokémon encountered at `level`.
 *
 * THE RULE — the main-series games build a wild Pokémon's moveset the same
 * way: they walk the species' level-up learnset from the top (lowest level
 * first) up to the Pokémon's level, teaching each move in turn; a move that is
 * already known is skipped, and once all four slots are full each new move
 * pushes out the oldest one. The result is "the four most recently learned
 * level-up moves at or below its level".
 *
 * Details handled here:
 * - Level-0 entries are moves learned on evolution (Gen 7+). They sit at the
 *   top of the learnset, so a wild evolved Pokémon knows one only until four
 *   later moves have replaced it.
 * - Evolved Pokémon often list far more than four moves at level 1; the walk
 *   keeps the last four in learnset order, not the first four.
 * - A move listed twice (e.g. at level 1 and again later) is not re-taught
 *   while it is still in the moveset, so it keeps its original slot.
 *
 * KNOWN EXCEPTIONS — the prediction does not cover:
 * - Scripted movesets: many static / legendary encounters, Totem Pokémon, Max
 *   Raid and Tera Raid bosses, and the extra moves of alpha Pokémon in
 *   Legends: Arceus.
 * - Encounters that add an Egg Move on top of the level-up set: ORAS DexNav,
 *   Sun/Moon Island Scan, Sword/Shield "brilliant aura" Pokémon and BDSP Grand
 *   Underground spawns. Egg Moves are in `detail.moves[group].other.egg`.
 * - The order of moves learned at the same level comes from PokeAPI's `order`
 *   field; where that is missing or wrong, a cut through such a group may keep
 *   the wrong members — see {@link PredictedMoveset.alternates}.
 * - Learnsets are per version group; the rare per-version differences inside
 *   one group are not modelled.
 *
 * An unknown `versionGroup` (or null) yields an empty prediction.
 */
export function predictWildMoveset(
  detail: MoveSource,
  versionGroup: string | null,
  level: number,
): PredictedMoveset {
  const wildLevel = clampLevel(level);
  const key = versionGroup === null ? null : findMovesKey(detail, versionGroup);
  const levelUp = key === null ? [] : (detail.moves[key]?.levelUp ?? []);

  const known: LevelUpMove[] = [];
  const upcoming: LevelUpMove[] = [];
  const seen = new Set<string>();
  for (const entry of levelUp) {
    if (entry.level > wildLevel) {
      upcoming.push(entry);
    } else if (!seen.has(entry.slug)) {
      seen.add(entry.slug);
      known.push(entry);
    }
  }

  const moves = fillMoveset(levelUp, wildLevel);
  const cutLevel = moves[0]?.level;
  const alternates =
    cutLevel === undefined
      ? []
      : known.filter(
          (entry) => entry.level === cutLevel && !moves.some((move) => move.slug === entry.slug),
        );

  return { versionGroup: key, level: wildLevel, moves, known, upcoming, alternates };
}

export interface LevelRange {
  from: number;
  to: number;
}

/**
 * The wild levels (1–100) at which `moveSlug` is part of the predicted
 * moveset, as inclusive ranges — e.g. "carries Self-Destruct from Lv. 26 to
 * Lv. 46". Empty when the Pokémon never has the move in the wild.
 */
export function wildMoveLevelRanges(
  detail: MoveSource,
  versionGroup: string | null,
  moveSlug: string,
): LevelRange[] {
  const key = versionGroup === null ? null : findMovesKey(detail, versionGroup);
  const levelUp = key === null ? [] : (detail.moves[key]?.levelUp ?? []);
  if (!levelUp.some((entry) => entry.slug === moveSlug)) return [];

  const ranges: LevelRange[] = [];
  let open: LevelRange | null = null;
  for (let level = LIMITS.targetLevel.min; level <= LIMITS.targetLevel.max; level += 1) {
    const carried = fillMoveset(levelUp, level).some((move) => move.slug === moveSlug);
    if (carried) {
      if (open) open.to = level;
      else {
        open = { from: level, to: level };
        ranges.push(open);
      }
    } else {
      open = null;
    }
  }
  return ranges;
}
