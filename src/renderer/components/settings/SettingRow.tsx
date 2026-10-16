import { useId, useRef, useState, type ReactNode } from 'react';
import styles from './Settings.module.css';

export interface SettingRowIds {
  'aria-labelledby': string;
  'aria-describedby': string | undefined;
}

export interface SettingRowProps {
  label: ReactNode;
  description?: ReactNode;
  /** Receives the ids that name and describe the control. */
  children: (ids: SettingRowIds) => ReactNode;
}

/** A settings line: what it is on the left, its control on the right — the Toggle row's sibling. */
export function SettingRow({ label, description, children }: SettingRowProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;
  return (
    <div className={styles.row}>
      <div className={styles.rowText}>
        <span id={labelId} className={styles.rowLabel}>
          {label}
        </span>
        {description ? (
          <span id={descriptionId} className={styles.rowDescription}>
            {description}
          </span>
        ) : null}
      </div>
      <div className={styles.rowControl}>
        {children({
          'aria-labelledby': labelId,
          'aria-describedby': description ? descriptionId : undefined,
        })}
      </div>
    </div>
  );
}

export interface DraftNumber {
  /** What the control shows: the value being dragged, else the stored one. */
  value: number;
  onChange: (value: number) => void;
  onCommit: (value: number) => void;
}

/**
 * A slider value that follows the pointer at once while the store catches up.
 * `write` saves through the main process; with `live` every step is saved (the
 * change is audible / visible immediately), otherwise only the value the user
 * lets go of. The local draft is dropped once the save has come back, so the
 * control never jumps back to the previous value in between.
 */
export function useDraftNumber(
  stored: number,
  write: (value: number) => Promise<unknown>,
  options: { live?: boolean } = {},
): DraftNumber {
  const [draft, setDraft] = useState<number | null>(null);
  const edit = useRef(0);
  const lastWritten = useRef<number | null>(null);
  /** The most recent save; saves complete in the order they were sent. */
  const pending = useRef<Promise<unknown>>(Promise.resolve());

  const save = (value: number): Promise<unknown> => {
    if (value !== (lastWritten.current ?? stored)) {
      lastWritten.current = value;
      pending.current = write(value);
    }
    return pending.current;
  };

  return {
    value: draft ?? stored,
    onChange(value) {
      edit.current += 1;
      setDraft(value);
      if (options.live) void save(value);
    },
    onCommit(value) {
      const current = (edit.current += 1);
      void save(value).finally(() => {
        // A newer edit owns the draft now.
        if (edit.current !== current) return;
        lastWritten.current = null;
        setDraft(null);
      });
    },
  };
}
