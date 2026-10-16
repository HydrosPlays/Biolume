import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { HOTKEY_ACTION_LABELS } from '@shared/defaults';
import type { HotkeyAction } from '@shared/types';
import { Kbd } from '@renderer/components/ui';
import { useKeyboardCapture } from '@renderer/hooks';
import { formatAccelerator } from '@renderer/lib/accelerator';
import { actions } from '@renderer/store';
import {
  captureStep,
  evaluateRecording,
  type Bindings,
  type RecordingVerdict,
} from './hotkeyRecording';
import styles from './Settings.module.css';

export interface ShortcutRecorderProps {
  action: HotkeyAction;
  bindings: Bindings;
  /** A combination was accepted; the recorder is expected to unmount. */
  onAccept: (verdict: Extract<RecordingVerdict, { ok: true }>) => void;
  /** A combination was refused (the recording stays open), or null when the user starts over. */
  onReject: (message: string | null) => void;
  /** Esc, or focus moved elsewhere. */
  onCancel: (reason: 'escape' | 'blur') => void;
}

/**
 * Records one key combination. It exists only while recording: mounting it
 * suspends every hotkey — the global ones in the main process, the in-app ones
 * through the keyboard claim — and unmounting it always hands them back,
 * whichever way the recording ended.
 */
export function ShortcutRecorder({
  action,
  bindings,
  onAccept,
  onReject,
  onCancel,
}: ShortcutRecorderProps) {
  const ref = useRef<HTMLDivElement>(null);
  /** Key caps of what is held right now, or of the combination that was just refused. */
  const [caps, setCaps] = useState<string[]>([]);
  const [refused, setRefused] = useState(false);

  useKeyboardCapture(true);

  useEffect(() => {
    void actions.setHotkeyCapturing(true);
    return () => {
      void actions.setHotkeyCapturing(false);
    };
  }, []);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Nothing typed here may reach the app's own shortcuts, a button or the browser.
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;

    const step = captureStep(event);
    if (step.kind === 'cancel') {
      onCancel('escape');
      return;
    }
    if (step.kind === 'pending') {
      setCaps(step.held);
      if (refused) {
        setRefused(false);
        onReject(null);
      }
      return;
    }

    const verdict = evaluateRecording(bindings, action, step.accelerator);
    if (verdict.ok) {
      onAccept(verdict);
      return;
    }
    setCaps(formatAccelerator(step.accelerator));
    setRefused(true);
    onReject(verdict.message);
  };

  const handleKeyUp = (event: KeyboardEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    if (refused) return;
    const step = captureStep(event);
    if (step.kind === 'pending') setCaps(step.held);
  };

  const label = HOTKEY_ACTION_LABELS[action];
  return (
    <div
      ref={ref}
      className={styles.recorder}
      tabIndex={0}
      role="group"
      aria-label={`Recording a shortcut for ${label}. Press a key combination, or Escape to cancel.`}
      data-recording={action}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onBlur={() => onCancel('blur')}
    >
      <span className={styles.recDot} aria-hidden="true" />
      <span aria-live="polite">
        {caps.length === 0 ? (
          'Press a key combination…'
        ) : (
          <Kbd keys={refused ? caps : [...caps, '…']} size="sm" />
        )}
      </span>
      <span className={styles.recHint}>
        <Kbd size="sm">Esc</Kbd> cancels
      </span>
    </div>
  );
}
