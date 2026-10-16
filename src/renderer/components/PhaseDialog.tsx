import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { LIMITS } from '@shared/defaults';
import { huntTotal, type Hunt, type PhaseEntry, type PhasePatch } from '@shared/types';
import { Button, EmptyState, Field, Modal, TextArea, Toggle } from '@renderer/components/ui';
import { formatCount, formatDateTime } from '@renderer/lib/format';
import { spriteUrl } from '@renderer/lib/sprites';
import { actions, toast, useHunt, useUiStore } from '@renderer/store';
import { registerMilestoneResolver } from './hunt/huntActions';
import { isUnidentified } from './hunt/huntStats';
import { SpeciesCombobox, SpeciesPreview, useSpeciesField } from './hunt/SpeciesCombobox';
import styles from './hunt/dialogs.module.css';

// This dialog is mounted for the whole session, so the milestone chime works on every view.
registerMilestoneResolver();

interface PhaseFormProps {
  hunt: Hunt;
  /** The phase being edited / identified; null to log a new one. */
  phase: PhaseEntry | null;
  onClose: () => void;
}

function PhaseForm({ hunt, phase, onClose }: PhaseFormProps) {
  const species = useSpeciesField(phase?.speciesName ?? '');
  const [notes, setNotes] = useState(phase?.notes ?? '');
  const [resetCount, setResetCount] = useState(true);
  const [saving, setSaving] = useState(false);

  const typedName = species.text.trim();
  const phaseNumber = phase
    ? hunt.phases.findIndex((entry) => entry.id === phase.id) + 1
    : hunt.phases.length + 1;
  const rollCount = phase ? phase.encounters : hunt.count;
  const total = phase ? phase.totalEncounters : huntTotal(hunt);

  const submit = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);

    const resolved = species.resolved;
    const speciesName = resolved?.name ?? typedName;
    const speciesFields = {
      speciesId: resolved?.species.id ?? null,
      speciesName,
      // A phase is a shiny: store its shiny sprite.
      spriteUrl: resolved ? spriteUrl(resolved.pokemonId, { style: 'pixel', shiny: true }) : null,
    };

    let saved: Hunt | null;
    if (phase) {
      // Untouched species text keeps whatever was stored (id, sprite) exactly as it was.
      const patch: PhasePatch =
        typedName === phase.speciesName.trim()
          ? { notes: notes.trim() }
          : { ...speciesFields, notes: notes.trim() };
      saved = await actions.updatePhase(hunt.id, phase.id, patch);
    } else {
      saved = await actions.logPhase(hunt.id, {
        ...speciesFields,
        notes: notes.trim(),
        resetCount,
      });
    }
    setSaving(false);
    if (!saved) return;

    if (phase) {
      // The sticky "identify it later" toast of a hotkey-logged phase has served its purpose.
      toast.dismiss(`phase-logged:${phase.id}`);
      toast.success('Phase updated', { description: speciesName || 'Still unidentified' });
    } else {
      toast.success(`Phase ${formatCount(phaseNumber)} logged`, {
        description: `${speciesName || 'Unidentified'} after ${formatCount(rollCount)} encounters`,
        action: { label: 'Undo', onClick: () => void actions.undoHunt(hunt.id) },
      });
    }
    onClose();
  };

  const title = phase ? (isUnidentified(phase) ? 'Identify phase' : 'Edit phase') : 'Log a phase';

  return (
    <Modal
      open
      onClose={onClose}
      tone="rare"
      icon={<Sparkles />}
      title={title}
      description={
        phase
          ? `Phase ${formatCount(phaseNumber)} of ${hunt.name}.`
          : `A shiny that is not your target — ${hunt.name}.`
      }
      onSubmit={() => void submit()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="rare" type="submit" loading={saving} leadingIcon={<Sparkles />}>
            {phase ? 'Save phase' : 'Log phase'}
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <Field
          label="Species"
          hint="Pick a result or keep any name as typed. Leave it empty to identify the phase later."
        >
          <SpeciesCombobox
            value={species.text}
            onValueChange={species.onValueChange}
            onSelect={species.onSelect}
            shiny
            autoFocus
            placeholder="Which shiny appeared?"
            emptyMessage="Not in the index — press Enter to keep it as typed"
            onEscape={onClose}
          />
        </Field>
        <SpeciesPreview
          result={species.resolved}
          text={species.text}
          shiny
          variant="phase"
          emptyLabel="Unidentified"
          freeTextLabel="Saved as typed — not in the species index"
        />

        <Field label="Notes">
          <TextArea
            value={notes}
            rows={2}
            maxLength={LIMITS.notes}
            placeholder="Route, ball, nature — anything worth remembering"
            onValueChange={setNotes}
          />
        </Field>

        <dl className={styles.readout} aria-label="What is recorded">
          <div className={styles.readoutItem}>
            <dt>Phase</dt>
            <dd>#{formatCount(phaseNumber)}</dd>
          </div>
          <div className={styles.readoutItem}>
            <dt>Roll count</dt>
            <dd>{formatCount(rollCount)}</dd>
          </div>
          <div className={styles.readoutItem}>
            <dt>Total</dt>
            <dd>{formatCount(total)}</dd>
          </div>
        </dl>

        {phase ? (
          <p className={styles.note}>
            Logged {formatDateTime(phase.timestamp)}. The counts were fixed when the phase was
            logged.
          </p>
        ) : (
          <>
            <Toggle
              checked={resetCount}
              label="Start a new phase (reset the counter)"
              description={
                resetCount
                  ? `The counter returns to 0; the total stays at ${formatCount(total)}.`
                  : 'The counter keeps running from its current value.'
              }
              onChange={setResetCount}
            />
            {rollCount === 0 ? (
              <p className={styles.note} data-tone="warn">
                This phase has no encounters yet — it will be logged with a roll count of 0.
              </p>
            ) : null}
          </>
        )}
      </div>
    </Modal>
  );
}

/**
 * The global phase dialog: logs a non-target shiny for a hunt, or identifies /
 * edits an already logged phase. The app shell mounts it once; it takes no
 * props and is driven entirely by `useUiStore().phaseDialog`
 * (`{ open, huntId, phaseId? }` — `phaseId` present means "edit that phase").
 *
 * Keyboard-first: the species field has focus, Enter saves, Escape cancels.
 */
export default function PhaseDialog() {
  const phaseDialog = useUiStore((state) => state.phaseDialog);
  const closePhaseDialog = useUiStore((state) => state.closePhaseDialog);
  const hunt = useHunt(phaseDialog.huntId);

  if (!phaseDialog.open) return null;

  const { phaseId } = phaseDialog;
  const phase =
    phaseId === undefined ? null : (hunt?.phases.find((entry) => entry.id === phaseId) ?? null);

  // The hunt or the phase was deleted (possibly from another window) while the dialog was on its way.
  if (hunt === null || (phaseId !== undefined && phase === null)) {
    return (
      <Modal
        open
        onClose={closePhaseDialog}
        tone="rare"
        size="sm"
        icon={<Sparkles />}
        title={hunt === null ? 'Hunt not found' : 'Phase not found'}
        footer={
          <Button variant="secondary" data-autofocus="" onClick={closePhaseDialog}>
            Close
          </Button>
        }
      >
        <EmptyState
          size="sm"
          tone="violet"
          icon={<Sparkles />}
          title="Nothing to edit here"
          description="It has been deleted in the meantime."
        />
      </Modal>
    );
  }

  return (
    <PhaseForm
      key={`${hunt.id}:${phase?.id ?? 'new'}`}
      hunt={hunt}
      phase={phase}
      onClose={closePhaseDialog}
    />
  );
}
