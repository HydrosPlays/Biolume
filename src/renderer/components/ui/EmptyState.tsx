import type { ReactNode } from 'react';
import { cx } from './internal/cx';
import type { Tone } from './internal/types';
import styles from './EmptyState.module.css';

export interface EmptyStateProps {
  /** Icon in the glowing orb (a 24px lucide icon). */
  icon?: ReactNode;
  /** Short headline: what is missing. */
  title: ReactNode;
  /** One or two sentences: why, and what to do about it. */
  description?: ReactNode;
  /** Call(s) to action — usually one primary Button. */
  action?: ReactNode;
  /** Colour of the orb. Default `accent`; use `danger` for error fallbacks. */
  tone?: Tone;
  /** `sm` for panels and popovers, `md` for whole views. Default `md`. */
  size?: 'sm' | 'md';
  className?: string;
}

/** Placeholder for empty lists, missing selections and failed loads. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  tone = 'accent',
  size = 'md',
  className,
}: EmptyStateProps) {
  return (
    <div className={cx(styles.empty, styles[size], className)} data-tone={tone}>
      {icon ? (
        <div className={styles.orb} aria-hidden="true">
          <span className={styles.halo} />
          {icon}
        </div>
      ) : null}
      <p className={styles.title}>{title}</p>
      {description ? <p className={styles.description}>{description}</p> : null}
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
