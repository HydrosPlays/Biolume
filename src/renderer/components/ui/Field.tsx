import { createContext, useContext, useId, useMemo, type ReactNode } from 'react';
import { cx } from './internal/cx';
import styles from './Field.module.css';

interface FieldContextValue {
  controlId: string;
  labelId: string;
  descriptionId: string | undefined;
  invalid: boolean;
  required: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

export interface FieldProps {
  /** Visible label; linked to the control inside automatically. */
  label: ReactNode;
  /** Helper text under the control. Hidden while `error` is shown. */
  hint?: ReactNode;
  /** Validation message; also marks the control invalid. */
  error?: ReactNode;
  /** Shows a required marker and sets `aria-required` on the control. */
  required?: boolean;
  /** Keep the label for assistive tech only (the layout already makes it obvious). */
  labelHidden?: boolean;
  /** Content on the label row's far side — a counter, a "Reset" link, a Kbd hint. */
  trailing?: ReactNode;
  /** `horizontal` puts the label left of the control (settings rows). Default `vertical`. */
  orientation?: 'vertical' | 'horizontal';
  /** Explicit control id; generated when omitted. */
  id?: string;
  className?: string;
  /** Exactly one UI-kit control (TextField, NumberField, Select, Slider, …). */
  children: ReactNode;
}

/**
 * Label + hint + error wrapper. Controls from this kit placed inside pick up
 * their `id`, `aria-describedby`, invalid and required state from it — no
 * manual wiring.
 */
export function Field({
  label,
  hint,
  error,
  required = false,
  labelHidden = false,
  trailing,
  orientation = 'vertical',
  id,
  className,
  children,
}: FieldProps) {
  const generatedId = useId();
  const controlId = id ?? `field-${generatedId}`;
  const labelId = `${controlId}-label`;
  const hasError = error !== undefined && error !== null && error !== false && error !== '';
  const hasHint = hint !== undefined && hint !== null && hint !== false && hint !== '';
  const descriptionId = hasError || hasHint ? `${controlId}-description` : undefined;

  const context = useMemo<FieldContextValue>(
    () => ({ controlId, labelId, descriptionId, invalid: hasError, required }),
    [controlId, labelId, descriptionId, hasError, required],
  );

  return (
    <FieldContext.Provider value={context}>
      <div
        className={cx(styles.field, orientation === 'horizontal' && styles.horizontal, className)}
      >
        <div className={cx(styles.labelRow, labelHidden && 'sr-only')}>
          <label id={labelId} htmlFor={controlId} className={styles.label}>
            {label}
            {required ? (
              <span className={styles.required} aria-hidden="true">
                *
              </span>
            ) : null}
          </label>
          {trailing ? <span className={styles.trailing}>{trailing}</span> : null}
        </div>
        <div className={styles.body}>
          {children}
          {hasError ? (
            <p id={descriptionId} className={styles.error} role="alert">
              {error}
            </p>
          ) : hasHint ? (
            <p id={descriptionId} className={styles.hint}>
              {hint}
            </p>
          ) : null}
        </div>
      </div>
    </FieldContext.Provider>
  );
}

export interface FieldControlInput {
  id?: string | undefined;
  invalid?: boolean | undefined;
  required?: boolean | undefined;
  'aria-describedby'?: string | undefined;
  'aria-labelledby'?: string | undefined;
  'aria-label'?: string | undefined;
}

export interface FieldControlProps {
  id: string | undefined;
  invalid: boolean;
  required: boolean;
  'aria-describedby': string | undefined;
  /** The enclosing Field's label id, unless the control names itself. */
  labelId: string | undefined;
}

/**
 * Resolves a control's wiring against the enclosing {@link Field} (if any).
 * Explicit props always win. Use it when building a custom control that
 * should work inside `Field`.
 */
export function useFieldControl(props: FieldControlInput): FieldControlProps {
  const field = useContext(FieldContext);
  const describedBy = [props['aria-describedby'], field?.descriptionId].filter(Boolean).join(' ');
  const namesItself = props['aria-label'] !== undefined || props['aria-labelledby'] !== undefined;
  return {
    id: props.id ?? field?.controlId,
    invalid: props.invalid ?? field?.invalid ?? false,
    required: props.required ?? field?.required ?? false,
    'aria-describedby': describedBy === '' ? undefined : describedBy,
    labelId: namesItself ? undefined : field?.labelId,
  };
}
