import { useMemo, useState } from 'react';
import { History, Layers, Pencil, Radar, RotateCcw, Trash2, Trophy } from 'lucide-react';
import type { Hunt } from '@shared/types';
import {
  Button,
  EmptyState,
  IconButton,
  Panel,
  Select,
  Sprite,
  cx,
  type SelectOption,
} from '@renderer/components/ui';
import { navigate } from '@renderer/hooks/useView';
import {
  formatCount,
  formatDateTime,
  formatDuration,
  formatOdds,
  formatRelativeTime,
} from '@renderer/lib/format';
import { oddsEngine } from '@renderer/lib/oddsData';
import { LUCK_VERDICT_LABELS } from '@renderer/lib/probability';
import { actions, useHunts, useSessions, useUiStore } from '@renderer/store';
import { deletePhase, reopenHunt } from './huntActions';
import {
  deriveHuntStats,
  encountersPerHour,
  flattenPhases,
  formatOddsRatio,
  formatRate,
  groupHunts,
  heroSpriteSources,
  huntOdds,
  isUnidentified,
  phaseDisplayName,
  phaseSpriteSources,
  sessionDurationMs,
  sessionTotals,
} from './huntStats';
import styles from './log.module.css';

/** Rows rendered at once; long histories grow on demand so the table stays light. */
const PAGE_SIZE = 100;
const ALL_HUNTS = '__all__';

const timeOfDay = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });

/** A timestamp on two lines — date, then time of day — so the column stays narrow. */
function When({ timestamp }: { timestamp: string }) {
  const time = Date.parse(timestamp);
  return (
    <time dateTime={timestamp} title={formatRelativeTime(timestamp)}>
      <span className={styles.whenDate}>{formatDateTime(timestamp, { time: false })}</span>
      {Number.isNaN(time) ? null : <span className={styles.cellSub}>{timeOfDay.format(time)}</span>}
    </time>
  );
}

function GoToCounter() {
  return (
    <Button variant="primary" leadingIcon={<Radar />} onClick={() => navigate('hunt')}>
      Go to the counter
    </Button>
  );
}

