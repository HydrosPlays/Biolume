/**
 * Audio feedback for counter activity.
 *
 * Sounds are driven by `store.lastChange`, i.e. by events from the main
 * process — so a count made with a global hotkey while the game has focus is
 * just as audible as a click on the counter. Only the main window plays them:
 * the overlay receives the same events and would otherwise double every sound.
 */
import { useEffect } from 'react';
import { huntTotal, type Hunt, type HuntChange } from '@shared/types';
import { playSound, primeAudio, type SoundKind } from '@renderer/lib/audio';
import { selectHunt, useAppStore } from '@renderer/store/appStore';

/** Odds milestones a hunt can cross, in the order they are reached. */
export type Milestone = 'half' | 'over-odds' | 'ninety';

/**
 * Per-encounter shiny probability (0–1) of a hunt, or null when unknown.
 * Supplied by the odds engine through {@link setMilestoneOddsResolver}.
 */
export type MilestoneOddsResolver = (hunt: Hunt) => number | null | undefined;

let registeredResolver: MilestoneOddsResolver | null = null;

/**
 * Registers how to turn a hunt into its per-encounter shiny probability, which
 * enables the milestone chime (`settings.audio.milestoneChime`). The platform
 * layer does not know the odds engine, so the odds module wires itself in once:
 *
 *   setMilestoneOddsResolver((hunt) => computeOdds(hunt.odds)?.probability ?? null);
 */
export function setMilestoneOddsResolver(resolver: MilestoneOddsResolver | null): void {
  registeredResolver = resolver;
}

/**
 * The furthest milestone crossed when a hunt's total goes from `previousTotal`
 * to `nextTotal` at per-encounter probability `probability`, or null.
 *   - `half`      — cumulative chance reaches 50 %
 *   - `over-odds` — encounters reach the odds denominator (1 / p)
 *   - `ninety`    — cumulative chance reaches 90 %
 */
export function detectMilestone(
  previousTotal: number,
  nextTotal: number,
  probability: number,
): Milestone | null {
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) return null;
  if (nextTotal <= previousTotal) return null;

  const encountersFor = (chance: number): number =>
    Math.ceil(Math.log(1 - chance) / Math.log(1 - probability));
  const thresholds: [Milestone, number][] = [
    ['ninety', encountersFor(0.9)],
    ['over-odds', Math.ceil(1 / probability)],
    ['half', encountersFor(0.5)],
  ];
  for (const [milestone, threshold] of thresholds) {
    if (previousTotal < threshold && nextTotal >= threshold) return milestone;
  }
  return null;
}

/** The sound a hunt change deserves, or null for silent changes (edits, imports, …). */
export function soundForChange(change: HuntChange): SoundKind | null {
  if (change.source === 'import' || change.source === 'system') return null;
  switch (change.kind) {
    case 'increment':
      return 'increment';
    case 'decrement':
    case 'undo':
      return 'decrement';
    case 'phase-logged':
      return 'phase';
    case 'completed':
      return 'complete';
    default:
      return null;
  }
}

export interface CounterFeedbackOptions {
  /** Overrides the resolver registered with {@link setMilestoneOddsResolver}. */
  resolveOdds?: MilestoneOddsResolver;
}

/** Delay before the milestone chime so it lands just after the count tick instead of masking it. */
const MILESTONE_DELAY_MS = 150;

/** Plays counter sounds for this window. Mount once in the main window; a no-op in the overlay. */
export function useCounterFeedback({ resolveOdds }: CounterFeedbackOptions = {}): void {
  useEffect(() => {
    if (window.biolume.windowKind !== 'main') return undefined;

    // Chromium may keep a fresh AudioContext suspended until the first gesture.
    const prime = (): void => primeAudio();
    window.addEventListener('pointerdown', prime, { once: true, capture: true });
    window.addEventListener('keydown', prime, { once: true, capture: true });

    let milestoneTimer: number | undefined;

    // A direct store subscription (not a render effect): it must fire while the
    // window is hidden or minimised, when React may defer rendering.
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      const { lastChange } = state;
      if (!lastChange || lastChange === previous.lastChange) return;

      const kind = soundForChange(lastChange.change);
      if (kind === null) return;
      const { audio } = state.settings;
      playSound(kind, audio);

      if (kind !== 'increment' || !audio.enabled || !audio.milestoneChime) return;
      const resolver = resolveOdds ?? registeredResolver;
      const hunt = selectHunt(state, lastChange.huntId);
      if (!resolver || !hunt) return;

      let probability: number | null | undefined;
      try {
        probability = resolver(hunt);
      } catch {
        probability = null;
      }
      if (typeof probability !== 'number') return;

      const total = huntTotal(hunt);
      if (detectMilestone(total - lastChange.change.delta, total, probability) !== null) {
        window.clearTimeout(milestoneTimer);
        milestoneTimer = window.setTimeout(
          () => playSound('milestone', useAppStore.getState().settings.audio),
          MILESTONE_DELAY_MS,
        );
      }
    });

    return () => {
      unsubscribe();
      window.clearTimeout(milestoneTimer);
      window.removeEventListener('pointerdown', prime, true);
      window.removeEventListener('keydown', prime, true);
    };
  }, [resolveOdds]);
}
