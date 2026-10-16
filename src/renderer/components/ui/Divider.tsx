import type { ReactNode } from 'react';
import { cx } from './internal/cx';
import styles from './Divider.module.css';

export interface DividerProps {
  /** Default `horizontal`. A vertical divider stretches to its flex row's height. */
  orientation?: 'horizontal' | 'vertical';
  /** Small caption centred on a horizontal divider ("or", "Advanced"). */
  label?: ReactNode;
  /** Outer margin along the main axis. Default `md`. */
  spacing?: 'none' | 'sm' | 'md' | 'lg';
  className?: string;
}

/** A faint hairline separator. Decorative unless it carries a `label`. */
export function Divider({
  orientation = 'horizontal',
  label,
  spacing = 'md',
  className,
}: DividerProps) {
  const classes = cx(styles.divider, styles[orientation], styles[`space-${spacing}`], className);

  if (orientation === 'horizontal' && label !== undefined) {
    return (
      <div className={cx(classes, styles.labelled)} role="separator">
        <span className={styles.label}>{label}</span>
      </div>
    );
  }
  return <div className={classes} role="separator" aria-orientation={orientation} />;
}
