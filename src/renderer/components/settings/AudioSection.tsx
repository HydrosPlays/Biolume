import { Play, Volume2 } from 'lucide-react';
import { SOUND_PACKS } from '@shared/defaults';
import type { AudioSettings, SoundPack } from '@shared/types';
import { Button, Panel, SegmentedControl, Slider, Toggle, toast } from '@renderer/components/ui';
import { playSound } from '@renderer/lib/audio';
import { titleCase } from '@renderer/lib/format';
import { actions, useSettings } from '@renderer/store';
import { SettingRow, useDraftNumber } from './SettingRow';
import styles from './Settings.module.css';

const PACK_OPTIONS = SOUND_PACKS.map((pack) => ({ value: pack, label: titleCase(pack) }));

/** Gap between the count tick and the chime of a preview, so the two do not mask each other. */
const PREVIEW_CHIME_DELAY_MS = 320;

function save(patch: Partial<AudioSettings>): Promise<unknown> {
  return actions.updateSettings({ audio: patch });
}

const percent = (value: number): string => `${Math.round(value * 100)} %`;

export function AudioSection() {
  const { audio } = useSettings();
  const volume = useDraftNumber(audio.volume, (value) => save({ volume: value }), { live: true });

  /** Plays a pack's count tick and chime — audible even while sound effects are switched off. */
  const preview = (pack: SoundPack): void => {
    if (volume.value <= 0) {
      toast.info('The volume is at zero', { description: 'Raise it to hear a preview.' });
      return;
    }
    const sample: AudioSettings = { ...audio, enabled: true, volume: volume.value, pack };
    playSound('increment', sample);
    window.setTimeout(() => playSound('milestone', sample), PREVIEW_CHIME_DELAY_MS);
  };

  return (
    <Panel
      id="settings-audio"
      tabIndex={-1}
      className={`${styles.section} ${styles.audio}`}
      title="Audio"
      subtitle="Hear every count, even from a hotkey"
      icon={<Volume2 size={16} />}
      accent="teal"
    >
      <div className={styles.rows}>
        <Toggle
          trailing
          label="Sound effects"
          description="A tick for every count, and cues for phases and a found shiny."
          checked={audio.enabled}
          onChange={(checked) => void save({ enabled: checked })}
        />

        <SettingRow label="Volume">
          {(ids) => (
            <Slider
              {...ids}
              className={styles.slider}
              value={volume.value}
              onChange={volume.onChange}
              onCommit={volume.onCommit}
              min={0}
              max={1}
              step={0.01}
              formatValue={percent}
              tone="teal"
              disabled={!audio.enabled}
            />
          )}
        </SettingRow>

        <div className={styles.stack}>
          <div className={styles.rowText}>
            <span id="settings-sound-pack" className={styles.rowLabel}>
              Sound pack
            </span>
            <span className={styles.rowDescription}>
              The voice of the counter. Preview plays a count followed by the milestone chime.
            </span>
          </div>
          <SegmentedControl
            aria-labelledby="settings-sound-pack"
            options={PACK_OPTIONS}
            value={audio.pack}
            onChange={(pack) => void save({ pack })}
            fullWidth
          />
          <div className={styles.packGrid}>
            {SOUND_PACKS.map((pack) => (
              <Button
                key={pack}
                size="sm"
                variant="ghost"
                leadingIcon={<Play size={12} />}
                aria-label={`Preview the ${titleCase(pack)} sound pack`}
                onClick={() => preview(pack)}
              >
                Preview
              </Button>
            ))}
          </div>
        </div>

        <Toggle
          trailing
          label="Milestone chime"
          description="An extra chime when the count crosses 50 %, 90 % and the odds themselves."
          checked={audio.milestoneChime}
          disabled={!audio.enabled}
          onChange={(checked) => void save({ milestoneChime: checked })}
        />
      </div>
    </Panel>
  );
}
