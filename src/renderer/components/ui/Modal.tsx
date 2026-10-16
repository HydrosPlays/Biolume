import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useKeyboardCapture } from '@renderer/hooks/useKeyboardCapture';
import { cx } from './internal/cx';
import { getFocusable } from './internal/dom';
import { PortalContext } from './internal/Portal';
import styles from './Modal.module.css';

export interface ModalProps {
  /** Whether the dialog is shown. Unmounted while false. */
  open: boolean;
  /** Called on Escape, scrim click and the close button. */
  onClose: () => void;
  /** Dialog heading; also its accessible name. */
  title: ReactNode;
  /** Supporting line under the title; linked as the dialog's description. */
  description?: ReactNode;
  /** Icon tile before the title (18px lucide icon). */
  icon?: ReactNode;
  children?: ReactNode;
  /** Action row, right-aligned — typically a ghost "Cancel" and one primary Button. */
  footer?: ReactNode;
  /** Max width: `sm` 400, `md` 540 (default), `lg` 760. */
  size?: 'sm' | 'md' | 'lg';
  /** Colour of the top hairline and icon: `rare` (violet) for phases, `shiny` (gold), `danger`. */
  tone?: 'default' | 'rare' | 'shiny' | 'danger';
  /** Close when the backdrop is clicked. Default true. */
  closeOnScrim?: boolean;
  /** Close on Escape. Default true. */
  closeOnEscape?: boolean;
  /** Hide the × button (when the footer already offers a way out). */
  hideCloseButton?: boolean;
  /** Element to focus on open. Default: the first `[data-autofocus]`, else the first focusable in the body. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** When set, the dialog content is a `<form>` and Enter in a field calls this. */
  onSubmit?: () => void;
  /** `alertdialog` for confirmations that interrupt. Default `dialog`. */
  role?: 'dialog' | 'alertdialog';
  /** Class for the dialog surface. */
  className?: string;
}

/** Open modals, bottom → top. Only the topmost reacts to Escape and traps Tab. */
const stack: string[] = [];

/**
 * A modal dialog: scrim, focus trap, Escape to close, focus restored to the
 * element that opened it. While open it holds the keyboard, so in-app hotkeys
 * and view shortcuts are suspended. Dropdowns and tooltips used inside it are
 * portalled into the modal's own layer.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  icon,
  children,
  footer,
  size = 'md',
  tone = 'default',
  closeOnScrim = true,
  closeOnEscape = true,
  hideCloseButton = false,
  initialFocusRef,
  onSubmit,
  role = 'dialog',
  className,
}: ModalProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const pressStartedOnScrim = useRef(false);

  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useKeyboardCapture(open);

  // Focus management: move focus in on open, give it back on close.
  useEffect(() => {
    if (!open) return undefined;
    const dialog = dialogRef.current;
    if (!dialog) return undefined;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const body = dialog.querySelector<HTMLElement>('[data-modal-body]');
    const target =
      initialFocusRef?.current ??
      dialog.querySelector<HTMLElement>('[data-autofocus]') ??
      (body ? getFocusable(body)[0] : undefined) ??
      getFocusable(dialog).find((element) => !element.hasAttribute('data-modal-close')) ??
      dialog;
    target.focus({ preventScroll: true });

    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true });
    };
  }, [open, initialFocusRef]);

  // Escape + Tab trap, for the topmost modal only.
  useEffect(() => {
    if (!open) return undefined;
    stack.push(id);

    const onKeyDown = (event: KeyboardEvent): void => {
      if (stack.at(-1) !== id) return;
      const dialog = dialogRef.current;
      if (!dialog) return;

      if (event.key === 'Escape') {
        // A widget inside (open Select, search field) may have consumed it already.
        if (event.defaultPrevented || !closeOnEscape) return;
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key !== 'Tab') return;
      const focusable = getFocusable(dialog);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const current = document.activeElement;
      const inside = current instanceof Node && dialog.contains(current);
      if (event.shiftKey) {
        if (!inside || current === first || current === dialog) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || current === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const index = stack.lastIndexOf(id);
      if (index !== -1) stack.splice(index, 1);
    };
  }, [open, id, closeOnEscape]);

  if (!open) return null;

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onSubmit?.();
  };

  const content = (
    <>
      <header className={styles.header}>
        {icon ? (
          <span className={styles.icon} aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <div className={styles.titles}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          {description ? (
            <p id={descriptionId} className={styles.description}>
              {description}
            </p>
          ) : null}
        </div>
        {hideCloseButton ? null : (
          <button
            type="button"
            className={styles.close}
            aria-label="Close dialog"
            data-modal-close=""
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        )}
      </header>
      {children !== undefined && children !== null ? (
        <div className={styles.body} data-modal-body="">
          {children}
        </div>
      ) : null}
      {footer ? <footer className={styles.footer}>{footer}</footer> : null}
    </>
  );

  return createPortal(
    <div
      ref={setLayer}
      className={styles.layer}
      onMouseDown={(event) => {
        pressStartedOnScrim.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        // Only a full click on the scrim closes — not a text selection that ends outside the dialog.
        if (closeOnScrim && pressStartedOnScrim.current && event.target === event.currentTarget)
          onClose();
        pressStartedOnScrim.current = false;
      }}
    >
      <div className={styles.scrim} aria-hidden="true" />
      <PortalContext.Provider value={layer}>
        <div
          ref={dialogRef}
          role={role}
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          tabIndex={-1}
          data-tone={tone}
          className={cx(styles.dialog, styles[size], className)}
        >
          {onSubmit ? (
            <form className={styles.form} onSubmit={handleSubmit} noValidate>
              {content}
            </form>
          ) : (
            content
          )}
        </div>
      </PortalContext.Provider>
    </div>,
    document.body,
  );
}
