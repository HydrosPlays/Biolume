import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { CircleCheck, CircleX, Info, TriangleAlert, X } from 'lucide-react';
import { useUiStore, type ToastItem, type ToastTone } from '@renderer/store/uiStore';
import { cx } from './internal/cx';
import type { Tone } from './internal/types';
import styles from './Toast.module.css';

const TONES: Record<ToastTone, Tone> = {
  success: 'teal',
  error: 'danger',
  info: 'accent',
  warning: 'warn',
};

function ToneIcon({ tone }: { tone: ToastTone }) {
  switch (tone) {
    case 'success':
      return <CircleCheck aria-hidden="true" />;
    case 'error':
      return <CircleX aria-hidden="true" />;
    case 'warning':
      return <TriangleAlert aria-hidden="true" />;
    case 'info':
      return <Info aria-hidden="true" />;
  }
}

function ToastCard({ toast }: { toast: ToastItem }) {
  const dismissToast = useUiStore((state) => state.dismissToast);
  const [paused, setPaused] = useState(false);
  const remaining = useRef(toast.duration);
  const startedAt = useRef(0);

  // A replaced toast (same id, new revision) gets its full time again.
  useEffect(() => {
    remaining.current = toast.duration;
  }, [toast.revision, toast.duration]);

  useEffect(() => {
    if (toast.duration <= 0 || paused) return undefined;
    startedAt.current = Date.now();
    const timer = window.setTimeout(() => dismissToast(toast.id), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current));
    };
  }, [toast.id, toast.duration, toast.revision, paused, dismissToast]);

  return (
    <div
      role={toast.tone === 'error' ? 'alert' : 'status'}
      data-tone={TONES[toast.tone]}
      className={styles.toast}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className={styles.icon}>
        <ToneIcon tone={toast.tone} />
      </span>
      <div className={styles.text}>
        <p className={styles.title}>{toast.title}</p>
        {toast.description ? <p className={styles.description}>{toast.description}</p> : null}
      </div>
      {toast.action ? (
        <button
          type="button"
          className={styles.action}
          onClick={() => {
            toast.action?.onClick();
            dismissToast(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
      <button
        type="button"
        className={styles.close}
        aria-label="Dismiss notification"
        onClick={() => dismissToast(toast.id)}
      >
        <X aria-hidden="true" />
      </button>
      {toast.duration > 0 ? (
        <span
          key={toast.revision}
          className={cx(styles.timer, paused && styles.timerPaused)}
          style={{ '--toast-duration': `${toast.duration}ms` } as CSSProperties}
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
}

/**
 * Renders the toast queue (bottom-right, newest at the bottom). Mount exactly
 * once per window — the app shell does. Toasts auto-dismiss, pause while
 * hovered or focused, and errors are announced assertively.
 */
export function ToastRegion() {
  const toasts = useUiStore((state) => state.toasts);
  return createPortal(
    <div className={styles.region} role="region" aria-label="Notifications">
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </div>,
    document.body,
  );
}
