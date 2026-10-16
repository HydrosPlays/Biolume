import { createElement, useId, type ComponentProps, type ReactNode } from 'react';
import { cx } from './internal/cx';
import styles from './Panel.module.css';

/** Which light a surface carries. `none` keeps it quiet. */
export type SurfaceAccent = 'none' | 'cyan' | 'teal' | 'violet' | 'shiny' | 'danger';
export type SurfacePadding = 'none' | 'sm' | 'md' | 'lg';

export interface PanelProps extends Omit<ComponentProps<'section'>, 'title'> {
  /** Header label (rendered as a small-caps heading). Omit for a headerless surface. */
  title?: ReactNode;
  /** Secondary line under the title. */
  subtitle?: ReactNode;
  /** Icon before the title (16px). */
  icon?: ReactNode;
  /** Header controls, right-aligned (buttons, a SegmentedControl, a Badge). */
  actions?: ReactNode;
  /** Footer row under the body, separated by a hairline. */
  footer?: ReactNode;
  /** Luminous hairline along the top edge, in this colour. Default `none`. */
  accent?: SurfaceAccent;
  /** Lit state: brighter border and an outer bloom in the accent colour (active / success). */
  glow?: boolean;
  /** Body padding. Default `md`; use `none` for edge-to-edge tables and lists. */
  padding?: SurfacePadding;
  /** Heading level of the title. Default 2 (the Page title is the h1). */
  headingLevel?: 2 | 3 | 4;
  /** Element to render. Default `section`. */
  as?: 'section' | 'div' | 'article' | 'aside';
  /** Class for the body wrapper. */
  bodyClassName?: string;
}

/**
 * The standard glass surface: translucent abyss-blue, a faint luminous border
 * and an inner highlight. Quiet at rest — give it an `accent` (and `glow` when
 * it represents something active) to let it carry light.
 */
export function Panel({
  title,
  subtitle,
  icon,
  actions,
  footer,
  accent = 'none',
  glow = false,
  padding = 'md',
  headingLevel = 2,
  as = 'section',
  className,
  bodyClassName,
  children,
  ...rest
}: PanelProps) {
  const headingId = useId();
  const hasHeader = title !== undefined || actions !== undefined;
  const labelled = title !== undefined && rest['aria-label'] === undefined && as === 'section';

  return createElement(
    as,
    {
      ...rest,
      'aria-labelledby': labelled ? headingId : rest['aria-labelledby'],
      'data-accent': accent,
      'data-glow': glow || undefined,
      className: cx(styles.panel, className),
    },
    hasHeader ? (
      <header className={styles.header}>
        <div className={styles.heading}>
          {icon ? <span className={styles.icon}>{icon}</span> : null}
          <div className={styles.titles}>
            {title !== undefined
              ? createElement(`h${headingLevel}`, { id: headingId, className: styles.title }, title)
              : null}
            {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
          </div>
        </div>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </header>
    ) : null,
    <div className={cx(styles.body, styles[`pad-${padding}`], bodyClassName)}>{children}</div>,
    footer ? <footer className={styles.footer}>{footer}</footer> : null,
  );
}

interface CardOwnProps {
  /** Hover / focus affordance for clickable cards. Implied by `onClick`. */
  interactive?: boolean;
  /** Selected state: lit border and tinted fill. */
  selected?: boolean;
  /** Colour of the selected / hover light. Default `cyan`. */
  accent?: Exclude<SurfaceAccent, 'none'>;
  /** Padding. Default `md`. */
  padding?: SurfacePadding;
  className?: string;
  children?: ReactNode;
}

export type CardProps = CardOwnProps &
  Omit<ComponentProps<'div'>, keyof CardOwnProps | 'onClick'> & {
    /** Makes the card a real `<button>` (keyboard operable, `aria-pressed` reflects `selected`). */
    onClick?: () => void;
    /** Disables a clickable card. */
    disabled?: boolean;
  };

/**
 * A compact tile for lists and grids (hunts, recipes, search results). With
 * `onClick` it renders as a button; otherwise as a plain container.
 */
export function Card({
  interactive,
  selected = false,
  accent = 'cyan',
  padding = 'md',
  className,
  children,
  onClick,
  disabled,
  ...rest
}: CardProps) {
  const classes = cx(
    styles.card,
    styles[`pad-${padding}`],
    (interactive ?? onClick !== undefined) && styles.interactive,
    className,
  );
  const shared = {
    'data-accent': accent,
    'data-selected': selected || undefined,
    className: classes,
  };

  if (onClick !== undefined) {
    const { role, id, style, title, tabIndex } = rest;
    return (
      <button
        type="button"
        {...shared}
        id={id}
        role={role}
        style={style}
        title={title}
        tabIndex={tabIndex}
        aria-label={rest['aria-label']}
        aria-labelledby={rest['aria-labelledby']}
        aria-describedby={rest['aria-describedby']}
        aria-pressed={role === undefined ? selected : undefined}
        aria-selected={role === 'option' ? selected : undefined}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </button>
    );
  }

  return (
    <div {...rest} {...shared}>
      {children}
    </div>
  );
}
