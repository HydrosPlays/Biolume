import { cx } from './internal/cx';
import styles from './Spinner.module.css';

export interface SpinnerProps {
  /** Diameter in px. Default 16. */
  size?: number;
  /** Announced to assistive tech; omit when a visible label sits next to the spinner. */
  label?: string;
  className?: string;
}

/** Indeterminate progress: a short arc of light circling a faint ring. Inherits `currentColor`. */
export function Spinner({ size = 16, label, className }: SpinnerProps) {
  return (
    <span
      className={cx(styles.spinner, className)}
      style={{ width: size, height: size }}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <svg viewBox="0 0 24 24" fill="none" className={styles.svg}>
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.18" />
        <path
          d="M12 3a9 9 0 0 1 9 9"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}
