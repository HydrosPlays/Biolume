/**
 * Pure derivations behind the Hunt view, the phase dialog and the Log view.
 *
 * Nothing here touches React or the store: every function maps domain objects
 * (hunts, phases, sessions) to the numbers and labels the views print, so the
 * arithmetic is testable on its own.
 */
import {
  huntTotal,
  type ExportDataset,
  type ExportFormat,
  type Hunt,
  type HuntChange,
  type HuntStatus,
  type ImportResult,
  type PhaseEntry,
  type SessionRecord,
  type TargetRef,
} from '@shared/types';
import type { Tone } from '@renderer/components/ui/internal/types';
import { EMPTY_VALUE, formatCount } from '@renderer/lib/format';
import type { OddsResult } from '@renderer/lib/odds';
import { oddsEngine } from '@renderer/lib/oddsData';
import {
  cumulativeProbability,
  encountersForProbability,
  luckVerdict,
  type LuckVerdict,
} from '@renderer/lib/probability';
import { spriteCandidates, spriteUrl } from '@renderer/lib/sprites';

// ───────────────────────────── Odds ─────────────────────────────

/** The odds engine's result for a hunt, or null when the engine cannot evaluate it. */
export function huntOdds(hunt: Pick<Hunt, 'odds'>): OddsResult | null {
  try {
    return oddsEngine.compute(hunt.odds);
  } catch {
    return null;
  }
}

/** Per-encounter shiny probability (0–1) of a hunt; null when unknown or zero. */
export function huntProbability(hunt: Pick<Hunt, 'odds'>): number | null {
  const probability = huntOdds(hunt)?.perEncounter;
  return typeof probability === 'number' && Number.isFinite(probability) && probability > 0
    ? Math.min(probability, 1)
    : null;
}

// ───────────────────────────── Live hunt stats ─────────────────────────────

/** The cumulative-probability marks the counter tracks. */
export const HUNT_MILESTONES: readonly number[] = [0.5, 0.9, 0.99];

export interface MilestoneProgress {
  /** Target cumulative probability, 0–1. */
  probability: number;
  /** Total encounters at which it is reached; `Infinity` when the odds are unknown. */
  encounters: number;
  /** Encounters still to go; 0 once reached. */
  remaining: number;
  reached: boolean;
}

export interface HuntStats {
  /** Encounters in the current phase. */
  count: number;
  /** Encounters across every phase — what all probabilities are based on. */
  total: number;
  /** 1-based number of the phase being hunted right now. */
  phaseNumber: number;
  phasesLogged: number;
  /** Per-encounter probability used, 0 when unknown. */
  probability: number;
  /** Chance of having found the shiny within `total` encounters, 0–1. */
  cumulative: number;
  verdict: LuckVerdict;
  /** `total × p` — 1 is exactly "at odds", 2 is twice over odds. */
  oddsRatio: number;
  milestones: MilestoneProgress[];
  /** The first milestone not reached yet; null past the last one or with unknown odds. */
  next: MilestoneProgress | null;
  elapsedMs: number;
  /** Encounters per hour of active hunting; null until there is enough time on the clock. */
  perHour: number | null;
}

/** Below this much tracked time a rate is noise (three clicks in two seconds is not 5,400 / h). */
export const MIN_RATE_WINDOW_MS = 30_000;

const MS_PER_HOUR = 3_600_000;

/** Encounters per hour, or null when the inputs cannot give a meaningful rate. */
export function encountersPerHour(encounters: number, elapsedMs: number): number | null {
  if (!Number.isFinite(encounters) || !Number.isFinite(elapsedMs)) return null;
  if (encounters <= 0 || elapsedMs < MIN_RATE_WINDOW_MS) return null;
  return encounters / (elapsedMs / MS_PER_HOUR);
}

/**
 * Everything the stats strip shows for a hunt at per-encounter probability
 * `probability` (pass 0 / NaN when unknown). Luck and milestones are judged on
 * the TOTAL across phases: a phase reset does not make the target any likelier.
 */
