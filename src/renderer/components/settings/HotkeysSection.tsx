import { useEffect, useRef, useState } from 'react';
import { Keyboard, Plus, RotateCcw, TriangleAlert, X } from 'lucide-react';
import { HOTKEY_ACTION_LABELS } from '@shared/defaults';
import { SHINY_CONFIRM_WINDOW_MS } from '@shared/streamDeck';
import {
  HOTKEY_ACTIONS,
  MAX_BINDINGS_PER_ACTION,
  type HotkeyAction,
  type HotkeyStatus,
} from '@shared/types';
import { Badge, Button, Kbd, Panel, Toggle, toast } from '@renderer/components/ui';
import { isRiskyGlobalAccelerator } from '@renderer/lib/accelerator';
import { actions, useHotkeyStatus, useSettings } from '@renderer/store';
import {
  activeCountPreset,
  applyCountPreset,
  bindingsEqual,
  bindingStatus,
  canAddBinding,
  COUNT_PRESETS,
  defaultBindings,
  describeAccelerator,
  explainMode,
  removeBinding,
  RISKY_KEY_WARNING,
  type Bindings,
  type CountPreset,
  type RecordingVerdict,
} from './hotkeyRecording';
import styles from './Settings.module.css';
import { ShortcutRecorder } from './ShortcutRecorder';

const SHINY_CONFIRM_SECONDS = Math.round(SHINY_CONFIRM_WINDOW_MS / 1000);

const ACTION_HINTS: Record<HotkeyAction, string> = {
  increment: 'Adds one step to the active hunt',
  decrement: 'Takes one step back off the count',
  undo: 'Reverts the last count, phase or completion',
  logPhase: 'Logs a phase now; name the shiny later',
  shinyFound: `Completes the hunt — press it twice within ${SHINY_CONFIRM_SECONDS} s, so a stray tap only arms it`,
  toggleOverlay: 'Opens or closes the floating counter',
};

function saveBindings(patch: Partial<Bindings>): void {
  void actions.updateSettings({ hotkeys: { bindings: patch } });
}

interface HotkeyRowProps {
  action: HotkeyAction;
  bindings: Bindings;
  status: HotkeyStatus;
  globalEnabled: boolean;
  recording: boolean;
  /** Why the last recorded combination was refused, while this row is recording. */
  rejection: string | null;
  onStart: () => void;
  onStop: () => void;
  onReject: (message: string | null) => void;
}

function HotkeyRow({
  action,
  bindings,
  status,
  globalEnabled,
  recording,
  rejection,
  onStart,
  onStop,
  onReject,
}: HotkeyRowProps) {
  const addRef = useRef<HTMLButtonElement>(null);
  /** Set when the recording ends from the keyboard: focus then returns to "Add shortcut". */
  const refocus = useRef(false);
  const label = HOTKEY_ACTION_LABELS[action];
  const list = bindings[action];
  const canAdd = canAddBinding(bindings, action);

  useEffect(() => {
    if (recording || !refocus.current) return;
    refocus.current = false;
    addRef.current?.focus();
  }, [recording]);

  const accept = (verdict: Extract<RecordingVerdict, { ok: true }>): void => {
    refocus.current = true;
    onStop();
    saveBindings({ [action]: verdict.next });
    if (verdict.warning !== null && globalEnabled) {
      toast.warning(`${describeAccelerator(verdict.accelerator)} is captured system-wide`, {
        description: verdict.warning,
      });
    }
  };

  const entries = list.map((accelerator) => ({
    accelerator,
    name: describeAccelerator(accelerator),
    state: bindingStatus(status, action, accelerator),
    risky: globalEnabled && isRiskyGlobalAccelerator(accelerator),
  }));
  const failed = entries.filter((entry) => entry.state.health === 'failed');
  const risky = entries.filter((entry) => entry.risky);

  return (
    <li className={styles.actionRow} data-action={action}>
      <div className={styles.actionLabel}>
        <span>{label}</span>
        <span className={styles.actionHint}>{ACTION_HINTS[action]}</span>
      </div>

      <div className={styles.bindings}>
        {entries.length === 0 && !recording ? (
          <span className={styles.unbound}>Not bound</span>
        ) : null}
        {entries.map(({ accelerator, name, state }) => (
          <span
            key={accelerator}
            className={styles.binding}
            data-health={state.health}
            title={state.detail}
          >
            <Kbd accelerator={accelerator} size="sm" />
            <span className={styles.health}>
              <span className={styles.dot} aria-hidden="true" />
              {state.label}
            </span>
            <button
              type="button"
              className={styles.remove}
              aria-label={`Remove ${name} from ${label}`}
              onClick={() =>
                saveBindings({ [action]: removeBinding(bindings, action, accelerator) })
              }
            >
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ))}
        {recording ? (
          <ShortcutRecorder
            action={action}
            bindings={bindings}
            onAccept={accept}
            onReject={onReject}
            onCancel={(reason) => {
              refocus.current = reason === 'escape';
              onStop();
            }}
          />
        ) : (
          <Button
            ref={addRef}
            size="sm"
            variant="ghost"
            leadingIcon={canAdd ? <Plus size={14} /> : undefined}
            disabled={!canAdd}
            aria-label={
              canAdd
                ? `Add shortcut for ${label}`
                : `${label} has the maximum of ${MAX_BINDINGS_PER_ACTION} shortcuts`
            }
            onClick={onStart}
          >
            {canAdd
              ? 'Add shortcut'
              : `${MAX_BINDINGS_PER_ACTION} of ${MAX_BINDINGS_PER_ACTION} used`}
          </Button>
        )}
      </div>

      {rejection !== null || failed.length > 0 || risky.length > 0 ? (
        <div className={styles.rowNotes}>
          {rejection !== null ? (
            <p className={styles.note} data-tone="danger" role="alert">
              <TriangleAlert size={13} aria-hidden="true" />
              <span>{rejection}</span>
            </p>
          ) : null}
          {failed.map(({ accelerator, name, state }) => (
            <p key={accelerator} className={styles.note} data-tone="danger">
              <TriangleAlert size={13} aria-hidden="true" />
              <span>
                <strong>{name}</strong> — {state.detail}
              </span>
            </p>
          ))}
          {risky.map(({ accelerator, name }) => (
            <p key={accelerator} className={styles.note} data-tone="warn">
              <TriangleAlert size={13} aria-hidden="true" />
              <span>
                <strong>{name}</strong> — {RISKY_KEY_WARNING}
              </span>
            </p>
          ))}
        </div>
      ) : null}
    </li>
  );
}