function ShowMore({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  if (shown >= total) return null;
  return (
    <div className={styles.more}>
      <Button size="sm" variant="ghost" onClick={onMore}>
        Show {formatCount(Math.min(PAGE_SIZE, total - shown))} more ({formatCount(total - shown)}{' '}
        hidden)
      </Button>
    </div>
  );
}

// ───────────────────────────── Phases ─────────────────────────────

/** Every phase across hunts, newest first, filterable by hunt. */
export function PhasesTab() {
  const hunts = useHunts();
  const openPhaseDialog = useUiStore((state) => state.openPhaseDialog);
  const [filter, setFilter] = useState(ALL_HUNTS);
  const [visible, setVisible] = useState(PAGE_SIZE);

  const withPhases = useMemo(() => hunts.filter((hunt) => hunt.phases.length > 0), [hunts]);
  // A filter pointing at a hunt that lost its last phase (or was deleted) falls back to everything.
  const huntId = withPhases.some((hunt) => hunt.id === filter) ? filter : ALL_HUNTS;
  const rows = useMemo(
    () => flattenPhases(hunts, huntId === ALL_HUNTS ? null : huntId),
    [hunts, huntId],
  );
  const totalPhases = withPhases.reduce((sum, hunt) => sum + hunt.phases.length, 0);

  if (totalPhases === 0) {
    return (
      <EmptyState
        tone="violet"
        icon={<Layers />}
        title="No phases logged yet"
        description="A phase is a shiny that was not your target. Log one from the counter and it shows up here with its roll count and running total."
        action={<GoToCounter />}
      />
    );
  }

  const options: SelectOption[] = [
    { value: ALL_HUNTS, label: 'All hunts', meta: formatCount(totalPhases) },
    ...withPhases.map((hunt) => ({
      value: hunt.id,
      label: hunt.name,
      meta: formatCount(hunt.phases.length),
    })),
  ];
  const shown = rows.slice(0, visible);

  return (
    <div className={styles.stack}>
      <div className={styles.toolbar}>
        <Select
          aria-label="Filter phases by hunt"
          className={styles.filter}
          fullWidth={false}
          options={options}
          value={huntId}
          onChange={(value) => {
            setFilter(value);
            setVisible(PAGE_SIZE);
          }}
        />
        <span className={styles.tally}>
          {formatCount(rows.length)} {rows.length === 1 ? 'phase' : 'phases'}
        </span>
      </div>

      <Panel padding="none" aria-label="Phase log">
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col" className={styles.colPhase}>
                  Phase
                </th>
                <th scope="col" className={styles.colHunt}>
                  Hunt
                </th>
                <th scope="col" className={styles.colSpecies}>
                  Species
                </th>
                <th scope="col" className={cx(styles.num, styles.colCount)}>
                  Roll count
                </th>
                <th
                  scope="col"
                  className={cx(styles.num, styles.colTotal, styles.optional)}
                  title="Running total across the hunt's phases"
                >
                  Total
                </th>
                <th scope="col" className={styles.colWhen}>
                  Logged
                </th>
                <th scope="col" className={styles.optional}>
                  Notes
                </th>
                <th scope="col" className={styles.colActions}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => {
                const { phase } = row;
                const unidentified = isUnidentified(phase);
                const label = `${phaseDisplayName(phase)}, phase ${row.phaseNumber} of ${row.huntName}`;
                return (
                  <tr key={row.key}>
                    <td className={styles.phaseNo}>#{row.phaseNumber}</td>
                    <td>
                      <span className={styles.cellMain} title={row.huntName}>
                        {row.huntName}
                      </span>
                      {row.targetName ? (
                        <span className={styles.cellSub}>for {row.targetName}</span>
                      ) : null}
                    </td>
                    <td>
                      <span className={styles.species}>
                        <Sprite src={phaseSpriteSources(phase)} alt="" size={36} />
                        <span
                          className={styles.speciesName}
                          data-unidentified={unidentified ? '' : undefined}
                        >
                          {phaseDisplayName(phase)}
                        </span>
                      </span>
                    </td>
                    <td className={styles.num}>{formatCount(phase.encounters)}</td>
                    <td className={cx(styles.num, styles.optional)}>
                      {formatCount(phase.totalEncounters)}
                    </td>
                    <td className={styles.when}>
                      <When timestamp={phase.timestamp} />
                    </td>
                    <td className={styles.optional}>
                      <span className={styles.notes} title={phase.notes}>
                        {phase.notes.trim() === '' ? '—' : phase.notes}
                      </span>
                    </td>
                    <td>
                      <div className={styles.rowActions}>
                        <IconButton
                          size="sm"
                          label={`${unidentified ? 'Identify' : 'Edit'} ${label}`}
                          tooltip={unidentified ? 'Identify' : 'Edit'}
                          onClick={() => openPhaseDialog({ huntId: row.huntId, phaseId: phase.id })}
                        >
                          <Pencil />
                        </IconButton>
                        <IconButton
                          size="sm"
                          label={`Delete ${label}`}
                          tooltip="Delete"
                          onClick={() =>
                            void deletePhase({ id: row.huntId, name: row.huntName }, phase)
                          }
                        >
                          <Trash2 />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <ShowMore
          shown={shown.length}
          total={rows.length}
          onMore={() => setVisible((count) => count + PAGE_SIZE)}
        />
      </Panel>
    </div>
  );
}

// ───────────────────────────── Sessions ─────────────────────────────

function methodLabel(gameId: string, methodId: string): string {
  const game = oddsEngine.getGame(gameId);
  const method = oddsEngine.getMethod(gameId, methodId);
  return [game?.shortName, method?.name].filter(Boolean).join(' · ');
}

/** Session history, newest first, with a totals row. */
export function SessionsTab() {
  const sessions = useSessions();
  const [visible, setVisible] = useState(PAGE_SIZE);
  const totals = useMemo(() => sessionTotals(sessions), [sessions]);

  if (sessions.length === 0) {
    return (
      <EmptyState
        icon={<History />}
        title="No sessions yet"
        description="A session opens with your first count and closes after a pause. Each one records how long you hunted and how many encounters you got through."
        action={<GoToCounter />}
      />
    );
  }

  const shown = sessions.slice(0, visible);

  return (
    <Panel padding="none" aria-label="Session history">
      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Hunt</th>
              <th scope="col" className={styles.colWhen}>
                Started
              </th>
              <th scope="col" className={cx(styles.num, styles.colCount)}>
                Duration
              </th>
              <th scope="col" className={cx(styles.num, styles.colWhen)}>
                Encounters
              </th>
              <th scope="col" className={cx(styles.num, styles.colCount)}>
                Per hour
              </th>
              <th scope="col" className={cx(styles.num, styles.colActions)}>
                Phases
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((session) => {
              const durationMs = sessionDurationMs(session);
              const context = [session.targetName, methodLabel(session.gameId, session.methodId)]
                .filter(Boolean)
                .join(' · ');
              return (
                <tr key={session.id}>
                  <td>
                    <span className={styles.cellMain} title={session.huntName}>
                      {session.huntName}
                    </span>
                    {context ? <span className={styles.cellSub}>{context}</span> : null}
                  </td>
                  <td className={styles.when}>
                    <When timestamp={session.startedAt} />
                  </td>
                  <td className={styles.num}>{formatDuration(durationMs)}</td>
                  <td className={styles.num}>{formatCount(session.encounters)}</td>
                  <td className={styles.num}>
                    {formatRate(encountersPerHour(session.encounters, durationMs))}
                  </td>
                  <td className={styles.num}>{formatCount(session.phasesLogged)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2}>
                Total · {formatCount(totals.sessions)}{' '}
                {totals.sessions === 1 ? 'session' : 'sessions'}
              </td>
              <td className={styles.num}>{formatDuration(totals.durationMs)}</td>
              <td className={styles.num}>{formatCount(totals.encounters)}</td>
              <td className={styles.num}>{formatRate(totals.perHour)}</td>
              <td className={styles.num}>{formatCount(totals.phases)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <ShowMore
        shown={shown.length}
        total={sessions.length}
        onMore={() => setVisible((count) => count + PAGE_SIZE)}
      />
    </Panel>
  );
}

// ───────────────────────────── Trophies ─────────────────────────────

function TrophyCard({ hunt }: { hunt: Hunt }) {
  const odds = huntOdds(hunt);
  const stats = deriveHuntStats(hunt, odds?.perEncounter);
  const known = stats.probability > 0;

  return (
    <Panel accent="shiny" as="article" aria-label={hunt.name}>
      <div className={styles.trophy}>
        <div className={styles.trophyHead}>
          <Sprite
            src={heroSpriteSources(hunt.target)}
            alt={hunt.target ? `Shiny ${hunt.target.name}` : ''}
            size={76}
            shiny
            pixelated={false}
          />
          <div className={styles.trophyTitles}>
            <h3 className={styles.trophyName} title={hunt.name}>
              {hunt.name}
            </h3>
            <span
              className={styles.trophyDate}
              title={hunt.completedAt ? formatDateTime(hunt.completedAt) : undefined}
            >
              {hunt.completedAt ? formatDateTime(hunt.completedAt, { time: false }) : 'Completed'}
              {odds ? ` · ${odds.game.shortName} · ${odds.method.name}` : ''}
            </span>
          </div>
        </div>

        <dl className={styles.trophyStats}>
          <div className={styles.trophyStat}>
            <dt>Encounters</dt>
            <dd>{formatCount(stats.total)}</dd>
          </div>
          <div className={styles.trophyStat}>
            <dt>Phases</dt>
            <dd>{formatCount(stats.phaseNumber)}</dd>
          </div>
          <div className={styles.trophyStat}>
            <dt>Time</dt>
            <dd>{formatDuration(stats.elapsedMs)}</dd>
          </div>
          <div className={styles.trophyStat}>
            <dt>Odds</dt>
            <dd>{known ? formatOdds(stats.probability) : '—'}</dd>
          </div>
          <div className={styles.trophyStat}>
            <dt>Luck</dt>
            <dd>{stats.verdict === 'unknown' ? '—' : LUCK_VERDICT_LABELS[stats.verdict]}</dd>
          </div>
          <div className={styles.trophyStat}>
            <dt>Over odds</dt>
            <dd>{formatOddsRatio(stats.oddsRatio)}</dd>
          </div>
        </dl>

        <div className={styles.trophyActions}>
          <Button size="sm" leadingIcon={<RotateCcw />} onClick={() => void reopenHunt(hunt)}>
            Reopen
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void actions.setActiveHunt(hunt.id);
              navigate('hunt');
            }}
          >
            View summary
          </Button>
        </div>
      </div>
    </Panel>
  );
}

/** Completed hunts as trophy cards, most recent first. */
export function TrophiesTab() {
  const hunts = useHunts();
  const completed = useMemo(() => groupHunts(hunts).completed, [hunts]);

  if (completed.length === 0) {
    return (
      <EmptyState
        tone="shiny"
        icon={<Trophy />}
        title="No trophies yet"
        description="Press “Shiny found!” on the counter when your target finally sparkles — the finished hunt lands here with its encounters, time and luck."
        action={<GoToCounter />}
      />
    );
  }

  return (
    <div className={styles.trophies}>
      {completed.map((hunt) => (
        <TrophyCard key={hunt.id} hunt={hunt} />
      ))}
    </div>
  );
}