export function deriveHuntStats(
  hunt: Pick<Hunt, 'count' | 'priorCount' | 'phases' | 'elapsedMs'>,
  probability: number | null | undefined,
): HuntStats {
  const p =
    typeof probability === 'number' && Number.isFinite(probability) && probability > 0
      ? Math.min(probability, 1)
      : 0;
  const total = Math.max(0, huntTotal(hunt));
  const cumulative = cumulativeProbability(p, total);

  const milestones = HUNT_MILESTONES.map((target): MilestoneProgress => {
    const encounters = encountersForProbability(p, target);
    const reached = total >= encounters;
    return {
      probability: target,
      encounters,
      remaining: reached ? 0 : encounters - total,
      reached,
    };
  });
  const next =
    milestones.find((entry) => !entry.reached && Number.isFinite(entry.encounters)) ?? null;
  const elapsedMs = Math.max(0, Number.isFinite(hunt.elapsedMs) ? hunt.elapsedMs : 0);

  return {
    count: Math.max(0, hunt.count),
    total,
    phaseNumber: hunt.phases.length + 1,
    phasesLogged: hunt.phases.length,
    probability: p,
    cumulative,
    verdict: luckVerdict(cumulative),
    oddsRatio: total * p,
    milestones,
    next,
    elapsedMs,
    perHour: encountersPerHour(total, elapsedMs),
  };
}

/** `0.42×`, `1.80×`, `12.5×`, `240×`; an em dash while there is nothing to compare. */
export function formatOddsRatio(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return EMPTY_VALUE;
  if (ratio < 10) return `${ratio.toFixed(2)}×`;
  if (ratio < 100) return `${ratio.toFixed(1)}×`;
  return `${formatCount(ratio)}×`;
}

/** Whole encounters per hour for display: `312 / h`. */
export function formatRate(perHour: number | null): string {
  return perHour === null ? EMPTY_VALUE : `${formatCount(perHour)} / h`;
}

/**
 * Colour family of a luck verdict. Bad luck is not an error: deep-over-odds
 * hunts read as rare (violet / magenta), never as danger. Gold stays reserved
 * for actual shinies.
 */
export function luckTone(verdict: LuckVerdict): Tone {
  switch (verdict) {
    case 'very-lucky':
    case 'lucky':
      return 'teal';
    case 'average':
      return 'accent';
    case 'unlucky':
      return 'violet';
    case 'very-unlucky':
      return 'magenta';
    case 'unknown':
      return 'neutral';
  }
}

// ───────────────────────────── Counter feedback ─────────────────────────────

/**
 * Which way the on-screen count moved for a hunt change, or null when the
 * change did not touch it (edits, phase notes, a set-count to the same value).
 * Logging a phase resets the counter, so it reads as a move down.
 */
export function countChangeDirection(change: HuntChange): 'up' | 'down' | null {
  switch (change.kind) {
    case 'increment':
    case 'decrement':
    case 'set-count':
    case 'undo':
      if (change.delta > 0) return 'up';
      if (change.delta < 0) return 'down';
      return null;
    case 'phase-logged':
      return 'down';
    default:
      return null;
  }
}

/**
 * Width of a formatted count in digit-widths, used to fit the hero numeral to
 * its column: digits count 1, group separators and other glyphs 0.45. Never
 * below 3, so single digits do not balloon past the display size.
 */
export function countGlyphUnits(text: string): number {
  let units = 0;
  for (const char of text) units += char >= '0' && char <= '9' ? 1 : 0.45;
  return Math.max(3, Math.round(units * 100) / 100);
}

// ───────────────────────────── Names & sprites ─────────────────────────────

/** Display name of a phase's species; quick-logged phases have none yet. */
export function phaseDisplayName(phase: Pick<PhaseEntry, 'speciesName'>): string {
  const name = phase.speciesName.trim();
  return name === '' ? 'Unidentified' : name;
}

export function isUnidentified(phase: Pick<PhaseEntry, 'speciesName'>): boolean {
  return phase.speciesName.trim() === '';
}

/** Default name offered for a new hunt. */
export function suggestHuntName(targetName: string | null | undefined): string {
  const name = targetName?.trim() ?? '';
  return name === '' ? 'New hunt' : `Shiny ${name}`;
}

/** Sprite candidates for a logged phase: what was stored, then the shiny pixel sprite of its species. */
export function phaseSpriteSources(
  phase: Pick<PhaseEntry, 'spriteUrl' | 'speciesId'>,
): (string | null)[] {
  return [
    phase.spriteUrl,
    phase.speciesId === null ? null : spriteUrl(phase.speciesId, { style: 'pixel', shiny: true }),
  ];
}

/** Large shiny art for the hero (HOME render first), ending on the snapshot stored with the hunt. */
export function heroSpriteSources(target: TargetRef | null): (string | null)[] {
  if (!target) return [];
  return [
    ...spriteCandidates(target.pokemonId, { shiny: true, style: 'home' }),
    target.shinySpriteUrl,
  ];
}

/** Small shiny sprite for lists and pickers. */
export function listSpriteSources(target: TargetRef | null): (string | null)[] {
  if (!target) return [];
  return [target.shinySpriteUrl, spriteUrl(target.pokemonId, { style: 'pixel', shiny: true })];
}

