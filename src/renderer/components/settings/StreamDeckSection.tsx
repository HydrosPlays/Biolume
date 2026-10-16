import { useId, useState } from 'react';
import { CircleCheck, Download, Grid3x3, Info, Keyboard, Star, TriangleAlert } from 'lucide-react';
import { HOTKEY_ACTION_LABELS } from '@shared/defaults';
import { SHINY_CONFIRM_WINDOW_MS } from '@shared/streamDeck';
import type { StreamDeckStatus } from '@shared/types';
import { Badge, Button, Kbd, Panel, Toggle, toast, type Tone } from '@renderer/components/ui';
import { formatCount } from '@renderer/lib/format';
import { actions, useSettings, useStreamDeckStatus } from '@renderer/store';
import styles from './Settings.module.css';
import {
  applyStreamDeckPreset,
  describePresetOutcome,
  describeSkipped,
  type DeckHotkeyPlan,
} from './streamDeckPreset';

const CONFIRM_SECONDS = Math.round(SHINY_CONFIRM_WINDOW_MS / 1000);

/** The keys the Biolume plugin adds to the Stream Deck app, in its action list order. */
const PLUGIN_KEYS: readonly { name: string; text: string }[] = [
  {
    name: 'Counter',
    text: 'Shows the live count of the active hunt; a press counts an encounter.',
  },
  { name: 'Increment', text: 'Counts an encounter (one step of the hunt).' },
  { name: 'Decrement', text: 'Takes one step back off the count.' },
  { name: 'Log Phase', text: 'Logs a phase now; identify the shiny later in Biolume.' },
  {
    name: 'Shiny Found',
    text: `Press twice within ${CONFIRM_SECONDS} s: the key shows “Confirm?” after the first press.`,
  },
  { name: 'Undo', text: 'Reverts the last count, phase or Shiny Found.' },
  { name: 'Toggle Overlay', text: 'Opens or closes the mini-overlay.' },
];

interface BridgeSummary {
  tone: Tone;
  badge: string;
  text: string;
  /** Pulse the badge dot: something is live. */
  live: boolean;
}

/** The bridge status in words, for the header badge and the line under the switch. */
export function summarizeBridge(status: StreamDeckStatus, enabled: boolean): BridgeSummary {
  if (!enabled) {
    return {
      tone: 'neutral',
      badge: 'Off',
      text: 'The bridge is off. Biolume keys on your Stream Deck show “Offline”.',
      live: false,
    };
  }
  if (status.listening) {
    const where = status.port === null ? '127.0.0.1' : `127.0.0.1:${status.port}`;
    const clients =
      status.clients > 0
        ? `${formatCount(status.clients)} Stream Deck ${status.clients === 1 ? 'connection' : 'connections'}`
        : 'waiting for the Stream Deck plugin';
    return {
      tone: status.clients > 0 ? 'ok' : 'accent',
      badge: status.clients > 0 ? 'Connected' : 'Listening',
      text: `Listening on ${where} · ${clients}.`,
      live: status.clients > 0,
    };
  }
  if (status.error !== null && status.error.trim() !== '') {
    return { tone: 'danger', badge: 'Error', text: `Not listening: ${status.error}`, live: false };
  }
  return { tone: 'neutral', badge: 'Starting', text: 'Starting the bridge…', live: false };
}

const PLAN_LABELS: Record<DeckHotkeyPlan['state'], { label: string; tone: Tone }> = {
  bound: { label: 'Bound', tone: 'ok' },
  available: { label: 'Not bound yet', tone: 'neutral' },
  conflict: { label: 'Key in use', tone: 'warn' },
  full: { label: 'No room', tone: 'warn' },
};

