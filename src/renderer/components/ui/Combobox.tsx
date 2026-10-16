import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { Search, X } from 'lucide-react';
import { useKeyboardCapture } from '@renderer/hooks/useKeyboardCapture';
import { useFieldControl } from './Field';
import { cx } from './internal/cx';
import { mergeRefs, scrollIntoViewIfNeeded } from './internal/dom';
import { Portal } from './internal/Portal';
import { useAnchoredPosition } from './internal/position';
import type { ControlSize } from './internal/types';
import { Spinner } from './Spinner';
import control from './internal/control.module.css';
import selectStyles from './Select.module.css';
import styles from './Combobox.module.css';

export interface SearchInputProps extends Omit<
  ComponentProps<'input'>,
  'size' | 'value' | 'onChange' | 'type'
> {
  /** Current text (controlled). */
  value: string;
  /** Called with the new text on every keystroke and when cleared. */
  onValueChange: (value: string) => void;
  /** Control height. Default `md`. */
  size?: ControlSize;
  /** Show a spinner in place of the clear button (a request is in flight). */
  loading?: boolean;
  /** Show the clear (×) button while there is text. Default true. */
  clearable?: boolean;
  /** Replaces the magnifier icon. */
  leading?: ReactNode;
  /** Marks the field invalid. Inherited from `Field` when omitted. */
  invalid?: boolean;
  /** Class for the outer well. */
  wrapperClassName?: string;
  /** Ref to the outer well (popover anchor). */
  wrapperRef?: Ref<HTMLDivElement>;
}

/** A search text field: magnifier, clear button, loading state. Escape clears the text. */
export function SearchInput({
  value,
  onValueChange,
  size = 'md',
  loading = false,
  clearable = true,
  leading,
  invalid,
  wrapperClassName,
  wrapperRef,
  className,
  disabled,
  onKeyDown,
  ref,
  ...rest
}: SearchInputProps) {
  const field = useFieldControl({ ...rest, invalid });
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div
      ref={wrapperRef}
      className={cx(control.control, control[size], control.fullWidth, wrapperClassName)}
      data-invalid={field.invalid}
      data-disabled={disabled ?? false}
    >
      <span className={control.adornment} aria-hidden="true">
        {leading ?? <Search className={styles.searchIcon} />}
      </span>
      <input
        role="searchbox"
        spellCheck={false}
        autoComplete="off"
        {...rest}
        ref={mergeRefs(inputRef, ref)}
        id={field.id}
        type="text"
        value={value}
        disabled={disabled}
        aria-invalid={field.invalid || undefined}
        aria-describedby={field['aria-describedby']}
        className={cx(control.native, className)}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.key === 'Escape' && !event.defaultPrevented && value !== '') {
            event.preventDefault();
            onValueChange('');
          }
        }}
      />
      <span className={cx(control.adornment, styles.trailing)}>
        {loading ? (
          <Spinner size={14} />
        ) : clearable && value !== '' && !disabled ? (
          <button
            type="button"
            className={styles.clear}
            aria-label="Clear search"
            // Not a tab stop: Escape in the field does the same.
            tabIndex={-1}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onValueChange('');
              inputRef.current?.focus();
            }}
          >
            <X aria-hidden="true" />
          </button>
        ) : null}
      </span>
    </div>
  );
}

export interface ComboboxItemState {
  /** Highlighted by keyboard or pointer. */
  active: boolean;
  index: number;
}

export interface ComboboxProps<T> {
  /** Text in the input (controlled). */
  value: string;
  /** Called with the new text on every keystroke; the caller filters / fetches `items`. */
  onValueChange: (value: string) => void;
  /** Results to offer, already filtered and ordered. */
  items: readonly T[];
  /** Stable unique key per item. */
  getKey: (item: T) => string;
  /** Renders one result row (sprite, name, type badges …). */
  renderItem: (item: T, state: ComboboxItemState) => ReactNode;
  /** Plain-text name of an item, used as the option's accessible name. */
  getLabel: (item: T) => string;
  /** Called when a result is chosen (Enter or click). The popover closes; update `value` as needed. */
  onSelect: (item: T) => void;
  /** Items that are listed but cannot be chosen. */
  isItemDisabled?: (item: T) => boolean;
  /** A request is in flight: shows a spinner in the field and a busy state in the list. */
  loading?: boolean;
  /** Shown when `items` is empty and the query is long enough. Default "No matches". */
  emptyMessage?: ReactNode;
  /** Minimum characters before the popover opens. Default 1 (0 opens on focus). */
  minChars?: number;
  /** Static row above the results (a result count, a filter hint). */
  header?: ReactNode;
  /** Static row under the results (data source, keyboard hints). */
  footer?: ReactNode;
  /** Max height of the results list in px. Default 360. */
  maxHeight?: number;
  /** Control height. Default `md`. */
  size?: ControlSize;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Marks the field invalid. Inherited from `Field` when omitted. */
  invalid?: boolean;
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  className?: string;
}

/**
 * A text input with a results popover — the species search. The caller owns
 * the query text and the result list; this component owns highlighting,
 * keyboard navigation and positioning.
 *
 * Keyboard: ↓ / ↑ move through results (wrapping), Enter chooses, Escape
 * closes the popover (a second Escape clears the text), Home / End act on the
 * text as usual. Follows the ARIA editable-combobox pattern with list
 * autocomplete (`aria-activedescendant`; focus never leaves the input).
 */
