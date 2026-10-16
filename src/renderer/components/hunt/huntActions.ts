/**
 * Compound hunt operations shared by the Hunt view, the hunt manager and the
 * Log view: the store action plus its confirmation and its toast. Like the
 * store actions they never reject.
 */
import { huntTotal, type Hunt, type PhaseEntry } from '@shared/types';
import { setMilestoneOddsResolver } from '@renderer/hooks/useCounterFeedback';
import { formatCount } from '@renderer/lib/format';
import { actions, toast, useAppStore } from '@renderer/store';
import { groupHunts, huntProbability, phaseDisplayName, restoredStatus } from './huntStats';

let resolverRegistered = false;

/**
 * Teaches the audio feedback how to read a hunt's odds, which enables the
 * milestone chime. Idempotent — called at module load by the Hunt view and the
 * phase dialog (the latter is always mounted, so the chime works on any view).
 */
export function registerMilestoneResolver(): void {
  if (resolverRegistered) return;
  resolverRegistered = true;
  setMilestoneOddsResolver((hunt) => huntProbability(hunt));
}

function undoAction(huntId: string): { label: string; onClick: () => void } {
  return { label: 'Undo', onClick: () => void actions.undoHunt(huntId) };
}

/** Sets the current phase back to zero, after asking. */
export async function resetPhaseCount(hunt: Hunt): Promise<void> {
  if (hunt.count === 0) return;
  const confirmed = await actions.confirmDestructive({
    title: 'Reset the phase count?',
    message: `The current phase goes back to 0 (it is at ${formatCount(hunt.count)}). Earlier phases keep their encounters, and Undo brings the count back.`,
    confirmLabel: 'Reset to 0',
  });
  if (!confirmed) return;
  const updated = await actions.setCount(hunt.id, 0);
  if (updated) toast.info('Phase count reset', { action: undoAction(hunt.id) });
}

/** Removes one logged phase, after asking. */
export async function deletePhase(
  hunt: Pick<Hunt, 'id' | 'name'>,
  phase: PhaseEntry,
): Promise<void> {
  const confirmed = await actions.confirmDestructive({
    title: 'Delete this phase?',
    message: `${phaseDisplayName(phase)} (${formatCount(phase.encounters)} encounters) is removed from the log of "${hunt.name}".`,
    confirmLabel: 'Delete phase',
  });
  if (!confirmed) return;
  const updated = await actions.removePhase(hunt.id, phase.id);
  if (updated) toast.success('Phase deleted');
}

/** Deletes a hunt with everything logged on it, after asking. */
export async function deleteHunt(hunt: Hunt): Promise<void> {
  const total = huntTotal(hunt);
  const confirmed = await actions.confirmDestructive({
    title: `Delete "${hunt.name}"?`,
    message:
      total > 0 || hunt.phases.length > 0
        ? `Its ${formatCount(total)} encounters and ${formatCount(hunt.phases.length)} logged phases are deleted for good. Archive it instead to keep the history.`
        : 'This hunt has no encounters yet. It is deleted for good.',
    confirmLabel: 'Delete hunt',
  });
  if (!confirmed) return;
  if (await actions.removeHunt(hunt.id)) toast.success('Hunt deleted');
}

/**
 * Moves a hunt to the archive. When it was the active one, the most recently
 * used other active hunt takes over (or none), so the counter never keeps
 * pointing at a shelved hunt.
 */
export async function archiveHunt(hunt: Hunt): Promise<void> {
  const updated = await actions.updateHunt(hunt.id, { status: 'archived' });
  if (!updated) return;
  const state = useAppStore.getState();
  if (state.activeHuntId === hunt.id) {
    const successor = groupHunts(state.hunts).active.find((entry) => entry.id !== hunt.id);
    await actions.setActiveHunt(successor?.id ?? null);
  }
  toast.info('Hunt archived', {
    description: hunt.name,
    action: { label: 'Restore', onClick: () => void restoreHunt(hunt) },
  });
}

/** Takes a hunt out of the archive, back to active (or completed, if it was finished). */
export async function restoreHunt(hunt: Hunt): Promise<void> {
  const updated = await actions.updateHunt(hunt.id, { status: restoredStatus(hunt) });
  if (updated) toast.success('Hunt restored', { description: hunt.name });
}

/** Marks the hunt as finished: the target shiny appeared. */
export async function completeHunt(hunt: Hunt): Promise<void> {
  const completed = await actions.completeHunt(hunt.id);
  if (!completed) return;
  // A misclick on the gold button must be one press away from undone.
  toast.success('Shiny found!', {
    id: `hunt-completed:${hunt.id}`,
    description: `${hunt.name} · ${formatCount(huntTotal(completed))} encounters`,
    action: undoAction(hunt.id),
  });
}

/** Puts a finished hunt back in play. */
export async function reopenHunt(hunt: Hunt): Promise<void> {
  const updated = await actions.reopenHunt(hunt.id);
  if (!updated) return;
  // The "Shiny found!" toast offers an Undo that no longer applies.
  toast.dismiss(`hunt-completed:${hunt.id}`);
  toast.info('Hunt reopened', { description: `${hunt.name} is counting again.` });
}
