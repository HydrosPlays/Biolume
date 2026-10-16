/**
 * Risk-move analysis: which of a wild Pokémon's moves can cost the hunter a
 * shiny — self-KO moves, recoil, fleeing, forced switches, …
 *
 * The move list lives in `src/renderer/data/riskMoves.json` (shape:
 * {@link RiskMoveData}). {@link createRiskAnalyzer} works on any such data;
 * {@link riskAnalyzer} / {@link analyzeRisk} are bound to the bundled file.
 */
import riskMoveData from '@renderer/data/riskMoves.json';
import type { RiskCategory, RiskMove, RiskMoveData, RiskSeverity } from '@renderer/data/schema';
import { moveName } from './moveset';

/** Most to least severe. */
export const RISK_SEVERITIES: readonly RiskSeverity[] = ['critical', 'high', 'medium', 'low'];

/** Overall verdict: the worst severity present, or `none`. */
export type RiskLevel = RiskSeverity | 'none';

const SEVERITY_RANK: Record<RiskSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Sort comparator: more severe first. */
export function compareSeverity(a: RiskSeverity, b: RiskSeverity): number {
  return SEVERITY_RANK[a] - SEVERITY_RANK[b];
}

/** A move given as a slug, or as an object carrying one — e.g. a `LevelUpMove` with its level. */
export type MoveLike = string | { slug: string; level?: number };

export interface RiskContext {
  /** Types of the wild Pokémon (PokeAPI slugs) — decides e.g. whether Curse is the Ghost version. */
  types: readonly string[];
  /** Generation of the game being played; risk entries can be limited to a generation range. */
  generation: number;
}

export interface RiskAnalysisInput extends RiskContext {
  /** The predicted current moveset (`PredictedMoveset.moves`). */
  moveset: readonly MoveLike[];
  /** Every level-up move at or below the level (`PredictedMoveset.known`). */
  known?: readonly MoveLike[];
  /** Level-up moves above the level (`PredictedMoveset.upcoming`). */
  upcoming?: readonly { slug: string; level: number }[];
  /** Moves that may be known instead of a predicted one (`PredictedMoveset.alternates`). */
  alternates?: readonly MoveLike[];
  /**
   * Egg Moves of the Pokémon. Pass them only for encounter methods that can
   * add one to a wild moveset (ORAS DexNav, Sun/Moon Island Scan, Sword/Shield
   * brilliant aura, BDSP Grand Underground).
   */
  eggMoves?: readonly MoveLike[];
}

/**
 * - `current`   — in the predicted moveset: an active threat
 * - `alternate` — may be known instead of a predicted move (same-level ordering)
 * - `egg`       — an Egg Move some encounter methods add
 * - `upcoming`  — learned at a higher level
 * - `outgrown`  — learned earlier, since pushed out by newer moves
 */
export type RiskFlagStatus = 'current' | 'alternate' | 'egg' | 'upcoming' | 'outgrown';

export interface RiskFlag {
  slug: string;
  name: string;
  severity: RiskSeverity;
  category: RiskCategory;
  /** The data entry behind the flag (reason, detail, counter, …). */
  move: RiskMove;
  status: RiskFlagStatus;
  /** Level the move is learned at — always set for `upcoming`, null when not known. */
  level: number | null;
  /** One short human-readable line about this flag. */
  text: string;
}

export interface MovesetRisk {
  slug: string;
  name: string;
  /** Null when the move is harmless for this Pokémon in this generation. */
  risk: RiskFlag | null;
}

export interface RiskAnalysis {
  /** Worst severity among the moves of the CURRENT moveset; `none` when it is clean. */
  level: RiskLevel;
  /** One entry per move of the input moveset, in the same order. */
  moveset: MovesetRisk[];
  /** Risky moves of the current moveset, most severe first. */
  flags: RiskFlag[];
  /** Risky moves that might be present (`alternate` / `egg`), most severe first. */
  possible: RiskFlag[];
  /** Risky moves learned later, by ascending level ("learns Self-Destruct at Lv. 36"). */
  upcoming: RiskFlag[];
  /** Risky moves learned earlier that the predicted moveset no longer contains. */
  outgrown: RiskFlag[];
  /** Current-moveset flags per category id; every category of the data is present (0 when clear). */
  counts: Record<string, number>;
  /** Short lines for display: current threats first, then possible, upcoming and outgrown ones. */
  summary: string[];
  /** De-duplicated countermeasures for the current and possible threats, most severe first. */
  tips: string[];
}

