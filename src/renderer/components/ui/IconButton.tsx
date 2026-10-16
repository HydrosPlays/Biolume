import type { ComponentProps, ReactNode } from 'react';
import { cx } from './internal/cx';
import type { Placement } from './internal/position';
import type { ControlSize } from './internal/types';
import { Spinner } from './Spinner';
import { Tooltip } from './Tooltip';
import styles from './IconButton.module.css';

export type IconButtonVariant = 'ghost' | 'secondary' | 'primary' | 'danger';

export interface IconButtonProps extends Omit<ComponentProps<'button'>, 'aria-label'> {
  /** Accessible name; also the tooltip text unless `tooltip` overrides it. Required. */
  label: string;
  /** The icon (a 16–18px lucide icon). */
  children: ReactNode;
  /** Visual emphasis. Default `ghost`. */
  variant?: IconButtonVariant;
  /** Square size, matching the control height scale. Default `md`. */
  size?: ControlSize;
  /** Toggle state: sets `aria-pressed` and lights the button up. Omit for plain actions. */
  pressed?: boolean;
  /** Tooltip content; defaults to `label`. Pass `false` for none. */
  tooltip?: ReactNode | false;
  /** Preferred tooltip side. Default `top`. */
  tooltipPlacement?: Placement;
  /** Electron accelerator shown as key caps in the tooltip. */
  shortcut?: string;
  /** Replaces the icon with a spinner and ignores clicks. */
  loading?: boolean;
}

/** Icon-only button with a built-in tooltip and a mandatory accessible name. */
export function IconButton({
  label,
  children,
  variant = 'ghost',
  size = 'md',
  pressed,
  tooltip,
  tooltipPlacement = 'top',
  shortcut,
  loading = false,
  className,
  onClick,
  type = 'button',
  ...rest
}: IconButtonProps) {
  const button = (
    <button
      {...rest}
      type={type}
      aria-label={label}
      aria-pressed={pressed}
      aria-busy={loading || undefined}
      data-pressed={pressed || undefined}
      className={cx(styles.button, styles[variant], styles[size], className)}
      onClick={(event) => {
        if (loading) return;
        onClick?.(event);
      }}
    >
      {loading ? <Spinner size={14} /> : children}
    </button>
  );

  if (tooltip === false) return button;
  const custom = tooltip !== undefined && tooltip !== null;
  return (
    <Tooltip
      content={custom ? tooltip : label}
      placement={tooltipPlacement}
      decorative={!custom}
      {...(shortcut === undefined ? {} : { shortcut })}
    >
      {button}
    </Tooltip>
  );
}
