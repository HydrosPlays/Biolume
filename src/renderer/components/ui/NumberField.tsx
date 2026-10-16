import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useFieldControl } from './Field';
import { cx } from './internal/cx';
import type { ControlSize } from './internal/types';
import control from './internal/control.module.css';
import styles from './NumberField.module.css';

export interface NumberFieldProps {
  /** Committed value (controlled). */
  value: number;
  /**
   * Called with a finite number already clamped to `[min, max]` and rounded to
   * `precision` — on Enter, blur, stepper press, arrow keys and wheel. Never
   * called for intermediate keystrokes.
   */
  onChange: (value: number) => void;
  /** Lower bound. Default: none. */
  min?: number;
  /** Upper bound. Default: none. */
  max?: number;
  /** Amount for the steppers, ↑ / ↓ and the wheel. Default 1. */
  step?: number;
  /** Amount for PageUp / PageDown and Shift+↑ / ↓. Default `step × 10`. */
  largeStep?: number;
  /** Decimal places kept. Default: the number of decimals in `step` (0 for whole steps). */
  precision?: number;
  /** Control height. Default `md`. */
  size?: ControlSize;
  disabled?: boolean;
  /** Marks the field invalid. Inherited from `Field` when omitted. */
  invalid?: boolean;
  /** Unit or symbol shown after the number ("%", "Lv."). */
  suffix?: ReactNode;
  /** Hide the − / + stepper buttons (keyboard and wheel still work). */
  hideSteppers?: boolean;
  /** Change the value with the mouse wheel while the field is focused. Default true. */
  wheel?: boolean;
  /** How the committed value is displayed while not being edited (e.g. `formatCount`). */
  format?: (value: number) => string;
  /** Width in `ch` of the input. Default fits `max` or 6 digits. */
  width?: number;
  placeholder?: string;
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  className?: string;
}

function decimalsOf(value: number): number {
  const text = String(value);
  const exponent = /e-(\d+)$/.exec(text);
  if (exponent?.[1]) return Number(exponent[1]);
  return text.includes('.') ? text.length - text.indexOf('.') - 1 : 0;
}

