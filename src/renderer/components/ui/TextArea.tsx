import type { ChangeEvent, ComponentProps } from 'react';
import { useFieldControl } from './Field';
import { cx } from './internal/cx';
import control from './internal/control.module.css';
import styles from './TextField.module.css';

export interface TextAreaProps extends ComponentProps<'textarea'> {
  /** Marks the field invalid. Inherited from `Field` when omitted. */
  invalid?: boolean;
  /** Called with the new string on every change (in addition to `onChange`). */
  onValueChange?: (value: string) => void;
  /** Show a `used / max` character counter; needs `maxLength` and a controlled `value`. */
  showCount?: boolean;
  /** Allow dragging the bottom edge to resize. Default true. */
  resizable?: boolean;
  /** Class for the outer well (the `className` prop goes to the `<textarea>`). */
  wrapperClassName?: string;
}

/** Multi-line text input (hunt notes, phase notes). */
export function TextArea({
  invalid,
  onValueChange,
  onChange,
  showCount = false,
  resizable = true,
  wrapperClassName,
  className,
  disabled,
  rows = 3,
  maxLength,
  value,
  ...rest
}: TextAreaProps) {
  const field = useFieldControl({ ...rest, invalid });
  const length = typeof value === 'string' ? value.length : null;
  const counted = showCount && maxLength !== undefined && length !== null;

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    onChange?.(event);
    onValueChange?.(event.target.value);
  };

  return (
    <div
      className={cx(control.control, control.fullWidth, styles.area, wrapperClassName)}
      data-invalid={field.invalid}
      data-disabled={disabled ?? false}
    >
      <textarea
        spellCheck={false}
        {...rest}
        id={field.id}
        rows={rows}
        value={value}
        maxLength={maxLength}
        disabled={disabled}
        aria-invalid={field.invalid || undefined}
        aria-required={field.required || undefined}
        aria-describedby={field['aria-describedby']}
        className={cx(styles.textarea, !resizable && styles.noResize, className)}
        onChange={handleChange}
      />
      {counted ? (
        <span
          className={cx(styles.count, length > maxLength * 0.9 && styles.countNear)}
          aria-hidden="true"
        >
          {length} / {maxLength}
        </span>
      ) : null}
    </div>
  );
}
