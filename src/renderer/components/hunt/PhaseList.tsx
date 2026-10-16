import { ArrowUpRight, Layers, Pencil, Sparkles, Trash2 } from 'lucide-react';
import type { Hunt } from '@shared/types';
import { Button, EmptyState, IconButton, Panel, Sprite } from '@renderer/components/ui';
import { navigate } from '@renderer/hooks/useView';
import { formatCount, formatDateTime, formatRelativeTime } from '@renderer/lib/format';
import { useUiStore } from '@renderer/store';
import { deletePhase } from './huntActions';
import { isUnidentified, phaseDisplayName, phaseSpriteSources } from './huntStats';
import styles from './hunt.module.css';

export interface PhaseListProps {
  hunt: Hunt;
  /** How many of the most recent phases to list. Default 5. */
  limit?: number;
}

/** The hunt's most recent phases, newest first, with edit and delete. The full history lives in the Log view. */
export function PhaseList({ hunt, limit = 5 }: PhaseListProps) {
  const openPhaseDialog = useUiStore((state) => state.openPhaseDialog);
  const recent = hunt.phases
    .map((phase, index) => ({ phase, number: index + 1 }))
    .reverse()
    .slice(0, limit);
  const hidden = hunt.phases.length - recent.length;
  const counting = hunt.status !== 'completed';

  return (
    <Panel
      title="Phases"
      subtitle={
        hunt.phases.length === 0
          ? 'Shinies that were not the target'
          : `${formatCount(hunt.phases.length)} logged${counting ? ` · phase ${formatCount(hunt.phases.length + 1)} in progress` : ''}`
      }
      icon={<Layers />}
      padding="none"
      accent={hunt.phases.length > 0 ? 'violet' : 'none'}
      actions={
        <Button
          size="sm"
          variant="ghost"
          trailingIcon={<ArrowUpRight />}
          onClick={() => navigate('log')}
        >
          Full log
        </Button>
      }
    >
      {recent.length === 0 ? (
        <EmptyState
          size="sm"
          tone="violet"
          icon={<Sparkles />}
          title="No phases yet"
          description="When a shiny appears that is not your target, log it — the counter starts a fresh phase and the total keeps running."
          action={
            counting ? (
              <Button
                size="sm"
                variant="rare"
                leadingIcon={<Sparkles />}
                onClick={() => openPhaseDialog({ huntId: hunt.id })}
              >
                Log phase
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className={styles.phaseList}>
          {recent.map(({ phase, number }) => {
            const unidentified = isUnidentified(phase);
            return (
              <li key={phase.id} className={styles.phaseItem}>
                <Sprite src={phaseSpriteSources(phase)} alt="" size={40} />
                <div className={styles.phaseText}>
                  <span
                    className={styles.phaseName}
                    data-unidentified={unidentified ? '' : undefined}
                  >
                    {phaseDisplayName(phase)}
                  </span>
                  <span className={styles.phaseMeta}>
                    #{number} · {formatCount(phase.encounters)} encounters ·{' '}
                    <time dateTime={phase.timestamp} title={formatDateTime(phase.timestamp)}>
                      {formatRelativeTime(phase.timestamp)}
                    </time>
                  </span>
                  {phase.notes.trim() !== '' ? (
                    <span className={styles.phaseNotes} title={phase.notes}>
                      {phase.notes}
                    </span>
                  ) : null}
                </div>
                <div className={styles.phaseActions}>
                  <IconButton
                    size="sm"
                    label={unidentified ? `Identify phase ${number}` : `Edit phase ${number}`}
                    onClick={() => openPhaseDialog({ huntId: hunt.id, phaseId: phase.id })}
                  >
                    <Pencil />
                  </IconButton>
                  <IconButton
                    size="sm"
                    label={`Delete phase ${number}`}
                    onClick={() => void deletePhase(hunt, phase)}
                  >
                    <Trash2 />
                  </IconButton>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {hidden > 0 ? (
        <div className={styles.phaseMore}>
          <Button size="sm" variant="ghost" onClick={() => navigate('log')}>
            {formatCount(hidden)} earlier {hidden === 1 ? 'phase' : 'phases'} in the log
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}