export function HotkeysSection() {
  const { hotkeys } = useSettings();
  const status = useHotkeyStatus();
  const [recording, setRecording] = useState<{
    action: HotkeyAction;
    rejection: string | null;
  } | null>(null);

  const { bindings, globalEnabled } = hotkeys;
  const mode = explainMode(status.mode);
  const preset = activeCountPreset(bindings);
  const atDefaults = bindingsEqual(bindings, defaultBindings());

  const choosePreset = (choice: CountPreset): void => {
    setRecording(null);
    const outcome = applyCountPreset(bindings, choice.accelerator);
    saveBindings(outcome.patch);
    const moved = outcome.movedFrom.map((action) => `“${HOTKEY_ACTION_LABELS[action]}”`);
    const details = [
      moved.length > 0 ? `Taken from ${moved.join(' and ')}.` : null,
      globalEnabled ? outcome.warning : null,
    ].filter((part): part is string => part !== null);
    const title = `${choice.label} now counts encounters`;
    const options = details.length > 0 ? { description: details.join(' ') } : undefined;
    if (outcome.warning !== null && globalEnabled) toast.warning(title, options);
    else toast.success(title, options);
  };

  const resetBindings = async (): Promise<void> => {
    setRecording(null);
    const confirmed = await actions.confirmDestructive({
      title: 'Reset shortcuts to defaults?',
      message:
        'Every action goes back to its original key. Shortcuts you added or changed are removed.',
      confirmLabel: 'Reset shortcuts',
    });
    if (!confirmed) return;
    const saved = await actions.updateSettings({ hotkeys: { bindings: defaultBindings() } });
    if (saved !== null) toast.success('Shortcuts reset to defaults');
  };

  return (
    <Panel
      id="settings-hotkeys"
      tabIndex={-1}
      className={`${styles.section} ${styles.hotkeys}`}
      title="Hotkeys"
      subtitle="Count without leaving your game"
      icon={<Keyboard size={16} />}
      accent="cyan"
      actions={
        <Badge tone={mode.tone} dot={status.mode === 'active' ? 'pulse' : true}>
          {mode.label}
        </Badge>
      }
      footer={
        <div className={styles.hotkeyFooter}>
          <div className={styles.presets}>
            <span className={styles.presetsLabel} id="settings-count-presets">
              Count key
            </span>
            {COUNT_PRESETS.map((choice) => (
              <Button
                key={choice.id}
                size="sm"
                variant={preset?.id === choice.id ? 'primary' : 'secondary'}
                aria-pressed={preset?.id === choice.id}
                aria-describedby="settings-count-presets"
                title={choice.hint}
                onClick={() => choosePreset(choice)}
              >
                {choice.label}
              </Button>
            ))}
          </div>
          <Button
            size="sm"
            variant="ghost"
            leadingIcon={<RotateCcw size={14} />}
            disabled={atDefaults}
            onClick={() => void resetBindings()}
          >
            Reset shortcuts to defaults
          </Button>
        </div>
      }
    >
      <div className={styles.stack}>
        <Toggle
          trailing
          label="Global hotkeys"
          description="Shortcuts work system-wide — while a game has focus and Biolume is in the background, minimised or hidden behind the mini-overlay. Inside Biolume they always work."
          checked={globalEnabled}
          onChange={(checked) =>
            void actions.updateSettings({ hotkeys: { globalEnabled: checked } })
          }
        />

        <div className={styles.mode} data-tone={mode.tone} data-mode={status.mode}>
          <p className={styles.modeText}>
            <strong>{mode.label}.</strong> {mode.text}
          </p>
        </div>

        <ul className={styles.actionList} aria-label="Shortcuts by action">
          {HOTKEY_ACTIONS.map((action) => {
            const active = recording?.action === action;
            return (
              <HotkeyRow
                key={action}
                action={action}
                bindings={bindings}
                status={status}
                globalEnabled={globalEnabled}
                recording={active}
                rejection={active ? recording.rejection : null}
                onStart={() => setRecording({ action, rejection: null })}
                onStop={() =>
                  setRecording((current) => (current?.action === action ? null : current))
                }
                onReject={(message) =>
                  setRecording((current) =>
                    current?.action === action ? { action, rejection: message } : current,
                  )
                }
              />
            );
          })}
        </ul>
      </div>
    </Panel>
  );
}
