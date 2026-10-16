import { Fragment, type ReactNode } from 'react';
import { formatAccelerator } from '@renderer/lib/accelerator';
import { cx } from './internal/cx';
import styles from './Kbd.module.css';

export interface KbdProps {
  /** Key-cap labels rendered as a combination: `['Ctrl', 'Shift', 'B']`. */
  keys?: readonly string[];
  /** An Electron accelerator to render (`CommandOrControl+Shift+B`); formatted for the host platform. */
  accelerator?: string;
  /** A single custom key cap, when neither `keys` nor `accelerator` fits. */
  children?: ReactNode;
  /** `sm` for inline hints and tooltips, `md` for settings rows. Default `md`. */
  size?: 'sm' | 'md';
  className?: string;
}

/** Key caps. Pass `accelerator` for hotkey bindings so every view formats them identically. */
export function Kbd({ keys, accelerator, children, size = 'md', className }: KbdProps) {
  const labels = keys ?? (accelerator === undefined ? null : formatAccelerator(accelerator));

  if (labels === null) {
    return <kbd className={cx(styles.key, styles[size], className)}>{children}</kbd>;
  }

  return (
    <span className={cx(styles.combo, className)}>
      {labels.map((label, index) => (
        <Fragment key={`${label}-${index}`}>
          {index > 0 ? (
            <span className={styles.plus} aria-hidden="true">
              +
            </span>
          ) : null}
          <kbd className={cx(styles.key, styles[size])}>{label}</kbd>
        </Fragment>
      ))}
    </span>
  );
}
