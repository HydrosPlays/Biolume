import type { CSSProperties, ReactNode } from 'react';
import { cx } from './internal/cx';
import type { Tone } from './internal/types';
import styles from './Meters.module.css';

export interface StatBarProps {
  /** Row label, e.g. "HP", "Sp. Atk". */
  label: ReactNode;
  /** Current value. */
  value: number;
  /** Value that fills the bar. Default 255 (the base-stat ceiling). */
  max?: number;
  /**
   * Bar colour. Default `auto`: graded by how full the bar is (red → amber →
   * teal → cyan), the way base stats are usually read.
   */
  tone?: Tone | 'auto';
  /** Text shown for the value; defaults to the number. */
  valueLabel?: ReactNode;
  /** Accessible name when `label` is not plain text. */
  'aria-label'?: string;
  className?: string;
}

function autoTone(fraction: number): Tone {
  if (fraction < 0.2) return 'danger';
  if (fraction < 0.35) return 'warn';
  if (fraction < 0.5) return 'shiny';
  if (fraction < 0.65) return 'teal';
  return 'accent';
}

/** A labelled horizontal meter — base stats, per-type recipe coverage, progress toward odds. */
export function StatBar({
  label,
  value,
  max = 255,
  tone = 'auto',
  valueLabel,
  className,
  ...rest
}: StatBarProps) {
  const fraction = max <= 0 ? 0 : Math.min(Math.max(value / max, 0), 1);
  const resolved = tone === 'auto' ? autoTone(fraction) : tone;

  return (
    <div className={cx(styles.stat, className)} data-tone={resolved}>
      <span className={styles.statLabel}>{label}</span>
      <div
        className={styles.track}
        role="meter"
        aria-label={rest['aria-label'] ?? (typeof label === 'string' ? label : undefined)}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.min(Math.max(value, 0), max)}
      >
        <div className={styles.fill} style={{ '--fraction': fraction } as CSSProperties} />
      </div>
      <span className={styles.statValue}>{valueLabel ?? value}</span>
    </div>
  );
}

export interface ProgressRingProps {
  /** Progress from 0 to 1; values outside are clamped. */
  value: number;
  /** Outer diameter in px. Default 96. */
  size?: number;
  /** Stroke width in px. Default 8. */
  thickness?: number;
  /** Arc colour. Default `accent`; `shiny` once a hunt is over odds or complete. */
  tone?: Tone;
  /** Content centred inside the ring (a percentage, a count). */
  children?: ReactNode;
  /** Accessible name, e.g. "Chance of having found a shiny by now". */
  'aria-label'?: string;
  /** Text alternative for the value, e.g. "63 %". */
  'aria-valuetext'?: string;
  className?: string;
}

/** Circular progress with a glowing arc — cumulative probability, session goals. */
export function ProgressRing({
  value,
  size = 96,
  thickness = 8,
  tone = 'accent',
  children,
  className,
  ...rest
}: ProgressRingProps) {
  const fraction = Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0;
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <div
      className={cx(styles.ring, className)}
      style={{ width: size, height: size }}
      data-tone={tone}
      role="progressbar"
      aria-label={rest['aria-label']}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fraction * 100)}
      aria-valuetext={rest['aria-valuetext']}
    >
      <svg
        className={styles.ringSvg}
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
      >
        <circle
          className={styles.ringTrack}
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={thickness}
        />
        <circle
          className={styles.ringArc}
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={thickness}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
          // A zero-length round cap would still paint a dot at 0 %.
          strokeLinecap={fraction > 0 ? 'round' : 'butt'}
        />
      </svg>
      {children !== undefined && children !== null ? (
        <div className={styles.ringContent}>{children}</div>
      ) : null}
    </div>
  );
}
