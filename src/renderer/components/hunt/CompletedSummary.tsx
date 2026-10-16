import type { CSSProperties } from 'react';
import { Plus, RotateCcw } from 'lucide-react';
import type { Hunt } from '@shared/types';
import { Button, cx, Panel, Sprite } from '@renderer/components/ui';
import { formatCount, formatDateTime, formatDuration, formatOdds } from '@renderer/lib/format';
import type { OddsResult } from '@renderer/lib/odds';
import { LUCK_VERDICT_LABELS } from '@renderer/lib/probability';
import { describeOddsSource } from './HuntStatsPanels';
import { reopenHunt } from './huntActions';
import { formatOddsRatio, heroSpriteSources, type HuntStats } from './huntStats';
import styles from './hunt.module.css';

/** Four-point sparkle on a 10×10 grid. */
const SPARKLE_PATH = 'M5 0 6.2 3.8 10 5 6.2 6.2 5 10 3.8 6.2 0 5 3.8 3.8Z';

/** Sixteen sparkles on a golden-angle spiral: evenly scattered, identical on every run. */
const SPARKS = Array.from({ length: 16 }, (_, index) => {
  const angle = (index * 137.508 * Math.PI) / 180;
  const radius = 64 + ((index * 53) % 96);
  return {
    x: Math.round(Math.cos(angle) * radius),
    y: Math.round(Math.sin(angle) * radius),
    scale: 0.6 + ((index * 7) % 5) * 0.2,
    delay: (index % 4) * 80,
  };
});

/**
 * The gold moment: one burst of sparkles and a ring from wherever it is
 * mounted (absolutely centred in a positioned parent). Plays once per mount;
 * with reduced motion it resolves instantly to its invisible end state.
 */
export function Celebration() {
  return (
    <span className={styles.celebration} aria-hidden="true">
      <span className={cx(styles.burst, 'bl-ripple')} />
      {SPARKS.map((spark, index) => (
        <svg
          key={index}
          className={styles.spark}
          viewBox="0 0 10 10"
          style={
            {
              '--x': `${spark.x}px`,
              '--y': `${spark.y}px`,
              '--scale': spark.scale,
              '--delay': `${spark.delay}ms`,
            } as CSSProperties
          }
        >
          <path d={SPARKLE_PATH} />
        </svg>
      ))}
    </span>
  );
}

export interface CompletedSummaryProps {
  hunt: Hunt;
  odds: OddsResult | null;
  stats: HuntStats;
  /** Set when the hunt was completed just now: a changing key replays the sparkles. */
  celebrationKey: string | null;
  onNewHunt: () => void;
}

/** What a finished hunt came to — encounters, phases, time, odds and luck — with a way back and a way onward. */
export function CompletedSummary({
  hunt,
  odds,
  stats,
  celebrationKey,
  onNewHunt,
}: CompletedSummaryProps) {
  const target = hunt.target;
  const known = stats.probability > 0;

  return (
    <Panel accent="shiny" glow padding="none" aria-label="Hunt complete">
      <div className={styles.summaryBody}>
        <div className={styles.summaryStage}>
          <span className={styles.aura} aria-hidden="true" />
          <Sprite
            className={styles.float}
            src={heroSpriteSources(target)}
            alt={target ? `Shiny ${target.name}` : ''}
            size={156}
            shiny
            pixelated={false}
            loading="eager"
          />
          {celebrationKey !== null ? <Celebration key={celebrationKey} /> : null}
        </div>

        <div className={styles.summaryText}>
          <p className={styles.summaryEyebrow}>Shiny found</p>
          <h2 className={styles.summaryTitle}>{hunt.name}</h2>
          <p className={styles.summarySub}>
            {hunt.completedAt ? `Completed ${formatDateTime(hunt.completedAt)}` : 'Completed'} ·{' '}
            {describeOddsSource(odds)}
          </p>

          <dl className={styles.summaryStats}>
            <div className={styles.summaryStat}>
              <dt>Encounters</dt>
              <dd>{formatCount(stats.total)}</dd>
            </div>
            <div className={styles.summaryStat}>
              <dt>Phases</dt>
              <dd>{formatCount(stats.phaseNumber)}</dd>
            </div>
            <div className={styles.summaryStat}>
              <dt>Time</dt>
              <dd>{formatDuration(stats.elapsedMs)}</dd>
            </div>
            <div className={styles.summaryStat}>
              <dt>Odds</dt>
              <dd>{known ? formatOdds(stats.probability) : '—'}</dd>
            </div>
            <div className={styles.summaryStat}>
              <dt>Luck</dt>
              <dd>{stats.verdict === 'unknown' ? '—' : LUCK_VERDICT_LABELS[stats.verdict]}</dd>
            </div>
            <div className={styles.summaryStat}>
              <dt>Over odds</dt>
              <dd>{formatOddsRatio(stats.oddsRatio)}</dd>
            </div>
          </dl>

          <div className={styles.summaryActions}>
            <Button variant="primary" leadingIcon={<Plus />} onClick={onNewHunt}>
              Start a new hunt
            </Button>
            <Button leadingIcon={<RotateCcw />} onClick={() => void reopenHunt(hunt)}>
              Reopen
            </Button>
          </div>
        </div>
      </div>
    </Panel>
  );
}
