import { useId, type ReactNode } from 'react';
import { Check, Minus } from 'lucide-react';
import { useFieldControl } from './Field';
import { cx } from './internal/cx';
import styles from './Toggle.module.css';

interface BinaryControlProps {
  /** Current state (controlled). */
  checked: boolean;
  /** Called with the next state when the user flips it. */
  onChange: (checked: boolean) => void;
  /** Visible label; clicking it flips the control. Omit inside a `Field` or pass `aria-label`. */
  label?: ReactNode;
  /** Secondary line under the label, linked as the control's description. */
  description?: ReactNode;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  className?: string;
}

export interface ToggleProps extends BinaryControlProps {
  /** Default `md`. */
  size?: 'sm' | 'md';
  /** Put the switch after the label, pushed to the far edge (settings rows). Default false. */
  trailing?: boolean;
}

/** An on/off switch (`role="switch"`) for settings that apply immediately. */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  size = 'md',
  trailing = false,
  className,
  ...rest
}: ToggleProps) {
  const field = useFieldControl(rest);
  const generatedId = useId();
  const id = field.id ?? `toggle-${generatedId}`;
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;
  const hasLabel = label !== undefined && label !== null;
  const describedBy = [field['aria-describedby'], description ? descriptionId : undefined]
    .filter(Boolean)
    .join(' ');

  const control = (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={rest['aria-label']}
      aria-labelledby={rest['aria-labelledby'] ?? (hasLabel ? labelId : field.labelId)}
      aria-describedby={describedBy === '' ? undefined : describedBy}
      disabled={disabled}
      className={cx(styles.switch, styles[size], !hasLabel && className)}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.thumb} />
    </button>
  );

  if (!hasLabel) return control;

  return (
    <div
      className={cx(styles.row, trailing && styles.trailing, className)}
      data-disabled={disabled || undefined}
    >
      {control}
      <div className={styles.text}>
        {/* A plain click target rather than <label for>: the switch is a button, and its name comes from aria-labelledby. */}
        <span
          id={labelId}
          className={styles.label}
          onClick={() => {
            if (!disabled) onChange(!checked);
          }}
        >
          {label}
        </span>
        {description ? (
          <span id={descriptionId} className={styles.description}>
            {description}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export interface CheckboxProps extends BinaryControlProps {
  /** Mixed state for "select all" boxes; shown as a dash and reported as `aria-checked="mixed"`. */
  indeterminate?: boolean;
  /** Form field name. */
  name?: string;
}

/** A native checkbox with the Biolume look — for multi-select lists and opt-ins confirmed by a button. */
export function Checkbox({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  indeterminate = false,
  name,
  className,
  ...rest
}: CheckboxProps) {
  const field = useFieldControl(rest);
  const generatedId = useId();
  const id = field.id ?? `checkbox-${generatedId}`;
  const descriptionId = `${id}-description`;
  const describedBy = [field['aria-describedby'], description ? descriptionId : undefined]
    .filter(Boolean)
    .join(' ');

  return (
    <label className={cx(styles.checkRow, className)} data-disabled={disabled || undefined}>
      <span className={styles.checkWrap}>
        <input
          type="checkbox"
          id={id}
          name={name}
          className={styles.checkInput}
          checked={checked}
          disabled={disabled}
          aria-label={rest['aria-label']}
          aria-labelledby={rest['aria-labelledby']}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          aria-checked={indeterminate ? 'mixed' : undefined}
          ref={(node) => {
            if (node) node.indeterminate = indeterminate;
          }}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span
          className={styles.box}
          data-indeterminate={indeterminate || undefined}
          aria-hidden="true"
        >
          {indeterminate ? <Minus /> : <Check />}
        </span>
      </span>
      {label !== undefined && label !== null ? (
        <span className={styles.text}>
          <span className={styles.label}>{label}</span>
          {description ? (
            <span id={descriptionId} className={styles.description}>
              {description}
            </span>
          ) : null}
        </span>
      ) : null}
    </label>
  );
}
