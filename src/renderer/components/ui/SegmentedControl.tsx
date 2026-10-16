import { useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { useFieldControl } from './Field';
import { cx } from './internal/cx';
import styles from './SegmentedControl.module.css';

export interface SegmentedOption<V extends string = string> {
  value: V;
  label: ReactNode;
  /** Leading icon (14px). */
  icon?: ReactNode;
  disabled?: boolean;
  /** Accessible name when `label` is not plain text (icon-only segments). */
  'aria-label'?: string;
}

export interface SegmentedControlProps<V extends string = string> {
  options: readonly SegmentedOption<V>[];
  /** Selected value (controlled). */
  value: V;
  onChange: (value: V) => void;
  /** Default `md`. */
  size?: 'sm' | 'md';
  /** Segments share the container width equally. */
  fullWidth?: boolean;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  className?: string;
}

/**
 * A compact one-of-N switch for 2–5 mutually exclusive modes (JSON / CSV,
 * merge / replace, chart modes). A `radiogroup` with roving focus: arrow keys
 * move and select, Home / End jump.
 */
export function SegmentedControl<V extends string = string>({
  options,
  value,
  onChange,
  size = 'md',
  fullWidth = false,
  disabled = false,
  className,
  ...rest
}: SegmentedControlProps<V>) {
  const field = useFieldControl(rest);
  const groupRef = useRef<HTMLDivElement | null>(null);
  const selectedIndex = options.findIndex((option) => option.value === value);

  const focusAndSelect = (index: number): void => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[index]?.focus();
  };

  const step = (from: number, direction: 1 | -1): void => {
    for (let offset = 1; offset <= options.length; offset += 1) {
      const index = (from + direction * offset + options.length * offset) % options.length;
      if (!options[index]?.disabled) {
        focusAndSelect(index);
        return;
      }
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const current = selectedIndex === -1 ? 0 : selectedIndex;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        step(current, 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        step(current, -1);
        break;
      case 'Home':
        step(-1, 1);
        break;
      case 'End':
        step(options.length, -1);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div
      ref={groupRef}
      id={field.id}
      role="radiogroup"
      aria-label={rest['aria-label']}
      aria-labelledby={rest['aria-labelledby'] ?? field.labelId}
      aria-describedby={field['aria-describedby']}
      aria-disabled={disabled || undefined}
      className={cx(styles.group, styles[size], fullWidth && styles.fullWidth, className)}
      style={
        {
          '--segments': options.length,
          '--selected': Math.max(selectedIndex, 0),
        } as CSSProperties
      }
      onKeyDown={onKeyDown}
    >
      {/* The lit thumb slides between equal-width segments. */}
      {selectedIndex !== -1 ? <span className={styles.thumb} aria-hidden="true" /> : null}
      {options.map((option, index) => {
        const selected = index === selectedIndex;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option['aria-label']}
            disabled={disabled || option.disabled}
            // Roving tabindex: the group is one tab stop.
            tabIndex={selected || (selectedIndex === -1 && index === 0) ? 0 : -1}
            className={styles.segment}
            onClick={() => onChange(option.value)}
          >
            {option.icon ? <span className={styles.icon}>{option.icon}</span> : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