export interface RiskAnalyzer {
  readonly data: RiskMoveData;
  /** Whether the move is listed at all, regardless of typing or generation. */
  isListed(slug: string): boolean;
  /** The entry that applies to this Pokémon and generation (the most severe if several do), or null. */
  lookup(slug: string, context: RiskContext): RiskMove | null;
  /** A category by id; null when the data does not define it. */
  category(id: string): RiskCategory | null;
  analyze(input: RiskAnalysisInput): RiskAnalysis;
}

function slugOf(move: MoveLike): string {
  return (typeof move === 'string' ? move : move.slug).trim().toLowerCase();
}

function levelOf(move: MoveLike): number | null {
  return typeof move !== 'string' && typeof move.level === 'number' && Number.isFinite(move.level)
    ? move.level
    : null;
}

function titleCase(id: string): string {
  return id
    .split('-')
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function appliesTo(move: RiskMove, types: ReadonlySet<string>, generation: number): boolean {
  if (move.requiresUserType && !types.has(move.requiresUserType.toLowerCase())) return false;
  // Without a usable generation, err on the side of warning.
  if (!Number.isFinite(generation)) return true;
  if (move.minGeneration !== undefined && generation < move.minGeneration) return false;
  if (move.maxGeneration !== undefined && generation > move.maxGeneration) return false;
  return true;
}

function describe(
  name: string,
  move: RiskMove,
  status: RiskFlagStatus,
  level: number | null,
): string {
  switch (status) {
    case 'current':
      return `${name}: ${move.reason}`;
    case 'alternate':
      return `May know ${name} instead of a listed move (learned at the same level).`;
    case 'egg':
      return `${name} is an Egg Move — special encounters can carry it.`;
    case 'upcoming':
      return level === null
        ? `Learns ${name} at a higher level.`
        : `Learns ${name} at Lv. ${level}.`;
    case 'outgrown':
      return `${name} was learned earlier and has been replaced by newer moves.`;
  }
}

/** Builds an analyzer over a risk-move dataset. Pure: the data is indexed once and never mutated. */
export function createRiskAnalyzer(data: RiskMoveData): RiskAnalyzer {
  const categories = new Map<string, RiskCategory>(
    data.categories.map((category) => [category.id, category]),
  );
  // A slug may have several entries with different type / generation conditions.
  const entries = new Map<string, RiskMove[]>();
  for (const move of data.moves) {
    const slug = move.slug.trim().toLowerCase();
    const bucket = entries.get(slug);
    if (bucket) bucket.push(move);
    else entries.set(slug, [move]);
  }

  const pick = (slug: string, types: ReadonlySet<string>, generation: number): RiskMove | null => {
    let best: RiskMove | null = null;
    for (const move of entries.get(slug) ?? []) {
      if (!appliesTo(move, types, generation)) continue;
      if (!best || compareSeverity(move.severity, best.severity) < 0) best = move;
    }
    return best;
  };

  const categoryOf = (move: RiskMove): RiskCategory =>
    categories.get(move.category) ?? {
      id: move.category,
      label: titleCase(move.category),
      description: '',
      severity: move.severity,
    };

  function analyze(input: RiskAnalysisInput): RiskAnalysis {
    const types = new Set(input.types.map((type) => type.trim().toLowerCase()));
    const { generation } = input;

    const flag = (slug: string, status: RiskFlagStatus, level: number | null): RiskFlag | null => {
      const move = pick(slug, types, generation);
      if (!move) return null;
      const name = move.name || moveName(slug);
      return {
        slug,
        name,
        severity: move.severity,
        category: categoryOf(move),
        move,
        status,
        level,
        text: describe(name, move, status, level),
      };
    };

    // Level each move was learned at, where the caller told us.
    const levels = new Map<string, number>();
    for (const move of [...input.moveset, ...(input.known ?? [])]) {
      const level = levelOf(move);
      const slug = slugOf(move);
      if (level !== null && !levels.has(slug)) levels.set(slug, level);
    }

    const current = new Set<string>();
    const moveset: MovesetRisk[] = [];
    const flags: RiskFlag[] = [];
    for (const move of input.moveset) {
      const slug = slugOf(move);
      if (slug === '') continue;
      const duplicate = current.has(slug);
      current.add(slug);
      const risk = flag(slug, 'current', levels.get(slug) ?? null);
      moveset.push({ slug, name: risk?.name ?? moveName(slug), risk });
      if (risk && !duplicate) flags.push(risk);
    }

    // Each list reports a move at most once, and never one that is already a current threat.
    const collect = (
      moves: readonly MoveLike[] | undefined,
      status: RiskFlagStatus,
      skip: ReadonlySet<string>,
    ): RiskFlag[] => {
      const found: RiskFlag[] = [];
      const seen = new Set<string>();
      for (const move of moves ?? []) {
        const slug = slugOf(move);
        if (slug === '' || seen.has(slug) || skip.has(slug)) continue;
        seen.add(slug);
        const level = status === 'upcoming' ? levelOf(move) : (levels.get(slug) ?? null);
        const risk = flag(slug, status, status === 'egg' ? null : level);
        if (risk) found.push(risk);
      }
      return found;
    };
    const slugs = (list: readonly RiskFlag[]): string[] => list.map((risk) => risk.slug);

    const alternates = collect(input.alternates, 'alternate', current);
    const eggs = collect(input.eggMoves, 'egg', new Set([...current, ...slugs(alternates)]));
    const possible = [...alternates, ...eggs];
    // Sorted so that a move listed at several levels is reported at the earliest one.
    const upcoming = collect(
      [...(input.upcoming ?? [])].sort((a, b) => a.level - b.level),
      'upcoming',
      current,
    );
    const outgrown = collect(
      input.known,
      'outgrown',
      new Set([...current, ...slugs(possible), ...slugs(upcoming)]),
    );

    const bySeverity = (a: RiskFlag, b: RiskFlag): number =>
      compareSeverity(a.severity, b.severity);
    flags.sort(bySeverity);
    possible.sort(bySeverity);

    const counts: Record<string, number> = {};
    for (const category of data.categories) counts[category.id] = 0;
    for (const risk of flags) counts[risk.category.id] = (counts[risk.category.id] ?? 0) + 1;

    const summary =
      flags.length > 0
        ? flags.map((risk) => risk.text)
        : ['No risk moves in the predicted moveset at this level.'];
    for (const risk of [...possible, ...upcoming, ...outgrown]) summary.push(risk.text);

    const tips: string[] = [];
    const seenTips = new Set<string>();
    for (const risk of [...flags, ...possible]) {
      const tip = risk.move.counter?.trim();
      if (!tip) continue;
      const key = tip.toLowerCase().replace(/[.\s]+$/, '');
      if (seenTips.has(key)) continue;
      seenTips.add(key);
      tips.push(tip);
    }

    return {
      level: flags[0]?.severity ?? 'none',
      moveset,
      flags,
      possible,
      upcoming,
      outgrown,
      counts,
      summary,
      tips,
    };
  }

  return {
    data,
    isListed: (slug) => entries.has(slug.trim().toLowerCase()),
    lookup: (slug, context) =>
      pick(
        slug.trim().toLowerCase(),
        new Set(context.types.map((type) => type.trim().toLowerCase())),
        context.generation,
      ),
    category: (id) => categories.get(id) ?? null,
    analyze,
  };
}

/** Analyzer bound to the bundled `riskMoves.json`. */
export const riskAnalyzer: RiskAnalyzer = createRiskAnalyzer(riskMoveData as RiskMoveData);

/**
 * Flags the risk moves of a predicted wild moveset using the bundled data:
 *
 *   const prediction = predictWildMoveset(detail, versionGroup, level);
 *   const risk = analyzeRisk({ ...prediction, moveset: prediction.moves, types: detail.types, generation });
 */
export function analyzeRisk(input: RiskAnalysisInput): RiskAnalysis {
  return riskAnalyzer.analyze(input);
}
