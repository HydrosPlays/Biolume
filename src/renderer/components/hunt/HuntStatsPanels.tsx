import type { ReactNode } from 'react';
import {
  ArrowUpRight,
  Clock,
  Dices,
  Flag,
  Gauge,
  Layers,
  Sigma,
  Target,
  TrendingUp,
} from 'lucide-react';
import type { Hunt } from '@shared/types';
import { Badge, cx, Panel, ProgressRing, StatBar, type Tone } from '@renderer/components/ui';
import { navigate } from '@renderer/hooks/useView';
import {
  formatCount,
  formatDateTime,
  formatDuration,
  formatOdds,
  formatPercent,
} from '@renderer/lib/format';
import type { OddsResult } from '@renderer/lib/odds';
import { LUCK_VERDICT_LABELS } from '@renderer/lib/probability';
import { formatOddsRatio, formatRate, luckTone, type HuntStats } from './huntStats';
import styles from './hunt.module.css';

interface StatTileProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon: ReactNode;
  /** Tints the value. Omit for plain ink. */
  tone?: Tone;
  /** Spans two columns. */
  wide?: boolean;
  /** Makes the tile a button; `actionHint` says where it leads. */
  onClick?: () => void;
  actionHint?: string;
}

function StatTile({ label, value, hint, icon, tone, wide, onClick, actionHint }: StatTileProps) {
  const className = cx(styles.tile, wide && styles.tileWide);
  const content = (
    <>
      <span className={styles.tileLabel}>
        {icon}
        <span className={styles.tileLabelText}>{label}</span>
        {onClick ? <ArrowUpRight className={styles.tileGo} aria-hidden="true" /> : null}
      </span>
      <span className={styles.tileValue}>{value}</span>
      {hint ? <span className={styles.tileHint}>{hint}</span> : null}
      {onClick && actionHint ? <span className="sr-only">{actionHint}</span> : null}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={className}
        data-tone={tone}
        title={actionHint}
        onClick={onClick}
      >
        {content}
      </button>
    );
  }
  return (
    <div className={className} data-tone={tone}>
      {content}
    </div>
  );
}

/** One line describing where the odds come from: game, method, charm. */
export function describeOddsSource(odds: OddsResult | null): string {
  if (!odds) return 'Odds unavailable';
  if (!odds.valid && odds.warnings[0]) return odds.warnings[0];
  const parts = [odds.game.shortName, odds.method.name];
  if (odds.charmApplied) parts.push('Shiny Charm');
  return parts.join(' · ');
}

export interface StatTilesProps {
  hunt: Hunt;
  odds: OddsResult | null;
  stats: HuntStats;
}

/** The stats strip: odds, how far past them, the next milestone, totals, time and pace. */
export function StatTiles({ hunt, odds, stats }: StatTilesProps) {
  const known = stats.probability > 0;
  const expected = known ? 1 / stats.probability : Infinity;
  const overOdds = stats.oddsRatio >= 1;
  const { next, perHour } = stats;
  // A finished hunt has nothing left to forecast: it reports where the find landed instead.
  const completed = hunt.status === 'completed';
  const passed = stats.milestones.filter((milestone) => milestone.reached).length;

  const untilOdds = overOdds
    ? `${formatCount(stats.total - expected)} past the odds`
    : known
      ? `${formatCount(Math.ceil(expected - stats.total))} until at odds`
      : 'Odds unknown';

  const paceHint =
    perHour === null
      ? 'Needs a little more time'
      : next && !completed
        ? `≈ ${formatDuration((next.remaining / perHour) * 3_600_000)} to ${formatPercent(next.probability)}`
        : 'Encounters per hour';

  return (
    <section className={styles.tiles} aria-label="Hunt statistics">
      <StatTile
        wide
        icon={<Target aria-hidden="true" />}
        label="Current odds"
        value={known ? formatOdds(stats.probability) : '—'}
        hint={describeOddsSource(odds)}
        tone="accent"
        onClick={() => navigate('odds')}
        actionHint="Open the Odds view"
      />
      <StatTile
        icon={<TrendingUp aria-hidden="true" />}
        label="Over odds"
        value={formatOddsRatio(stats.oddsRatio)}
        hint={untilOdds}
        {...(overOdds ? { tone: 'violet' as const } : {})}
      />
      {completed ? (
        <StatTile
          icon={<Flag aria-hidden="true" />}
          label="Milestones passed"
          value={known ? `${passed} of ${stats.milestones.length}` : '—'}
          hint={
            !known
              ? 'Odds unknown'
              : next
                ? `Found before the ${formatPercent(next.probability)} mark`
                : 'Found past every mark'
          }
        />
      ) : (
        <StatTile
          icon={<Flag aria-hidden="true" />}
          label="Next milestone"
          value={next ? formatCount(next.remaining) : known ? 'Past 99 %' : '—'}
          hint={
            next
              ? `encounters to ${formatPercent(next.probability)}`
              : known
                ? 'Every milestone reached'
                : 'Odds unknown'
          }
        />
      )}
      <StatTile
        icon={<Sigma aria-hidden="true" />}
        label="Total encounters"
        value={formatCount(stats.total)}
        hint={`${formatCount(stats.count)} this phase`}
      />
      <StatTile
        icon={<Layers aria-hidden="true" />}
        label="Phase"
        value={`#${formatCount(stats.phaseNumber)}`}
        hint={
          stats.phasesLogged === 0
            ? 'No phases logged'
            : `${formatCount(stats.phasesLogged)} logged`
        }
        {...(stats.phasesLogged > 0 ? { tone: 'violet' as const } : {})}
      />
      <StatTile
        icon={<Clock aria-hidden="true" />}
        label="Time hunting"
        value={formatDuration(stats.elapsedMs)}
        hint={`Started ${formatDateTime(hunt.createdAt, { time: false })}`}
      />
      <StatTile
        icon={<Gauge aria-hidden="true" />}
        label="Pace"
        value={formatRate(perHour)}
        hint={paceHint}
      />
    </section>
  );
}

