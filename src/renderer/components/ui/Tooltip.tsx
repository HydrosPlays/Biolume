import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import { cx } from './internal/cx';
import { mergeRefs } from './internal/dom';
import { Portal } from './internal/Portal';
import { useAnchoredPosition, type Align, type Placement } from './internal/position';
import { Kbd } from './Kbd';
import styles from './Tooltip.module.css';

/** Whether focus arrived by keyboard; engines without `:focus-visible` count as keyboard. */
function isKeyboardFocus(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

/** Props a tooltip trigger must accept (every DOM element and every UI-kit control does). */
interface TriggerProps {
  ref?: Ref<HTMLElement>;
  onMouseEnter?: (event: MouseEvent<HTMLElement>) => void;
  onMouseLeave?: (event: MouseEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
  'aria-describedby'?: string;
}

export interface TooltipProps {
  /** Tooltip body. Nothing is shown (and no listeners matter) when empty. */
  content: ReactNode;
  /** The trigger: one element that forwards `ref`, mouse and focus handlers to a DOM node. */
  children: ReactElement<TriggerProps>;
  /** Preferred side; flips automatically when there is no room. Default `top`. */
  placement?: Placement;
  /** Alignment along the trigger's edge. Default `center`. */
  align?: Align;
  /** Electron accelerator shown as key caps after the text. */
  shortcut?: string;
  /** Milliseconds of hover before showing. Focus shows immediately. Default 350. */
  delay?: number;
  /** Suppress the tooltip without unwrapping the trigger. */
  disabled?: boolean;
  /**
   * The tooltip only repeats the trigger's accessible name (icon buttons): keep
   * it visual and do not also attach it as a description.
   */
  decorative?: boolean;
  /** Max width in px before wrapping. Default 260. */
  maxWidth?: number;
}

/**
 * Hover / focus hint attached to a single child. The content is linked through
 * `aria-describedby`, appears on keyboard focus, and hides on Escape, blur,
 * pointer-leave and when the trigger is pressed.
 */
export function Tooltip({
  content,
  children,
  placement = 'top',
  align = 'center',
  shortcut,
  delay = 350,
  disabled = false,
  decorative = false,
  maxWidth = 260,
}: TooltipProps) {
  const id = useId();
  const anchorRef = useRef<HTMLElement | null>(null);
  const floatingRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);

  const empty = content === null || content === undefined || content === false || content === '';
  const active = open && !disabled && !empty;

  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setOpen(false);
  }, []);

  const show = useCallback((wait: number) => {
    window.clearTimeout(timer.current);
    if (wait <= 0) setOpen(true);
    else timer.current = window.setTimeout(() => setOpen(true), wait);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    if (!active) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') hide();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, [active, hide]);

  useAnchoredPosition({ open: active, anchorRef, floatingRef, placement, align, offset: 8 });

  const child = children.props;
  const describedBy = [child['aria-describedby'], active && !decorative ? id : undefined]
    .filter(Boolean)
    .join(' ');

  const trigger = cloneElement(children, {
    ref: mergeRefs(anchorRef, child.ref),
    'aria-describedby': describedBy === '' ? undefined : describedBy,
    onMouseEnter: (event: MouseEvent<HTMLElement>) => {
      child.onMouseEnter?.(event);
      show(delay);
    },
    onMouseLeave: (event: MouseEvent<HTMLElement>) => {
      child.onMouseLeave?.(event);
      hide();
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      child.onFocus?.(event);
      // Only for keyboard focus: a mouse click also focuses, and must not pop the hint.
      if (isKeyboardFocus(event.target)) show(0);
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      child.onBlur?.(event);
      hide();
    },
  });

  return (
    <>
      {trigger}
      {active ? (
        <Portal>
          <div
            ref={floatingRef}
            id={id}
            role="tooltip"
            aria-hidden={decorative || undefined}
            className={cx(styles.tooltip)}
            style={{ maxWidth }}
          >
            <span className={styles.content}>{content}</span>
            {shortcut ? <Kbd accelerator={shortcut} size="sm" /> : null}
          </div>
        </Portal>
      ) : null}
    </>
  );
}
