/**
 * View-model helpers for the Odds view: the curve that the chart and the
 * milestones table share, the hunter's pace, and the option lists of the
 * game / method dropdowns. Pure — the components only lay the results out.
 */
import { FULL_ODDS_METHOD_ID } from '@shared/defaults';
import type { OddsSelection, SessionRecord } from '@shared/types';
import type { GameDef, MethodDef, NumberInput } from '@renderer/data/schema';
import type { OddsEngine } from '@renderer/lib/odds';
import {
  CURVE_FALLBACK_MAX_N,
  CURVE_MAX_N_CAP,
  buildCurve,
  buildVaryingCurve,
  cumulativeProbability,
  cumulativeVarying,
  encountersForProbability,
  encountersForProbabilityVarying,
  type CurvePoint,
} from '@renderer/lib/probability';

// ───────────────────────────── Curve ─────────────────────────────

/** `constant`: every encounter has today's odds. `chain`: the chain starts over and grows by one per encounter. */
export type CurveMode = 'constant' | 'chain';

export const CURVE_POINTS = 160;
/** Longest chain ramp evaluated for the "chain builds as you go" mode. */
export const MAX_RAMP_LENGTH = 10_000;
/** Probabilities the chart marks with dashed lines. */
export const CHART_MILESTONES: readonly number[] = [0.5, 0.9, 0.99];

export interface CurveModel {
  mode: CurveMode;
  /** Last encounter count on the x axis. */
  maxN: number;
  curve: CurvePoint[];
  /** The game's plain full-odds curve over the same range; null when it would coincide with `curve`. */
  comparison: CurvePoint[] | null;
  /** Cumulative probability of at least one shiny within `n` encounters. */
  probabilityAt(n: number): number;
  comparisonAt: ((n: number) => number) | null;
  /** Encounters needed to reach cumulative probability `q` (`Infinity` when unreachable). */
  encountersFor(q: number): number;
}

export interface CurveModelInput {
  /** Per-encounter odds of the current selection. */
  perEncounter: number;
  /** The game's plain base odds per Pokémon. */
  baseProbability: number;
  /** Per-encounter odds of a chain built from scratch; switches the model to `chain` mode. */
  ramp?: readonly number[] | null;
  /** The hunt's total encounters — the x-range always includes it. */
  total?: number;
  points?: number;
}

/** The shared model behind the chart and the milestones table. */
export function buildCurveModel({
  perEncounter,
  baseProbability,
  ramp = null,
  total = 0,
  points = CURVE_POINTS,
}: CurveModelInput): CurveModel {
  const varying = ramp !== null && ramp.length > 0 ? ramp : null;
  const probabilityAt = (n: number): number =>
    varying ? cumulativeVarying(varying, n) : cumulativeProbability(perEncounter, n);
  const encountersFor = (q: number): number =>
    varying
      ? encountersForProbabilityVarying(varying, q)
      : encountersForProbability(perEncounter, q);

  const q99 = encountersFor(0.99);
  const reach = Number.isFinite(q99) ? q99 : CURVE_FALLBACK_MAX_N;
  const position = Number.isFinite(total) && total > 0 ? Math.ceil(total * 1.08) : 0;
  const maxN = Math.min(CURVE_MAX_N_CAP, Math.max(10, Math.ceil(reach), position));

  const options = { maxN, points };
  const curve = varying ? buildVaryingCurve(varying, options) : buildCurve(perEncounter, options);

  // Worth drawing only when the method actually moves away from full odds.
  const differs =
    varying !== null ||
    Math.abs(perEncounter - baseProbability) > Math.max(perEncounter, baseProbability) * 1e-6;
  const showComparison = differs && baseProbability > 0;

  return {
    mode: varying ? 'chain' : 'constant',
    maxN,
    curve,
    comparison: showComparison ? buildCurve(baseProbability, options) : null,
    probabilityAt,
    comparisonAt: showComparison ? (n) => cumulativeProbability(baseProbability, n) : null,
    encountersFor,
  };
}

/** The selection with its chain input at the minimum — what a chain ramp depends on. */
export function chainBaseSelection(selection: OddsSelection, chain: NumberInput): OddsSelection {
  return {
    ...selection,
    inputs: { ...selection.inputs, [chain.id]: Math.min(chain.min, chain.max) },
  };
}

/**
 * Per-encounter odds of a chain started from its minimum and growing by one
 * each encounter, up to the input's maximum (capped at {@link MAX_RAMP_LENGTH};
 * the last value then repeats, which is how the probability helpers read it).
 */
