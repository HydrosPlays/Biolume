import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { useKeyboardCapture } from '@renderer/hooks/useKeyboardCapture';
import { useFieldControl } from './Field';
import { cx } from './internal/cx';
import { scrollIntoViewIfNeeded } from './internal/dom';
import { Portal } from './internal/Portal';
import { useAnchoredPosition } from './internal/position';
import type { ControlSize } from './internal/types';
import control from './internal/control.module.css';
import styles from './Select.module.css';

export interface SelectOption<V extends string = string> {
  value: V;
  /** Primary line; also what type-ahead matches against. */
  label: string;
  /** Secondary line under the label (a method's one-line summary). */
  description?: string;
  /** Right-aligned detail — odds, a generation badge, a year. */
  meta?: ReactNode;
  /** Leading icon or sprite. */
  icon?: ReactNode;
  disabled?: boolean;
  /** Extra text type-ahead should also match (abbreviations: "SV", "BDSP"). */
  keywords?: string;
}

export interface SelectGroup<V extends string = string> {
  /** Group header, e.g. "Generation 9". */
  label: string;
  options: readonly SelectOption<V>[];
}

export type SelectItem<V extends string = string> = SelectOption<V> | SelectGroup<V>;

export interface SelectProps<V extends string = string> {
  /** Options, optionally nested one level into labelled groups. */
  options: readonly SelectItem<V>[];
  /** Selected value (controlled); null shows the placeholder. */
  value: V | null;
  /** Called when the user picks a different option than the current one. */
  onChange: (value: V, option: SelectOption<V>) => void;
  /** Shown while nothing is selected. */
  placeholder?: string;
  /** Control height. Default `md`. */
  size?: ControlSize;
  disabled?: boolean;
  /** Marks the control invalid. Inherited from `Field` when omitted. */
  invalid?: boolean;
  /** Stretch to the container width. Default true. */
  fullWidth?: boolean;
  /** Custom rendering of the selected option inside the trigger. */
  renderValue?: (option: SelectOption<V>) => ReactNode;
  /** Max height of the list in px before it scrolls. Default 340. */
  maxHeight?: number;
  /** Shown instead of the list when there are no options. */
  emptyMessage?: ReactNode;
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  className?: string;
}

function isGroup<V extends string>(item: SelectItem<V>): item is SelectGroup<V> {
  return 'options' in item;
}

const TYPEAHEAD_RESET_MS = 600;
const PAGE_SIZE = 8;

/**
 * A custom single-select dropdown following the ARIA "select-only combobox"
 * pattern: the trigger is a `combobox` that keeps DOM focus, the popup is a
 * `listbox` (with `group`s), and the active option is tracked through
 * `aria-activedescendant`.
 *
 * Keyboard — closed: ↓ / ↑ / Enter / Space / Alt+↓ open, Home / End open at
 * the first / last option, printable characters open and type-ahead.
 * Open: ↓ / ↑ move, Home / End, PageUp / PageDown, type-ahead, Enter / Space
 * select, Tab selects and moves on, Escape closes without selecting.
 *
 * The popup is portalled and flips / shrinks to stay inside the window.
 */