function roundTo(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

/** Parses free-typed numeric text: tolerates thousands separators, spaces and a decimal comma. */
export function parseNumberInput(text: string): number | null {
  // `\s` covers the no-break and narrow spaces some locales group digits with.
  let cleaned = text.trim().replace(/[\s_]/g, '');
  if (cleaned === '') return null;
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  if (
    lastComma !== -1 &&
    lastDot === -1 &&
    /,\d{1,2}$/.test(cleaned) &&
    cleaned.indexOf(',') === lastComma
  ) {
    // A single comma followed by one or two digits is a decimal comma ("3,5").
    cleaned = cleaned.replace(',', '.');
  } else {
    cleaned = cleaned.replace(/,/g, '');
  }
  // U+2212 MINUS SIGN, as produced by formatSigned and by some keyboards.
  cleaned = cleaned.replace(/^−/, '-');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

const HOLD_DELAY_MS = 380;
const HOLD_INTERVAL_MS = 55;

/**
 * Numeric input with stepper buttons. Text is free while typing and committed
 * on Enter or blur: unparsable text reverts, out-of-range values clamp.
 * Keyboard: ↑ / ↓ step, Shift or PageUp / PageDown large step, Home / End jump
 * to `min` / `max`, Escape reverts. Steppers repeat while held.
 */
export function NumberField({
  value,
  onChange,
  min,
  max,
  step = 1,
  largeStep,
  precision,
  size = 'md',
  disabled = false,
  invalid,
  suffix,
  hideSteppers = false,
  wheel = true,
  format,
  width,
  placeholder,
  className,
  ...rest
}: NumberFieldProps) {
  const field = useFieldControl({ ...rest, invalid });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const holdTimer = useRef<number | undefined>(undefined);

  const decimals = precision ?? decimalsOf(step);
  const bigStep = largeStep ?? step * 10;

  const constrain = (next: number): number => {
    let result = roundTo(next, decimals);
    if (min !== undefined) result = Math.max(result, min);
    if (max !== undefined) result = Math.min(result, max);
    return result;
  };

  // The freshest committed value, so held steppers and wheel bursts accumulate
  // without waiting for the parent to re-render.
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  }, [value]);

  const commit = (next: number): void => {
    const constrained = constrain(next);
    setDraft(null);
    if (constrained !== latest.current) {
      latest.current = constrained;
      onChange(constrained);
    }
  };

  const commitDraft = (): void => {
    if (draft === null) return;
    const parsed = parseNumberInput(draft);
    if (parsed === null) setDraft(null);
    else commit(parsed);
  };

  const nudge = (amount: number): void => {
    const base = draft === null ? latest.current : (parseNumberInput(draft) ?? latest.current);
    commit(base + amount);
  };
  // Timers and the wheel listener outlive the render that created them; they call the freshest nudge.
  const nudgeRef = useRef(nudge);
  useEffect(() => {
    nudgeRef.current = nudge;
  });

  const stopHold = useCallback((): void => {
    window.clearTimeout(holdTimer.current);
    window.clearInterval(holdTimer.current);
    holdTimer.current = undefined;
    window.removeEventListener('pointerup', stopHold);
    window.removeEventListener('blur', stopHold);
  }, []);
  useEffect(() => stopHold, [stopHold]);

  const startHold = (event: PointerEvent<HTMLButtonElement>, amount: number): void => {
    if (event.button !== 0 || disabled) return;
    // Keep focus (and the caret) in the input rather than on the stepper.
    event.preventDefault();
    inputRef.current?.focus();
    nudge(amount);
    stopHold();
    // A stepper that disables itself at the bound stops receiving pointer events,
    // so the release is also watched on the window.
    window.addEventListener('pointerup', stopHold);
    window.addEventListener('blur', stopHold);
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = window.setInterval(() => {
        const before = latest.current;
        nudgeRef.current(amount);
        if (latest.current === before) stopHold();
      }, HOLD_INTERVAL_MS);
    }, HOLD_DELAY_MS);
  };

  // React registers wheel listeners as passive, so preventDefault needs a native one.
  const wheelHandler = useRef<(event: WheelEvent) => void>(() => undefined);
  useEffect(() => {
    wheelHandler.current = (event: WheelEvent): void => {
      if (!wheel || disabled || document.activeElement !== inputRef.current || event.deltaY === 0)
        return;
      event.preventDefault();
      nudgeRef.current(event.deltaY < 0 ? step : -step);
    };
  });
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return undefined;
    const listener = (event: WheelEvent): void => wheelHandler.current(event);
    input.addEventListener('wheel', listener, { passive: false });
    return () => input.removeEventListener('wheel', listener);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case 'ArrowUp':
        nudge(event.shiftKey ? bigStep : step);
        break;
      case 'ArrowDown':
        nudge(event.shiftKey ? -bigStep : -step);
        break;
      case 'PageUp':
        nudge(bigStep);
        break;
      case 'PageDown':
        nudge(-bigStep);
        break;
      case 'Home':
        if (min === undefined) return;
        commit(min);
        break;
      case 'End':
        if (max === undefined) return;
        commit(max);
        break;
      case 'Enter':
        commitDraft();
        return;
      case 'Escape':
        if (draft === null) return;
        setDraft(null);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const onBlur = (_event: FocusEvent<HTMLInputElement>): void => {
    stopHold();
    commitDraft();
  };

  const shown =
    draft ?? (format ? format(value) : decimals > 0 ? value.toFixed(decimals) : String(value));
  const widthCh =
    width ?? Math.max(String(max ?? 999_999).length, 3) + (decimals > 0 ? decimals + 1 : 0);
  const atMin = min !== undefined && value <= min;
  const atMax = max !== undefined && value >= max;

  return (
    <div
      className={cx(control.control, control[size], styles.field, className)}
      data-invalid={field.invalid}
      data-disabled={disabled}
    >
      <input
        ref={inputRef}
        id={field.id}
        type="text"
        inputMode={decimals > 0 ? 'decimal' : 'numeric'}
        role="spinbutton"
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        disabled={disabled}
        value={shown}
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuetext={format ? format(value) : undefined}
        aria-invalid={field.invalid || undefined}
        aria-required={field.required || undefined}
        aria-label={rest['aria-label']}
        aria-labelledby={rest['aria-labelledby']}
        aria-describedby={field['aria-describedby']}
        className={cx(control.native, styles.input)}
        style={{ width: `calc(${widthCh}ch + 2 * var(--space-3))` }}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => event.target.select()}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      />
      {suffix ? <span className={styles.suffix}>{suffix}</span> : null}
      {hideSteppers ? null : (
        <span className={styles.steppers}>
          <button
            type="button"
            tabIndex={-1}
            aria-label="Increase"
            className={styles.stepper}
            disabled={disabled || atMax}
            onPointerDown={(event) => startHold(event, step)}
            onPointerUp={stopHold}
            onPointerLeave={stopHold}
            onPointerCancel={stopHold}
          >
            <ChevronUp aria-hidden="true" />
          </button>
          <button
            type="button"
            tabIndex={-1}
            aria-label="Decrease"
            className={styles.stepper}
            disabled={disabled || atMin}
            onPointerDown={(event) => startHold(event, -step)}
            onPointerUp={stopHold}
            onPointerLeave={stopHold}
            onPointerCancel={stopHold}
          >
            <ChevronDown aria-hidden="true" />
          </button>
        </span>
      )}
    </div>
  );
}
