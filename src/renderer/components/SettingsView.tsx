import type { ReactNode } from 'react';
import {
  Database,
  Grid3x3,
  Keyboard,
  PictureInPicture2,
  Settings2,
  SlidersHorizontal,
  Volume2,
} from 'lucide-react';
import { Page } from '@renderer/components/ui';
import { useReducedMotion } from '@renderer/hooks';
import { AudioSection } from './settings/AudioSection';
import { DataSection } from './settings/DataSection';
import { GeneralSection } from './settings/GeneralSection';
import { HotkeysSection } from './settings/HotkeysSection';
import { OverlaySection } from './settings/OverlaySection';
import { StreamDeckSection } from './settings/StreamDeckSection';
import styles from './settings/Settings.module.css';

/** The sections in page order; `id` is the section element's DOM id. */
const SECTIONS: readonly { id: string; label: string; icon: ReactNode }[] = [
  { id: 'settings-hotkeys', label: 'Hotkeys', icon: <Keyboard size={14} /> },
  { id: 'settings-streamdeck', label: 'Stream Deck', icon: <Grid3x3 size={14} /> },
  { id: 'settings-audio', label: 'Audio', icon: <Volume2 size={14} /> },
  { id: 'settings-overlay', label: 'Mini-Overlay', icon: <PictureInPicture2 size={14} /> },
  { id: 'settings-general', label: 'General', icon: <Settings2 size={14} /> },
  { id: 'settings-data', label: 'Data & About', icon: <Database size={14} /> },
];

/**
 * Settings view — hotkeys, Stream Deck, audio, mini-overlay, general and data.
 * Every control writes straight through `updateSettings`; the main process
 * answers with the new settings, which is what the controls then show.
 */
export default function SettingsView() {
  const reducedMotion = useReducedMotion();

  const jumpTo = (id: string): void => {
    const section = document.getElementById(id);
    section?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
    // Keyboard users continue from the section they jumped to.
    section?.focus({ preventScroll: true });
  };

  return (
    <Page
      title="Settings"
      subtitle="Hotkeys, Stream Deck, audio, the mini-overlay and your data"
      icon={<SlidersHorizontal />}
      className={styles.layout}
      toolbar={
        <nav className={styles.nav} aria-label="Settings sections">
          {SECTIONS.map((section) => (
            <button
              key={section.id}
              type="button"
              className={styles.navLink}
              onClick={() => jumpTo(section.id)}
            >
              {section.icon}
              {section.label}
            </button>
          ))}
        </nav>
      }
    >
      <HotkeysSection />
      <StreamDeckSection />
      <AudioSection />
      <OverlaySection />
      <GeneralSection />
      <DataSection />
    </Page>
  );
}