// ───────────────────────────── Hunt lists ─────────────────────────────

function timeOf(iso: string | null | undefined): number {
  if (!iso) return 0;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? time : 0;
}

export interface HuntGroups {
  active: Hunt[];
  completed: Hunt[];
  archived: Hunt[];
}

/** Hunts by status, most recently touched first within each group. */
export function groupHunts(hunts: readonly Hunt[]): HuntGroups {
  const groups: HuntGroups = { active: [], completed: [], archived: [] };
  for (const hunt of hunts) groups[hunt.status].push(hunt);
  const byRecency = (a: Hunt, b: Hunt): number => timeOf(b.updatedAt) - timeOf(a.updatedAt);
  groups.active.sort(byRecency);
  groups.completed.sort(
    (a, b) => timeOf(b.completedAt ?? b.updatedAt) - timeOf(a.completedAt ?? a.updatedAt),
  );
  groups.archived.sort(byRecency);
  return groups;
}

/** The status a hunt returns to when it is taken out of the archive. */
export function restoredStatus(hunt: Pick<Hunt, 'completedAt'>): HuntStatus {
  return hunt.completedAt === null ? 'active' : 'completed';
}

// ───────────────────────────── Phase log ─────────────────────────────

export interface PhaseRow {
  /** Unique across hunts. */
  key: string;
  huntId: string;
  huntName: string;
  targetName: string | null;
  /** 1-based position within its hunt. */
  phaseNumber: number;
  phase: PhaseEntry;
}

/** Every phase of `hunts` (optionally of one hunt), newest first. */
export function flattenPhases(hunts: readonly Hunt[], huntId?: string | null): PhaseRow[] {
  const rows: PhaseRow[] = [];
  for (const hunt of hunts) {
    if (huntId && hunt.id !== huntId) continue;
    hunt.phases.forEach((phase, index) => {
      rows.push({
        key: `${hunt.id}:${phase.id}`,
        huntId: hunt.id,
        huntName: hunt.name,
        targetName: hunt.target?.name ?? null,
        phaseNumber: index + 1,
        phase,
      });
    });
  }
  return rows.sort(
    (a, b) =>
      timeOf(b.phase.timestamp) - timeOf(a.phase.timestamp) || b.phaseNumber - a.phaseNumber,
  );
}

// ───────────────────────────── Sessions ─────────────────────────────

/** Length of a session: first to last counter activity. */
export function sessionDurationMs(session: Pick<SessionRecord, 'startedAt' | 'endedAt'>): number {
  return Math.max(0, timeOf(session.endedAt) - timeOf(session.startedAt));
}

export interface SessionTotals {
  sessions: number;
  durationMs: number;
  encounters: number;
  phases: number;
  perHour: number | null;
}

export function sessionTotals(sessions: readonly SessionRecord[]): SessionTotals {
  let durationMs = 0;
  let encounters = 0;
  let phases = 0;
  for (const session of sessions) {
    durationMs += sessionDurationMs(session);
    encounters += session.encounters;
    phases += session.phasesLogged;
  }
  return {
    sessions: sessions.length,
    durationMs,
    encounters,
    phases,
    perHour: encountersPerHour(encounters, durationMs),
  };
}

// ───────────────────────────── Export / import ─────────────────────────────

/** Formats a dataset can be exported in — a full backup is JSON only. */
export function exportFormatsFor(dataset: ExportDataset): ExportFormat[] {
  return dataset === 'backup' ? ['json'] : ['json', 'csv'];
}

/** The format actually used for a dataset, given what the user last picked. */
export function resolveExportFormat(dataset: ExportDataset, preferred: ExportFormat): ExportFormat {
  return exportFormatsFor(dataset).includes(preferred) ? preferred : 'json';
}

/** Total records an import brought in, across every kind. */
export function importedTotal(result: Pick<ImportResult, 'imported'>): number {
  const { hunts, phases, sessions, targets } = result.imported;
  return hunts + phases + sessions + targets;
}

export type ImportOutcome = 'canceled' | 'unrecognised' | 'clean' | 'partial' | 'nothing';

/** How an import went, for picking the tone and headline of the result card. */
export function importOutcome(result: ImportResult): ImportOutcome {
  if (result.canceled) return 'canceled';
  if (result.dataset === null) return 'unrecognised';
  const total = importedTotal(result);
  if (total === 0) return 'nothing';
  return result.skipped > 0 || result.errors.length > 0 ? 'partial' : 'clean';
}