export function Combobox<T>({
  value,
  onValueChange,
  items,
  getKey,
  renderItem,
  getLabel,
  onSelect,
  isItemDisabled,
  loading = false,
  emptyMessage = 'No matches',
  minChars = 1,
  header,
  footer,
  maxHeight = 360,
  size = 'md',
  placeholder,
  disabled = false,
  autoFocus = false,
  invalid,
  className,
  ...rest
}: ComboboxProps<T>) {
  const field = useFieldControl({ ...rest, invalid });
  const generatedId = useId();
  const baseId = field.id ?? `combobox-${generatedId}`;
  const listId = `${baseId}-listbox`;

  const anchorRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const longEnough = value.trim().length >= minChars;
  const open = focused && !dismissed && !disabled && longEnough;

  const optionId = (index: number): string => `${baseId}-option-${index}`;
  const enabled = (index: number): boolean => {
    const item = items[index];
    return item !== undefined && !(isItemDisabled?.(item) ?? false);
  };

  // New results: highlight the first selectable one.
  const firstEnabled = items.findIndex((item) => !(isItemDisabled?.(item) ?? false));
  const itemsKey = items.map(getKey).join('\u0000');
  useEffect(() => {
    // Keyed on the identity of the result set, not on the array instance.
    setActiveIndex(firstEnabled);
  }, [itemsKey, firstEnabled]);

  useKeyboardCapture(open);
  useAnchoredPosition({ open, anchorRef, floatingRef: popoverRef, matchWidth: true, offset: 6 });

  useEffect(() => {
    if (open && activeIndex >= 0) {
      scrollIntoViewIfNeeded(document.getElementById(`${baseId}-option-${activeIndex}`));
    }
  }, [open, activeIndex, baseId]);

  const move = (direction: 1 | -1): void => {
    if (items.length === 0) return;
    let index = activeIndex;
    for (let attempts = 0; attempts < items.length; attempts += 1) {
      index = (index + direction + items.length) % items.length;
      if (enabled(index)) {
        setActiveIndex(index);
        return;
      }
    }
  };

  const choose = (index: number): void => {
    const item = items[index];
    if (item === undefined || !enabled(index)) return;
    setDismissed(true);
    onSelect(item);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!open) setDismissed(false);
        else move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (!open) setDismissed(false);
        else move(-1);
        break;
      case 'Enter':
        if (open && activeIndex >= 0) {
          event.preventDefault();
          choose(activeIndex);
        }
        break;
      case 'Escape':
        if (open) {
          // First Escape only closes the list; SearchInput clears on the next one.
          event.preventDefault();
          setDismissed(true);
        }
        break;
      default:
    }
  };

  const showEmpty = items.length === 0 && !loading;

  return (
    <>
      <SearchInput
        {...(placeholder === undefined ? {} : { placeholder })}
        id={baseId}
        value={value}
        size={size}
        loading={loading}
        disabled={disabled}
        autoFocus={autoFocus}
        invalid={field.invalid}
        wrapperRef={anchorRef}
        wrapperClassName={className}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        aria-label={rest['aria-label']}
        aria-labelledby={rest['aria-labelledby']}
        aria-describedby={rest['aria-describedby']}
        onValueChange={(next) => {
          setDismissed(false);
          onValueChange(next);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          setDismissed(false);
        }}
        onKeyDown={onKeyDown}
      />
      {open ? (
        <Portal>
          <div
            ref={popoverRef}
            className={cx(selectStyles.list, styles.popover)}
            style={{ maxHeight: `min(${maxHeight}px, var(--available-size, ${maxHeight}px))` }}
            // Keep focus in the input while clicking results.
            onMouseDown={(event) => event.preventDefault()}
          >
            {header ? <div className={styles.header}>{header}</div> : null}
            <div
              id={listId}
              role="listbox"
              aria-label={rest['aria-label'] ?? 'Results'}
              aria-busy={loading || undefined}
              className={styles.results}
            >
              {items.map((item, index) => {
                const active = index === activeIndex;
                const itemDisabled = !enabled(index);
                return (
                  <div
                    key={getKey(item)}
                    id={optionId(index)}
                    role="option"
                    aria-selected={active}
                    aria-disabled={itemDisabled || undefined}
                    aria-label={getLabel(item)}
                    data-active={active || undefined}
                    className={cx(selectStyles.option, styles.item)}
                    onPointerMove={() => {
                      if (!itemDisabled && !active) setActiveIndex(index);
                    }}
                    onClick={() => choose(index)}
                  >
                    {renderItem(item, { active, index })}
                  </div>
                );
              })}
            </div>
            {showEmpty ? <div className={selectStyles.empty}>{emptyMessage}</div> : null}
            {loading && items.length === 0 ? (
              <div className={selectStyles.empty}>
                <Spinner size={16} label="Searching" />
              </div>
            ) : null}
            {footer ? <div className={styles.footer}>{footer}</div> : null}
          </div>
        </Portal>
      ) : null}
    </>
  );
}
