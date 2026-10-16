import { useEffect, useState } from 'react';
import { Database, ExternalLink, FolderOpen, RotateCcw } from 'lucide-react';
import { Button, confirm, Panel, Skeleton, toast } from '@renderer/components/ui';
import { actions } from '@renderer/store';
import { AboutLogo } from './AboutLogo';
import styles from './Settings.module.css';

const POKEAPI_URL = 'https://pokeapi.co/';
const PKHEX_URL = 'https://github.com/kwsch/PKHeX';

type PathState = { status: 'loading' } | { status: 'ready'; path: string } | { status: 'failed' };

export function DataSection() {
  const [dataPath, setDataPath] = useState<PathState>({ status: 'loading' });
  const [resetting, setResetting] = useState(false);
  const { versions } = window.biolume;

  useEffect(() => {
    let cancelled = false;
    void actions.getDataPath().then((path) => {
      if (cancelled) return;
      setDataPath(path === null ? { status: 'failed' } : { status: 'ready', path });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Always asks: the "confirm destructive actions" switch is itself among what gets reset.
  const resetAll = async (): Promise<void> => {
    const confirmed = await confirm({
      title: 'Reset all settings?',
      message:
        'Hotkeys, Stream Deck, audio, the mini-overlay and general preferences return to their defaults. Your hunts, phases and session history are not touched.',
      confirmLabel: 'Reset settings',
      tone: 'danger',
    });
    if (!confirmed) return;
    setResetting(true);
    const settings = await actions.resetSettings();
    setResetting(false);
    if (settings !== null) toast.success('Settings reset to defaults');
  };

  const versionRows: readonly (readonly [string, string])[] = [
    ['Biolume', versions.app],
    ['Electron', versions.electron],
    ['Chrome', versions.chrome],
    ['Node', versions.node],
  ];

  return (
    <Panel
      id="settings-data"
      tabIndex={-1}
      className={`${styles.section} ${styles.data}`}
      title="Data & About"
      subtitle="Where your hunts live, and what Biolume is built on"
      icon={<Database size={16} />}
    >
      <div className={styles.rows}>
        <div className={styles.stack}>
          <div className={styles.row}>
            <div className={styles.rowText}>
              <span className={styles.rowLabel}>Data folder</span>
              <span className={styles.rowDescription}>
                Hunts, sessions and settings are plain JSON files on this computer.
              </span>
            </div>
            <div className={styles.rowControl}>
              <Button
                size="sm"
                leadingIcon={<FolderOpen size={14} />}
                disabled={dataPath.status !== 'ready'}
                onClick={() => void actions.revealDataFolder()}
              >
                Open folder
              </Button>
            </div>
          </div>
          {dataPath.status === 'loading' ? (
            <Skeleton height={30} />
          ) : (
            <code
              className={styles.path}
              title={dataPath.status === 'ready' ? dataPath.path : undefined}
            >
              {dataPath.status === 'ready'
                ? dataPath.path
                : 'The data folder could not be located.'}
            </code>
          )}
        </div>

        <div className={styles.row}>
          <div className={styles.rowText}>
            <span className={styles.rowLabel}>Reset all settings</span>
            <span className={styles.rowDescription}>
              Back to the defaults. Hunts and history stay as they are.
            </span>
          </div>
          <div className={styles.rowControl}>
            <Button
              size="sm"
              variant="danger"
              leadingIcon={<RotateCcw size={14} />}
              loading={resetting}
              onClick={() => void resetAll()}
            >
              Reset all settings
            </Button>
          </div>
        </div>

        <AboutLogo />

        <dl className={styles.versions} aria-label="Versions">
          {versionRows.map(([name, version]) => (
            <div key={name} className={styles.version}>
              <dt>{name}</dt>
              <dd title={version}>{version || '—'}</dd>
            </div>
          ))}
        </dl>

        <div className={styles.row}>
          <div className={styles.rowText}>
            <span className={styles.rowLabel}>Pokémon data by PokéAPI</span>
            <span className={styles.rowDescription}>
              Species, moves, sprites and the locations for Gold / Silver through Sword / Shield
              come from the free, community-run PokéAPI and are cached on this computer.
            </span>
          </div>
          <div className={styles.rowControl}>
            <Button
              size="sm"
              variant="ghost"
              trailingIcon={<ExternalLink size={13} />}
              onClick={() => void actions.openExternal(POKEAPI_URL)}
            >
              pokeapi.co
            </Button>
          </div>
        </div>

        <div className={styles.row}>
          <div className={styles.rowText}>
            <span className={styles.rowLabel}>Game data by PKHeX</span>
            <span className={styles.rowDescription}>
              Locations for Brilliant Diamond / Shining Pearl, Legends: Arceus, Scarlet / Violet and
              Legends: Z-A, Legends: Z-A movesets and the shiny locks of gifts and static encounters
              are extracted from the open-source PKHeX project and bundled with the app.
            </span>
          </div>
          <div className={styles.rowControl}>
            <Button
              size="sm"
              variant="ghost"
              trailingIcon={<ExternalLink size={13} />}
              onClick={() => void actions.openExternal(PKHEX_URL)}
            >
              PKHeX
            </Button>
          </div>
        </div>

        <p className={styles.legal}>
          Biolume is an unofficial, fan-made tool. It is not affiliated with, endorsed or sponsored
          by Nintendo, Game Freak or The Pokémon Company. Pokémon and Pokémon character names are
          trademarks of their respective owners.
        </p>
      </div>
    </Panel>
  );
}