function HotkeyAlternative() {
  const { hotkeys } = useSettings();
  const [saving, setSaving] = useState(false);
  const outcome = applyStreamDeckPreset(hotkeys.bindings);
  const allBound = outcome.plan.every((entry) => entry.state === 'bound');

  const bindPreset = async (): Promise<void> => {
    const result = applyStreamDeckPreset(hotkeys.bindings);
    if (result.added.length > 0) {
      setSaving(true);
      const saved = await actions.updateSettings({ hotkeys: { bindings: result.patch } });
      setSaving(false);
      if (saved === null) return;
    }
    const message = describePresetOutcome(result, hotkeys.globalEnabled);
    const options = message.description === undefined ? {} : { description: message.description };
    toast[message.tone](message.title, { id: 'stream-deck-preset', ...options });
  };

  return (
    <div className={styles.deckBlock}>
      <div className={styles.deckBlockHead}>
        <Keyboard size={14} aria-hidden="true" />
        <h3 className={styles.deckHeading}>
          No plugin? Use F13–F16 with Stream Deck’s Hotkey action
        </h3>
      </div>
      <p className={styles.deckText}>
        Stream Deck’s built-in Hotkey action can press Biolume’s shortcuts. Hardly any keyboard has
        F13–F16 and no game uses them, so binding them system-wide takes nothing away.
      </p>

      <ul className={styles.deckPreset} aria-label="Stream Deck hotkey preset">
        {outcome.plan.map((entry) => {
          const state = PLAN_LABELS[entry.state];
          return (
            <li key={entry.accelerator} className={styles.deckPresetRow} data-state={entry.state}>
              <Kbd accelerator={entry.accelerator} size="sm" />
              <span className={styles.deckPresetAction}>{HOTKEY_ACTION_LABELS[entry.action]}</span>
              <Badge
                size="sm"
                tone={state.tone}
                icon={entry.state === 'bound' ? <CircleCheck size={12} /> : undefined}
                title={
                  entry.state === 'conflict' || entry.state === 'full'
                    ? describeSkipped(entry)
                    : undefined
                }
              >
                {state.label}
              </Badge>
            </li>
          );
        })}
      </ul>

      {outcome.skipped.length > 0 ? (
        <div className={styles.rowNotes}>
          {outcome.skipped.map((entry) => (
            <p key={entry.accelerator} className={styles.note} data-tone="warn">
              <TriangleAlert size={13} aria-hidden="true" />
              <span>{describeSkipped(entry)}</span>
            </p>
          ))}
        </div>
      ) : null}

      <div>
        <Button
          size="sm"
          variant={allBound ? 'secondary' : 'primary'}
          leadingIcon={<Keyboard size={14} />}
          loading={saving}
          disabled={allBound || outcome.added.length === 0}
          onClick={() => void bindPreset()}
        >
          {allBound ? 'F13–F16 are bound' : 'Bind F13–F16'}
        </Button>
      </div>

      <ol className={styles.deckSteps}>
        <li>
          Click <strong>Bind F13–F16</strong>. They are added next to your shortcuts; nothing is
          replaced.
        </li>
        <li>
          In the Stream Deck app, drag <strong>System › Hotkey</strong> onto a key.
        </li>
        <li>
          Set its hotkey to F13 (count), F14 (step back), F15 (log phase) or F16 (Shiny Found —
          press it twice). F13–F24 are in the key list of the Hotkey field.
        </li>
      </ol>

      {hotkeys.globalEnabled ? null : (
        <p className={`${styles.note} ${styles.caveat}`} data-tone="warn">
          <TriangleAlert size={13} aria-hidden="true" />
          <span>
            Global hotkeys are off, so these keys only work while Biolume has focus. Switch on{' '}
            <strong>Global hotkeys</strong> under Hotkeys to use them in game.
          </span>
        </p>
      )}
    </div>
  );
}

/**
 * Settings › Stream Deck: the bridge the Biolume plugin talks to, the plugin
 * installer, the plugin's keys — and the no-plugin route through Stream
 * Deck's own Hotkey action and F13–F16.
 */
