import type { ComponentProps, MouseEvent, ReactNode } from 'react';
import { cx } from './internal/cx';
import type { ControlSize } from './internal/types';
import { Spinner } from './Spinner';
import styles from './Button.module.css';

/**
 * - `primary`   — the one main action of a surface (filled, glowing)
 * - `secondary` — standard action (glass)
 * - `ghost`     — low-emphasis / toolbar action
 * - `danger`    — destructive action
 * - `rare`      — violet; phase / special-state actions
 * - `shiny`     — gold; reserved for "shiny found"
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'rare' | 'shiny';

export interface ButtonProps extends ComponentProps<'button'> {
  /** Visual emphasis. Default `secondary`. */
  variant?: ButtonVariant;
  /** Control height. Default `md`. */
  size?: ControlSize;
  /** Shows a spinner, sets `aria-busy` and ignores clicks while true. */
  loading?: boolean;
  /** Icon before the label (16px lucide icon recommended). */
  leadingIcon?: ReactNode;
  /** Icon after the label. */
  trailingIcon?: ReactNode;
  /** Stretch to the container width. */
  fullWidth?: boolean;
}

/** A real `<button>` (type defaults to `button`, not `submit`). */
export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  leadingIcon,
  trailingIcon,
  fullWidth = false,
  className,
  children,
  disabled,
  onClick,
  type = 'button',
  ...rest
}: ButtonProps) {
  const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    if (loading) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };

  return (
    <button
      {...rest}
      type={type}
      disabled={disabled}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      data-loading={loading || undefined}
      className={cx(
        styles.button,
        styles[variant],
        styles[size],
        fullWidth && styles.fullWidth,
        className,
      )}
      onClick={handleClick}
    >
      {loading ? (
        <Spinner size={size === 'lg' ? 18 : 14} />
      ) : leadingIcon ? (
        <span className={styles.icon}>{leadingIcon}</span>
      ) : null}
      {children !== undefined && children !== null ? (
        <span className={styles.label}>{children}</span>
      ) : null}
      {trailingIcon ? <span className={styles.icon}>{trailingIcon}</span> : null}
    </button>
  );
}
