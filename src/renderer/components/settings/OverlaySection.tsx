import { Lock, PictureInPicture2 } from 'lucide-react';
import { LIMITS } from '@shared/defaults';
import type { OverlaySettings } from '@shared/types';
import { Button, Kbd, Panel, Slider, Toggle } from '@renderer/components/ui';
import { actions, useSettings, useWindowState } from '@renderer/store';
import { SettingRow, useDraftNumber } from './SettingRow';
import styles from './Settings.module.css';

function save(patch: Partial<OverlaySettings>): Promise<unknown> {
  return actions.updateSettings({ overlay: patch });
}

const percent = (value: number): string => `${Math.round(value * 100)} %`;

export function OverlaySection() {
  const settings = useSettings();
  const { overlayOpen } = useWindowState();
  const { overlay } = settings;
  const toggleKey = settings.hotkeys.bindings.toggleOverlay[0];

  const opacity = useDraftNumber(overlay.opacity, (value) => save({ opacity: value }), {
    live: true,
  });
  // The window is resized for every new scale, so only the value let go of is saved.
  const scale = useDraftNumber(overlay.scale, (value) => save({ scale: value }));

  return (
    <Panel
      id="settings-overlay"
      tabIndex={-1}
      className={`${styles.section} ${styles.overlay}`}
      title="Mini-Overlay"
      subtitle="A floating counter that stays above your game"
      icon={<PictureInPicture2 size={16} />}
      accent="violet"
      actions={
        <Button
          size="sm"
          variant={overlayOpen ? 'secondary' : 'primary'}
          onClick={() => void actions.setOverlayOpen(!overlayOpen)}
        >
          {overlayOpen ? 'Close mini-overlay' : 'Open mini-overlay'}
        </Button>
      }
    >
      <div className={styles.rows}>
        <SettingRow
          label="Background opacity"
          description="How dark the card is. Text and light always stay at full strength."
        >
          {(ids) => (
            <Slider
              {...ids}
              className={styles.slider}
              value={opacity.value}
              onChange={opacity.onChange}
              onCommit={opacity.onCommit}
              min={LIMITS.overlayOpacity.min}
              max={LIMITS.overlayOpacity.max}
              step={0.01}
              formatValue={percent}
              tone="violet"
            />
          )}
        </SettingRow>

        <SettingRow label="Size" description="Scales the whole overlay, sprite and text alike.">
          {(ids) => (
            <Slider
              {...ids}
              className={styles.slider}
              value={scale.value}
              onChange={scale.onChange}
              onCommit={scale.onCommit}
              min={LIMITS.overlayScale.min}
              max={LIMITS.overlayScale.max}
              step={0.05}
              formatValue={percent}
              tone="violet"
            />
          )}
        </SettingRow>

        <Toggle
          trailing
          label="Show sprite"
          description="The target's shiny sprite next to the count."
          checked={overlay.showSprite}
          onChange={(checked) => void save({ showSprite: checked })}
        />
        <Toggle
          trailing
          label="Show odds"
          description="“1 in N” and your chance of having found it by now."
          checked={overlay.showOdds}
          onChange={(checked) => void save({ showOdds: checked })}
        />
        <Toggle
          trailing
          label="Show phase"
          description="The current phase number and the hunt's total encounters."
          checked={overlay.showPhase}
          onChange={(checked) => void save({ showPhase: checked })}
        />

        <div className={styles.stack}>
          <Toggle
            trailing
            label="Click-through"
            description="Mouse clicks pass through the overlay to the game underneath."
            checked={overlay.clickThrough}
            onChange={(checked) => void save({ clickThrough: checked })}
          />
          <p className={`${styles.note} ${styles.caveat}`} data-tone="warn">
            <Lock size={13} aria-hidden="true" />
            <span>
              While this is on the overlay cannot be clicked or dragged, so its own buttons are out
              of reach. Switch it off here, or close the overlay with its hotkey
              {toggleKey === undefined ? (
                ' — none is bound yet, add one under Hotkeys first.'
              ) : (
                <>
                  {' '}
                  (<Kbd accelerator={toggleKey} size="sm" />
                  ).
                </>
              )}
            </span>
          </p>
        </div>

        <Toggle
          trailing
          label="Hide the main window while the overlay is open"
          description="Only the floating counter stays on screen. Closing the overlay brings Biolume back."
          checked={overlay.hideMainWindow}
          onChange={(checked) => void save({ hideMainWindow: checked })}
        />
      </div>
    </Panel>
  );
}
