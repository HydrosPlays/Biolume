import { Check, Milestone as MilestoneIcon } from 'lucide-react';
import { Panel } from '@renderer/components/ui';
import { formatCount, formatDuration, formatPercent } from '@renderer/lib/format';
import { MILESTONE_PROBABILITIES } from '@renderer/lib/probability';
import { timeAtPace, type CurveModel, type Pace } from './model';
import styles from './Odds.module.css';

export interface MilestonesTableProps {
  model: CurveModel;
  /** The active hunt's total encounters; null for the standalone calculator. */
  total: number | null;
  pace: Pace | null;
}

function paceCaption(pace: Pace | null, hasHunt: boolean): string {
  if (!pace) {
    return 'Time estimates appear once your session history covers a couple of minutes of counting.';
  }
  const sessions = `${pace.sessions} session${pace.sessions === 1 ? '' : 's'}`;
  const scope =
    pace.scope === 'hunt' ? `${sessions} of this hunt` : `${sessions} across all your hunts`;
  const lead = hasHunt && pace.scope === 'all' ? 'No pace for this hunt yet — using ' : 'At ';
  return `${lead}${formatCount(pace.perHour)} encounters per hour (${scope}).`;
}

/** Encounters needed for a 25 … 99 % chance of at least one shiny, with time at the hunter's pace. */
export function MilestonesTable({ model, total, pace }: MilestonesTableProps) {
  const hasHunt = total !== null;
  const rows = MILESTONE_PROBABILITIES.map((probability) => {
    const encounters = model.encountersFor(probability);
    const reached = total !== null && total >= encounters;
    const remaining = total !== null ? Math.max(0, encounters - total) : encounters;
    return { probability, encounters, reached, remaining };
  });

  return (
    <Panel
      title="Milestones"
      subtitle={
        model.mode === 'chain' ? 'With a chain built from scratch' : 'Chance of at least one shiny'
      }
      icon={<MilestoneIcon />}
      padding="none"
      footer={<span className={styles.footnote}>{paceCaption(pace, hasHunt)}</span>}
    >
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Chance</th>
            <th scope="col" className={styles.numeric}>
              Encounters
            </th>
            <th scope="col" className={styles.numeric}>
              {hasHunt ? 'To go' : 'Time'}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const time =
              row.reached || !pace || !Number.isFinite(row.remaining)
                ? null
                : formatDuration(timeAtPace(row.remaining, pace));
            return (
              <tr key={row.probability} data-reached={row.reached || undefined}>
                <th scope="row">{formatPercent(row.probability)}</th>
                <td className={styles.numeric}>{formatCount(row.encounters)}</td>
                <td className={styles.numeric}>
                  {row.reached ? (
                    <span className={styles.reached}>
                      <Check aria-hidden="true" />
                      passed
                    </span>
                  ) : hasHunt ? (
                    <>
                      {formatCount(row.remaining)}
                      {time ? <span className={styles.cellSub}>≈ {time}</span> : null}
                    </>
                  ) : (
                    (time ?? '—')
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}