export interface LuckPanelProps {
  stats: HuntStats;
  /** The hunt is finished: the verdict describes the find instead of a hypothetical one. */
  completed?: boolean;
}

/** Chance of having found the shiny by now, the luck verdict, and progress to 50 / 90 / 99 %. */
export function LuckPanel({ stats, completed = false }: LuckPanelProps) {
  const known = stats.probability > 0;
  const overOdds = stats.oddsRatio >= 1;
  const tone = luckTone(stats.verdict);
  const ringTone: Tone = completed ? 'shiny' : overOdds ? 'violet' : 'accent';
  const percent = formatPercent(stats.cumulative);

  let copy: string;
  if (!known) copy = 'Pick a game and method in the Odds view to switch the luck meter on.';
  else if (stats.total === 0) copy = 'Count the first encounter to start the luck meter.';
  else if (completed)
    copy = `${formatPercent(1 - stats.cumulative)} of hunts at these odds take longer than this one did.`;
  else copy = `${percent} of hunts at these odds are already over by now.`;

  return (
    <Panel
      title="Luck"
      icon={<Dices />}
      accent={completed ? 'shiny' : overOdds ? 'violet' : 'none'}
      actions={
        stats.verdict === 'unknown' ? null : (
          <Badge tone={tone} dot>
            {LUCK_VERDICT_LABELS[stats.verdict]}
          </Badge>
        )
      }
    >
      <div className={styles.luckTop}>
        <ProgressRing
          value={stats.cumulative}
          size={104}
          tone={ringTone}
          aria-label="Chance of having found the shiny by now"
          aria-valuetext={percent}
        >
          <span className={styles.ringValue}>{percent}</span>
          <span className={styles.ringLabel}>{completed ? 'at the find' : 'by now'}</span>
        </ProgressRing>
        <div className={styles.luckText}>
          <span className="eyebrow">
            {completed ? 'Chance it took this long' : 'Chance of a shiny by now'}
          </span>
          <p className={styles.luckCopy}>{copy}</p>
        </div>
      </div>

      <div className={styles.milestones}>
        {known ? (
          stats.milestones.map((milestone) => (
            <StatBar
              key={milestone.probability}
              label={formatPercent(milestone.probability)}
              aria-label={`Progress to a ${formatPercent(milestone.probability)} chance`}
              value={Math.min(stats.total, milestone.encounters)}
              max={milestone.encounters}
              tone={milestone.reached ? 'teal' : 'accent'}
              valueLabel={
                milestone.reached
                  ? `passed at ${formatCount(milestone.encounters)}`
                  : `${formatCount(milestone.remaining)} to go`
              }
            />
          ))
        ) : (
          <p className={styles.milestoneNote}>
            Milestones appear once the hunt has odds to measure against.
          </p>
        )}
      </div>
    </Panel>
  );
}