export function chainRamp(
  engine: OddsEngine,
  selection: OddsSelection,
  chain: NumberInput,
): number[] {
  const min = Math.min(chain.min, chain.max);
  const max = Math.max(chain.min, chain.max);
  const length = Math.min(MAX_RAMP_LENGTH, Math.floor(max - min) + 1);
  return engine.chainProbabilities(selection, chain.id, length, min);
}

/**
 * The chain value at which the odds change for the last time — the point of
 * dragging a slider any further. Null when the chain never changes the odds
 * or is still changing where the ramp ends.
 */
export function chainPlateau(ramp: readonly number[], chain: NumberInput): number | null {
  let lastChange = 0;
  for (let i = 1; i < ramp.length; i++) {
    if (ramp[i] !== ramp[i - 1]) lastChange = i;
  }
  if (lastChange === 0 || lastChange >= ramp.length - 1) return null;
  return Math.min(chain.min, chain.max) + lastChange;
}

// ───────────────────────────── Pace ─────────────────────────────

export interface Pace {
  /** Encounters per hour of active hunting. */
  perHour: number;
  /** Sessions the rate was measured over. */
  sessions: number;
  /** `hunt`: this hunt's own sessions; `all`: every recorded session (no usable history for this hunt yet). */
  scope: 'hunt' | 'all';
}

/** A session shorter than this says nothing about pace (a couple of quick taps). */
const MIN_SESSION_MS = 30_000;
/** Total measured time needed before a rate is trusted. */
const MIN_PACE_MS = 2 * 60_000;

function measure(sessions: readonly SessionRecord[]): {
  encounters: number;
  ms: number;
  count: number;
} {
  let encounters = 0;
  let ms = 0;
  let count = 0;
  for (const session of sessions) {
    const duration = Date.parse(session.endedAt) - Date.parse(session.startedAt);
    if (!Number.isFinite(duration) || duration < MIN_SESSION_MS || !(session.encounters > 0))
      continue;
    encounters += session.encounters;
    ms += duration;
    count++;
  }
  return { encounters, ms, count };
}

/**
 * The hunter's encounters-per-hour rate from recorded sessions: this hunt's
 * own sessions when they cover enough time, every session otherwise. Null
 * while there is too little history to say.
 */
export function paceFromSessions(
  sessions: readonly SessionRecord[],
  huntId: string | null,
): Pace | null {
  const scopes: [Pace['scope'], readonly SessionRecord[]][] = [];
  if (huntId !== null) {
    scopes.push(['hunt', sessions.filter((session) => session.huntId === huntId)]);
  }
  scopes.push(['all', sessions]);

  for (const [scope, candidates] of scopes) {
    const { encounters, ms, count } = measure(candidates);
    if (ms >= MIN_PACE_MS && encounters > 0) {
      return { perHour: encounters / (ms / 3_600_000), sessions: count, scope };
    }
  }
  return null;
}

/** Milliseconds `encounters` take at a pace; `Infinity` for unreachable counts. */
export function timeAtPace(encounters: number, pace: Pace): number {
  if (!Number.isFinite(encounters) || !(pace.perHour > 0)) return Infinity;
  return (Math.max(0, encounters) / pace.perHour) * 3_600_000;
}

// ───────────────────────────── Selection changes ─────────────────────────────

/** Switching game keeps the method when the new game has one with the same id, else falls back to full odds. */
export function selectionForGame(
  engine: OddsEngine,
  selection: OddsSelection,
  gameId: string,
): OddsSelection {
  const keepsMethod = engine.getMethod(gameId, selection.methodId) !== undefined;
  return keepsMethod
    ? engine.updateSelection(selection, { gameId })
    : engine.normalizeSelection({
        ...engine.defaultSelection(gameId, FULL_ODDS_METHOD_ID),
        shinyCharm: selection.shinyCharm,
      });
}

/** Switching method starts from the new method's defaults (stale inputs say nothing about it) and keeps the charm. */
export function selectionForMethod(
  engine: OddsEngine,
  selection: OddsSelection,
  methodId: string,
): OddsSelection {
  return engine.normalizeSelection({
    ...engine.defaultSelection(selection.gameId, methodId),
    shinyCharm: selection.shinyCharm,
  });
}

/** Why the Shiny Charm toggle is unavailable, or null when it can be used. */
export function charmBlockedReason(game: GameDef, method: MethodDef): string | null {
  if (game.shinyCharmRolls === null) return `${game.name} has no Shiny Charm.`;
  if (!method.charmApplies) return `The Shiny Charm does not affect ${method.name}.`;
  return null;
}

/** `Nintendo Switch / Nintendo Switch 2` → `Switch / Switch 2`: the maker is noise in a dropdown. */
export function shortPlatform(platform: string): string {
  return platform.replaceAll('Nintendo ', '');
}
