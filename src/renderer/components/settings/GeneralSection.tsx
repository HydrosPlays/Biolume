import { Settings2 } from 'lucide-react';
import { LIMITS } from '@shared/defaults';
import type { GeneralSettings } from '@shared/types';
import { NumberField, Panel, SegmentedControl, Toggle } from '@renderer/components/ui';
import { actions, useSettings } from '@renderer/store';
import { SettingRow } from './SettingRow';
import styles from './Settings.module.css';

const MOTION_OPTIONS: readonly { value: GeneralSettings['reducedMotion']; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

function save(patch: Partial<GeneralSettings>): void {
  void actions.updateSettings({ general: patch });
}

export function GeneralSection() {
  const { general } = useSettings();

  return (
    <Panel
      id="settings-general"
      tabIndex={-1}
      className={`${styles.section} ${styles.general}`}
      title="General"
      subtitle="Safety nets, sessions and motion"
      icon={<Settings2 size={16} />}
    >
      <div className={styles.rows}>
        <Toggle
          trailing
          label="Confirm destructive actions"
          description="Ask before deleting hunts or phases and before resetting a counter."
          checked={general.confirmDestructive}
          onChange={(checked) => save({ confirmDestructive: checked })}
        />

        <SettingRow
          label="Session idle time"
          description="A hunting session ends after this long without a count."
        >
          {(ids) => (
            <NumberField
              {...ids}
              value={general.sessionIdleMinutes}
              onChange={(minutes) => save({ sessionIdleMinutes: minutes })}
              min={LIMITS.sessionIdleMinutes.min}
              max={LIMITS.sessionIdleMinutes.max}
              step={1}
              largeStep={15}
              suffix="min"
              width={4}
            />
          )}
        </SettingRow>

        <SettingRow
          label="Reduced motion"
          description="Calms pulses, drifts and transitions. “System” follows your operating system."
        >
          {(ids) => (
            <SegmentedControl
              aria-labelledby={ids['aria-labelledby']}
              options={MOTION_OPTIONS}
              value={general.reducedMotion}
              onChange={(reducedMotion) => save({ reducedMotion })}
              size="sm"
            />
          )}
        </SettingRow>
      </div>
    </Panel>
  );
}
