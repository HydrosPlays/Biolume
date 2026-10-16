import type { ChangeEvent, CSSProperties } from 'react';
import { useFieldControl } from './Field';
import { cx } from './internal/cx';
import styles from './Slider.module.css';

export interface SliderProps {
  /** Current value (controlled). */
  value: number;
  /** Called continuously while dragging / on every key step. */
  onChange: (value: number) => void;
  /** Called once when the user lets go (pointer up / key up) — use it for expensive commits. */
  onCommit?: (value: number) => void;
  /** Default 0. */
  min?: number;
  /** Default 100. */
  max?: number;
  /** Default 1. */
  step?: number;
  disabled?: boolean;
  /** Formats the value for the read-out and for `aria-valuetext` (`(v) => formatPercent(v)`). */
  formatValue?: (value: number) => string;
  /** Show the formatted value after the track. Default true. */
  showValue?: boolean;
  /** Colour of the filled part. Default cyan; `shiny` for shiny-related scales. */
  tone?: 'accent' | 'teal' | 'violet' | 'shiny';
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  className?: string;
}

/** A native range input with a glowing fill — volume, overlay opacity, UI scale. */
export function Slider({
  value,
  onChange,
  onCommit,
  min = 0,
  max = 100,
  step = 1,
  disabled = false,
  formatValue,
  showValue = true,
  tone = 'accent',
  className,
  ...rest
}: SliderProps) {
  const field = useFieldControl(rest);
  const span = max - min;
  const fraction = span <= 0 ? 0 : Math.min(Math.max((value - min) / span, 0), 1);
  const text = formatValue ? formatValue(value) : String(value);

  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const next = Number(event.target.value);
    if (Number.isFinite(next)) onChange(next);
  };
  const commit = (): void => onCommit?.(value);

  return (
    <div
      className={cx(styles.slider, className)}
      data-tone={tone}
      data-disabled={disabled || undefined}
      style={{ '--fill': fraction } as CSSProperties}
    >
      <div className={styles.trackWrap}>
        <div className={styles.track} aria-hidden="true">
          <div className={styles.fill} />
        </div>
        <input
          type="range"
          id={field.id}
          className={styles.input}
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-label={rest['aria-label']}
          aria-labelledby={rest['aria-labelledby']}
          aria-describedby={field['aria-describedby']}
          aria-valuetext={formatValue ? text : undefined}
          onChange={handleChange}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
        />
      </div>
      {showValue ? (
        <output className={styles.value} htmlFor={field.id}>
          {text}
        </output>
      ) : null}
    </div>
  );
}