export function Select<V extends string = string>({
  options,
  value,
  onChange,
  placeholder = 'Select…',
  size = 'md',
  disabled = false,
  invalid,
  fullWidth = true,
  renderValue,
  maxHeight = 340,
  emptyMessage = 'No options',
  className,
  ...rest
}: SelectProps<V>) {
  const field = useFieldControl({ ...rest, invalid });
  const generatedId = useId();
  const baseId = field.id ?? `select-${generatedId}`;
  const listId = `${baseId}-listbox`;
  const valueId = `${baseId}-value`;

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const typeahead = useRef({ text: '', at: 0 });

  const flat = useMemo(
    () => options.flatMap((item) => (isGroup(item) ? item.options : [item])),
    [options],
  );
  const selectedIndex = flat.findIndex((option) => option.value === value);
  const selected = selectedIndex === -1 ? null : (flat[selectedIndex] ?? null);

  const optionId = (index: number): string => `${baseId}-option-${index}`;

  const firstEnabled = useCallback(
    (from: number, direction: 1 | -1): number => {
      for (let index = from; index >= 0 && index < flat.length; index += direction) {
        if (!flat[index]?.disabled) return index;
      }
      return -1;
    },
    [flat],
  );

  const openList = useCallback(
    (preferred?: number): void => {
      if (disabled) return;
      const start =
        preferred ??
        (selectedIndex !== -1 && !selected?.disabled ? selectedIndex : firstEnabled(0, 1));
      setActiveIndex(start);
      setOpen(true);
    },
    [disabled, firstEnabled, selected?.disabled, selectedIndex],
  );

  const close = useCallback((): void => {
    setOpen(false);
    typeahead.current.text = '';
  }, []);

  const choose = (index: number): void => {
    const option = flat[index];
    if (!option || option.disabled) return;
    close();
    if (option.value !== value) onChange(option.value, option);
  };

  // While open the list owns the keyboard: in-app hotkeys must not fire on type-ahead.
  useKeyboardCapture(open);
  useAnchoredPosition({
    open,
    anchorRef: triggerRef,
    floatingRef: listRef,
    matchWidth: true,
    offset: 6,
  });

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (triggerRef.current?.contains(target) || listRef.current?.contains(target)) return;
      close();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', close);
    };
  }, [open, close]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    scrollIntoViewIfNeeded(document.getElementById(`${baseId}-option-${activeIndex}`));
  }, [open, activeIndex, baseId]);

  const move = (delta: number): void => {
    if (flat.length === 0) return;
    const direction = delta > 0 ? 1 : -1;
    const target = Math.min(
      Math.max((activeIndex < 0 ? -1 : activeIndex) + delta, 0),
      flat.length - 1,
    );
    // Land on the nearest enabled option, searching onward first, then back.
    let next = firstEnabled(target, direction);
    if (next === -1) next = firstEnabled(target, direction === 1 ? -1 : 1);
    if (next !== -1) setActiveIndex(next);
  };

  const runTypeahead = (character: string): void => {
    const now = Date.now();
    const state = typeahead.current;
    state.text = now - state.at > TYPEAHEAD_RESET_MS ? character : state.text + character;
    state.at = now;

    const query = state.text.toLowerCase();
    // Repeating one letter cycles through the options that start with it.
    const cycling = query.length > 1 && [...query].every((char) => char === query[0]);
    const needle = cycling ? (query[0] ?? '') : query;
    const start = cycling || query.length === 1 ? activeIndex + 1 : Math.max(activeIndex, 0);

    for (let offset = 0; offset < flat.length; offset += 1) {
      const index = (start + offset) % flat.length;
      const option = flat[index];
      if (!option || option.disabled) continue;
      const haystacks = [option.label, ...(option.keywords?.split(/\s+/) ?? [])];
      if (haystacks.some((text) => text.toLowerCase().startsWith(needle))) {
        setActiveIndex(index);
        return;
      }
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled) return;
    const { key } = event;
    const printable =
      key.length === 1 && key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey;

    if (!open) {
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') {
        event.preventDefault();
        openList();
      } else if (key === 'Home') {
        event.preventDefault();
        openList(firstEnabled(0, 1));
      } else if (key === 'End') {
        event.preventDefault();
        openList(firstEnabled(flat.length - 1, -1));
      } else if (printable) {
        event.preventDefault();
        openList();
        runTypeahead(key);
      }
      return;
    }

    switch (key) {
      case 'ArrowDown':
        if (event.altKey) return;
        move(1);
        break;
      case 'ArrowUp':
        if (event.altKey) {
          choose(activeIndex);
          break;
        }
        move(-1);
        break;
      case 'Home':
        setActiveIndex(firstEnabled(0, 1));
        break;
      case 'End':
        setActiveIndex(firstEnabled(flat.length - 1, -1));
        break;
      case 'PageDown':
        move(PAGE_SIZE);
        break;
      case 'PageUp':
        move(-PAGE_SIZE);
        break;
      case 'Enter':
      case ' ':
        if (
          key === ' ' &&
          typeahead.current.text !== '' &&
          Date.now() - typeahead.current.at < TYPEAHEAD_RESET_MS
        ) {
          // Mid type-ahead a space is part of the query ("Let's Go").
          runTypeahead(' ');
          break;
        }
        choose(activeIndex);
        break;
      case 'Escape':
        close();
        break;
      case 'Tab':
        // Commit the active option and let focus move on naturally.
        choose(activeIndex);
        close();
        return;
      default:
        if (!printable) return;
        runTypeahead(key);
    }
    event.preventDefault();
  };

  let runningIndex = -1;
  const renderOption = (option: SelectOption<V>): ReactNode => {
    runningIndex += 1;
    const index = runningIndex;
    const isSelected = index === selectedIndex;
    return (
      <div
        key={option.value}
        id={optionId(index)}
        role="option"
        aria-selected={isSelected}
        aria-disabled={option.disabled || undefined}
        data-active={index === activeIndex || undefined}
        className={styles.option}
        onPointerMove={() => {
          if (!option.disabled && index !== activeIndex) setActiveIndex(index);
        }}
        onClick={() => choose(index)}
      >
        {option.icon ? <span className={styles.optionIcon}>{option.icon}</span> : null}
        <span className={styles.optionText}>
          <span className={styles.optionLabel}>{option.label}</span>
          {option.description ? (
            <span className={styles.optionDescription}>{option.description}</span>
          ) : null}
        </span>
        {option.meta !== undefined && option.meta !== null ? (
          <span className={styles.optionMeta}>{option.meta}</span>
        ) : null}
        <Check className={styles.check} aria-hidden="true" />
      </div>
    );
  };

  // Named by its label only; the selected text is the combobox's value (ARIA select-only pattern).
  const labelledBy = rest['aria-labelledby'] ?? field.labelId;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={baseId}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        aria-label={rest['aria-label']}
        aria-labelledby={labelledBy}
        aria-describedby={field['aria-describedby']}
        aria-invalid={field.invalid || undefined}
        aria-required={field.required || undefined}
        disabled={disabled}
        data-open={open}
        data-invalid={field.invalid}
        data-disabled={disabled}
        className={cx(
          control.control,
          control[size],
          fullWidth && control.fullWidth,
          styles.trigger,
          className,
        )}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onKeyDown}
        onBlur={close}
      >
        <span id={valueId} className={cx(styles.value, !selected && styles.placeholder)}>
          {selected ? (
            renderValue ? (
              renderValue(selected)
            ) : (
              <>
                {selected.icon ? <span className={styles.optionIcon}>{selected.icon}</span> : null}
                <span className={styles.valueLabel}>{selected.label}</span>
              </>
            )
          ) : (
            placeholder
          )}
        </span>
        <ChevronDown className={styles.chevron} aria-hidden="true" />
      </button>

      {open ? (
        <Portal>
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-labelledby={field.labelId ?? rest['aria-labelledby']}
            aria-label={field.labelId || rest['aria-labelledby'] ? undefined : rest['aria-label']}
            tabIndex={-1}
            className={styles.list}
            style={{ maxHeight: `min(${maxHeight}px, var(--available-size, ${maxHeight}px))` }}
            // Keep DOM focus on the trigger: the list is driven through aria-activedescendant.
            onMouseDown={(event) => event.preventDefault()}
          >
            {flat.length === 0 ? <div className={styles.empty}>{emptyMessage}</div> : null}
            {options.map((item, groupIndex) =>
              isGroup(item) ? (
                <div
                  key={`group-${item.label}-${groupIndex}`}
                  role="group"
                  aria-labelledby={`${baseId}-group-${groupIndex}`}
                  className={styles.group}
                >
                  <div
                    id={`${baseId}-group-${groupIndex}`}
                    className={styles.groupLabel}
                    role="presentation"
                  >
                    {item.label}
                  </div>
                  {item.options.map(renderOption)}
                </div>
              ) : (
                renderOption(item)
              ),
            )}
          </div>
        </Portal>
      ) : null}
    </>
  );
}
