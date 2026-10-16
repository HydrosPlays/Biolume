import type { ChangeEvent, ComponentProps, ReactNode } from 'react';
import { useFieldControl } from './Field';
import { cx } from './internal/cx';
import type { ControlSize } from './internal/types';
import control from './internal/control.module.css';
import styles from './TextField.module.css';

export interface TextFieldProps extends Omit<ComponentProps<'input'>, 'size'> {
  /** Control height. Default `md`. */
  size?: ControlSize;
  /** Marks the field invalid (red border, `aria-invalid`). Inherited from `Field` when omitted. */
  invalid?: boolean;
  /** Content inside the well before the text — usually a 16px icon. */
  leading?: ReactNode;
  /** Content inside the well after the text — a unit, a clear button, a Kbd hint. */
  trailing?: ReactNode;
  /** Called with the new string on every change (in addition to `onChange`). */
  onValueChange?: (value: string) => void;
  /** Use the monospace face (ids, paths, accelerators). */
  mono?: boolean;
  /** Stretch to the container width. Default true. */
  fullWidth?: boolean;
  /** Class for the outer well (the `className` prop goes to the `<input>`). */
  wrapperClassName?: string;
}

/** Single-line text input. Works standalone (pass `aria-label`) or inside a `Field`. */
export function TextField({
  size = 'md',
  invalid,
  leading,
  trailing,
  onValueChange,
  onChange,
  mono = false,
  fullWidth = true,
  wrapperClassName,
  className,
  disabled,
  type = 'text',
  ...rest
}: TextFieldProps) {
  const field = useFieldControl({ ...rest, invalid });

  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    onChange?.(event);
    onValueChange?.(event.target.value);
  };

  return (
    <div
      className={cx(
        control.control,
        control[size],
        fullWidth && control.fullWidth,
        wrapperClassName,
      )}
      data-invalid={field.invalid}
      data-disabled={disabled ?? false}
    >
      {leading ? <span className={control.adornment}>{leading}</span> : null}
      <input
        spellCheck={false}
        autoComplete="off"
        {...rest}
        id={field.id}
        type={type}
        disabled={disabled}
        aria-invalid={field.invalid || undefined}
        aria-required={field.required || undefined}
        aria-describedby={field['aria-describedby']}
        className={cx(control.native, mono && styles.mono, className)}
        onChange={handleChange}
      />
      {trailing ? <span className={control.adornment}>{trailing}</span> : null}
    </div>
  );
}