export function StreamDeckSection() {
  const settings = useSettings();
  const status = useStreamDeckStatus();
  const [installing, setInstalling] = useState(false);
  const notBundledId = useId();
  const { enabled } = settings.streamDeck;
  const summary = summarizeBridge(status, enabled);

  const install = async (): Promise<void> => {
    setInstalling(true);
    const ok = await actions.installStreamDeckPlugin();
    setInstalling(false);
    if (ok) {
      toast.success('Stream Deck plugin installer opened', {
        description: 'Confirm in the Stream Deck app, then drag the Biolume keys onto your deck.',
      });
    }
  };

  return (
    <Panel
      id="settings-streamdeck"
      tabIndex={-1}
      className={`${styles.section} ${styles.streamdeck}`}
      title="Stream Deck"
      subtitle="Count, log phases and call the shiny from an Elgato Stream Deck"
      icon={<Grid3x3 size={16} />}
      accent="teal"
      actions={
        <Badge tone={summary.tone} dot={summary.live ? 'pulse' : true}>
          {summary.badge}
        </Badge>
      }
    >
      <div className={styles.stack}>
        <p className={styles.deckIntro}>
          The Biolume plugin puts your hunt on Stream Deck keys — the live count, the phase, and
          keys that count, log phases and call the shiny. It talks to this app over a private link
          on this computer and pairs by itself, so there is nothing to set up.
        </p>

        <div className={styles.deckWrap}>
          <div className={styles.deckColumns}>
            <div className={styles.deckBlock}>
              <div className={styles.stack}>
                <Toggle
                  trailing
                  label="Stream Deck bridge"
                  description="Lets the Biolume plugin reach the app. Only programs on this computer that hold the pairing key Biolume writes to its data folder can use it; the key changes whenever the bridge starts."
                  checked={enabled}
                  onChange={(checked) =>
                    void actions.updateSettings({ streamDeck: { enabled: checked } })
                  }
                />
                <p
                  className={styles.note}
                  data-tone={summary.tone}
                  role="status"
                  data-testid="stream-deck-status"
                >
                  {summary.tone === 'danger' ? (
                    <TriangleAlert size={13} aria-hidden="true" />
                  ) : (
                    <Info size={13} aria-hidden="true" />
                  )}
                  <span>{summary.text}</span>
                </p>
              </div>

              <div className={styles.row}>
                <div className={styles.rowText}>
                  <span className={styles.rowLabel}>Biolume plugin</span>
                  <span className={styles.rowDescription}>
                    Opens the installer; the Stream Deck app asks to add the plugin.
                  </span>
                </div>
                <div className={styles.rowControl}>
                  <Button
                    size="sm"
                    variant="primary"
                    leadingIcon={<Download size={14} />}
                    disabled={!status.pluginBundled}
                    loading={installing}
                    aria-describedby={status.pluginBundled ? undefined : notBundledId}
                    onClick={() => void install()}
                  >
                    Install Stream Deck plugin
                  </Button>
                </div>
              </div>
              {status.pluginBundled ? null : (
                <p id={notBundledId} className={styles.note} data-tone="neutral">
                  <Info size={13} aria-hidden="true" />
                  <span>
                    This build does not include the plugin installer — development builds skip it.
                    Install it from the packaged Biolume, or use F13–F16 below.
                  </span>
                </p>
              )}

              <div>
                <h3 className={styles.deckHeading}>Keys the plugin adds</h3>
                <ul className={styles.deckKeys}>
                  {PLUGIN_KEYS.map((key) => (
                    <li key={key.name} className={styles.deckKey}>
                      <span className={styles.deckKeyName}>{key.name}</span>
                      <span className={styles.deckKeyText}>{key.text}</span>
                    </li>
                  ))}
                </ul>
                <p className={styles.deckText}>
                  Keys show “Offline” while Biolume is closed or the bridge is off.
                </p>
              </div>
            </div>

            <HotkeyAlternative />
          </div>
        </div>

        <p className={`${styles.note} ${styles.caveat}`} data-tone="shiny">
          <Star size={13} aria-hidden="true" />
          <span>
            <strong>Shiny Found takes two presses.</strong> From the Stream Deck or a hotkey, the
            first press only arms it — the key and the Hunt view light up gold — and a second press
            within {CONFIRM_SECONDS} s completes the hunt, so a stray tap never ends a hunt. Undo
            still takes it back. The Hunt view’s own button completes at once.
          </span>
        </p>
      </div>
    </Panel>
  );
}
