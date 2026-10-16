import type { ComponentProps, CSSProperties, ReactNode } from 'react';
import { X } from 'lucide-react';
import { titleCase } from '@renderer/lib/format';
import { cx } from './internal/cx';
import type { Tone } from './internal/types';
import styles from './Badge.module.css';

export interface BadgeProps extends Omit<ComponentProps<'span'>, 'children'> {
  /** Colour family. Default `neutral`. */
  tone?: Tone;
  /** `soft` (tinted fill), `outline` (border only) or `solid` (filled — use sparingly). Default `soft`. */
  variant?: 'soft' | 'outline' | 'solid';
  /** Default `md`; `sm` for dense tables. */
  size?: 'sm' | 'md';
  /** Leading status dot; `pulse` makes it breathe (live states). */
  dot?: boolean | 'pulse';
  /** Leading icon (12px). */
  icon?: ReactNode;
  children: ReactNode;
}

/** A small, non-interactive status label: "Active", "Lv. 3", "2 phases". */
export function Badge({
  tone = 'neutral',
  variant = 'soft',
  size = 'md',
  dot = false,
  icon,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      {...rest}
      data-tone={tone}
      className={cx(styles.badge, styles[variant], styles[size], className)}
    >
      {dot ? (
        <span className={cx(styles.dot, dot === 'pulse' && styles.pulse)} aria-hidden="true" />
      ) : null}
      {icon ? <span className={styles.icon}>{icon}</span> : null}
      {children}
    </span>
  );
}

export interface ChipProps {
  children: ReactNode;
  /** Colour family used when selected / hovered. Default `accent`. */
  tone?: Tone;
  /** Leading icon or sprite. */
  icon?: ReactNode;
  /** Toggle state for filter chips (`aria-pressed`). */
  selected?: boolean;
  /** Makes the chip a button. */
  onClick?: () => void;
  /** Adds a remove button after the label; called when it is pressed. */
  onRemove?: () => void;
  /** Accessible name of the remove button. Default "Remove". */
  removeLabel?: string;
  disabled?: boolean;
  /** Default `md`. */
  size?: 'sm' | 'md';
  className?: string;
  style?: CSSProperties;
  title?: string;
}

/**
 * A pill for filters, tags and selections. Static by default; a toggle button
 * with `onClick`; dismissible with `onRemove`.
 */
export function Chip({
  children,
  tone = 'accent',
  icon,
  selected = false,
  onClick,
  onRemove,
  removeLabel = 'Remove',
  disabled = false,
  size = 'md',
  className,
  style,
  title,
}: ChipProps) {
  const content = (
    <>
      {icon ? <span className={styles.icon}>{icon}</span> : null}
      <span className={styles.chipLabel}>{children}</span>
    </>
  );
  const classes = cx(
    styles.chip,
    styles[size],
    onClick !== undefined && styles.clickable,
    onRemove !== undefined && styles.removable,
    className,
  );

  return (
    <span
      className={classes}
      style={style}
      title={title}
      data-tone={tone}
      data-selected={selected || undefined}
      data-disabled={disabled || undefined}
    >
      {onClick !== undefined ? (
        <button
          type="button"
          className={styles.chipButton}
          aria-pressed={selected}
          disabled={disabled}
          onClick={onClick}
        >
          {content}
        </button>
      ) : (
        <span className={styles.chipButton}>{content}</span>
      )}
      {onRemove !== undefined ? (
        <button
          type="button"
          className={styles.remove}
          aria-label={removeLabel}
          disabled={disabled}
          onClick={onRemove}
        >
          <X aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}

/** Every type slug with a `--type-*` token. */
export const POKEMON_TYPES = [
  'normal',
  'fire',
  'water',
  'electric',
  'grass',
  'ice',
  'fighting',
  'poison',
  'ground',
  'flying',
  'psychic',
  'bug',
  'rock',
  'ghost',
  'dragon',
  'dark',
  'steel',
  'fairy',
  'stellar',
] as const;
export type PokemonType = (typeof POKEMON_TYPES)[number];

/** The CSS colour for a type slug (`var(--type-fire)`); a neutral ink for unknown slugs. */
export function typeColor(type: string): string {
  const slug = type.toLowerCase();
  return (POKEMON_TYPES as readonly string[]).includes(slug)
    ? `var(--type-${slug})`
    : 'var(--ink-300)';
}

export interface TypeBadgeProps {
  /** PokeAPI type slug, e.g. `fire`. Unknown slugs render in neutral ink. */
  type: string;
  /** Default `md`; `sm` for dense rows; `dot` renders only a coloured dot with an accessible name. */
  size?: 'sm' | 'md' | 'dot';
  /** Filter-chip mode: renders a toggle button. */
  onClick?: () => void;
  /** Selected state in filter-chip mode. */
  selected?: boolean;
  /** Label override (defaults to the title-cased slug). */
  label?: string;
  className?: string;
}

/** A Pokémon type label in its type colour — static, or a toggle button when `onClick` is given. */
export function TypeBadge({
  type,
  size = 'md',
  onClick,
  selected,
  label,
  className,
}: TypeBadgeProps) {
  const text = label ?? titleCase(type);
  const style = { '--type-color': typeColor(type) } as CSSProperties;

  if (size === 'dot') {
    return (
      <span
        className={cx(styles.typeDot, className)}
        style={style}
        role="img"
        aria-label={`${text} type`}
        title={text}
      />
    );
  }

  const classes = cx(
    styles.type,
    styles[size],
    onClick !== undefined && styles.typeButton,
    className,
  );
  if (onClick !== undefined) {
    return (
      <button
        type="button"
        className={classes}
        style={style}
        aria-pressed={selected ?? false}
        data-selected={selected || undefined}
        onClick={onClick}
      >
        {text}
      </button>
    );
  }
  return (
    <span className={classes} style={style} data-selected={selected || undefined}>
      {text}
    </span>
  );
}
