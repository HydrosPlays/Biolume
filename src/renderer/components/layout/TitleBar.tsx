import { Keyboard, KeyboardOff, PictureInPicture2, Pin } from 'lucide-react';
import type { ReactNode } from 'react';
import type { HotkeyStatus, Hunt } from '@shared/types';
import { IconButton, Kbd, Sprite, Tooltip } from '@renderer/components/ui';
import { cx } from '@renderer/components/ui/internal/cx';
import { navigate } from '@renderer/hooks/useView';
import { formatCount } from '@renderer/lib/format';
import * as actions from '@renderer/store/actions';
import {
  useActiveHunt,
  useHotkeyStatus,
  useSettings,
  useWindowState,
} from '@renderer/store/appStore';
import { Logo } from './Logo';
import styles from './TitleBar.module.css';

/** The hunt being counted, always in view: sprite, name, live count. Click to jump to the counter. */
function ActiveHuntChip({ hunt }: { hunt: Hunt | null }) {
  if (!hunt) {
    return (
      <button
        type="button"
        className={cx(styles.chip, styles.chipEmpty)}
        onClick={() => navigate('hunt')}
      >
        No active hunt
      </button>
    );
  }

  const name = hunt.name.trim() || hunt.target?.name || 'Untitled hunt';
  const completed = hunt.status === 'completed';
  return (
    <Tooltip
      content={completed ? 'Hunt complete — open the counter' : 'Open the counter'}
      placement="bottom"
    >
      <button
        type="button"
        className={styles.chip}
        data-completed={completed || undefined}
        aria-label={`Active hunt: ${name}, ${formatCount(hunt.count)} encounters`}
        onClick={() => navigate('hunt')}
      >
        <Sprite
          src={[hunt.target?.shinySpriteUrl, hunt.target?.spriteUrl]}
          alt=""
          size={30}
          loading="eager"
          shiny={completed}
          className={styles.chipSprite}
        />
        <span className={styles.chipName}>{name}</span>
        <span className={styles.chipDivider} aria-hidden="true" />
        {/* Re-keyed on every change so the tick animation replays. */}
        <span key={hunt.count} className={styles.chipCount}>
          {formatCount(hunt.count)}
        </span>
      </button>
    </Tooltip>
  );
}

interface PillContent {
  label: string;
  tone: 'live' | 'idle' | 'off' | 'recording' | 'warn';
  icon: ReactNode;
  title: string;
  body: ReactNode;
}

function describeHotkeys(status: HotkeyStatus, incrementKey: string | undefined): PillContent {
  const failed = status.registrations.filter((registration) => !registration.registered);
  const key = incrementKey ? <Kbd accelerator={incrementKey} size="sm" /> : null;

  switch (status.mode) {
    case 'active':
      if (failed.length > 0) {
        return {
          label: 'Global',
          tone: 'warn',
          icon: <Keyboard />,
          title: `${failed.length} global hotkey${failed.length === 1 ? '' : 's'} unavailable`,
          body: (
            <>
              Another application already owns{' '}
              {failed.map((registration, index) => (
                <span key={`${registration.action}-${registration.accelerator}`}>
                  {index > 0 ? ', ' : ''}
                  <Kbd accelerator={registration.accelerator} size="sm" />
                </span>
              ))}
              . The remaining hotkeys are live. Pick different keys in Settings.
            </>
          ),
        };
      }
      return {
        label: 'Global',
        tone: 'live',
        icon: <Keyboard />,
        title: 'Global hotkeys are live',
        body: (
          <>
            Encounters count even while your game has focus. {key ? <>Count with {key}.</> : null}
          </>
        ),
      };
    case 'app-focused':
      return {
        label: 'In-app',
        tone: 'idle',
        icon: <Keyboard />,
        title: 'Global hotkeys paused while Biolume is focused',
        body: (
          <>
            Your hotkeys still work here — they are handled in-app so those keys stay typeable in
            text fields. Global hotkeys resume the moment you switch to your game.
          </>
        ),
      };
    case 'capturing':
      return {
        label: 'Recording',
        tone: 'recording',
        icon: <Keyboard />,
        title: 'Recording a key binding',
        body: 'All hotkeys are suspended until the new combination is saved or cancelled.',
      };
    case 'disabled':
      return {
        label: 'Off',
        tone: 'off',
        icon: <KeyboardOff />,
        title: 'Global hotkeys are off',
        body: 'Hotkeys only work while Biolume is focused. Turn global hotkeys on in Settings to count from inside your game.',
      };
  }
}

/** Where hotkeys are being handled right now — the question a hunter asks before alt-tabbing. */
function HotkeyStatusPill() {
  const status = useHotkeyStatus();
  const incrementKey = useSettings().hotkeys.bindings.increment[0];
  const content = describeHotkeys(status, incrementKey);

  return (
    <Tooltip
      placement="bottom"
      align="end"
      maxWidth={300}
      content={
        <span className={styles.pillTip}>
          <strong>{content.title}</strong>
          <span>{content.body}</span>
        </span>
      }
    >
      <button
        type="button"
        className={styles.pill}
        data-state={content.tone}
        aria-label={`Hotkeys: ${content.title}. Open hotkey settings.`}
        onClick={() => navigate('settings')}
      >
        <span className={styles.pillDot} aria-hidden="true" />
        <span className={styles.pillIcon} aria-hidden="true">
          {content.icon}
        </span>
        <span className={styles.pillLabel}>{content.label}</span>
      </button>
    </Tooltip>
  );
}

/** Minimise / maximise-restore / close, drawn as thin strokes like native Windows 11 captions. */
function WindowControls({ maximized }: { maximized: boolean }) {
  return (
    <div className={styles.windowControls}>
      <button
        type="button"
        className={styles.caption}
        aria-label="Minimize"
        onClick={() => void actions.minimizeWindow()}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5h10" />
        </svg>
      </button>
      <button
        type="button"
        className={styles.caption}
        aria-label={maximized ? 'Restore' : 'Maximize'}
        onClick={() => void actions.toggleMaximizeWindow()}
      >
        {maximized ? (
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z" />
          </svg>
        ) : (
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M.5.5h9v9h-9z" />
          </svg>
        )}
      </button>
      <button
        type="button"
        className={cx(styles.caption, styles.captionClose)}
        aria-label="Close"
        onClick={() => void actions.closeWindow()}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 0l10 10M10 0L0 10" />
        </svg>
      </button>
    </div>
  );
}

/**
 * The frameless window's title bar. The bar itself is the drag region; every
 * interactive element inside opts out (`-webkit-app-region: no-drag`).
 */
export function TitleBar() {
  const windowState = useWindowState();
  const hunt = useActiveHunt();
  const toggleOverlayKey = useSettings().hotkeys.bindings.toggleOverlay[0];

  return (
    <header
      className={styles.titlebar}
      data-focused={windowState.focused}
      data-maximized={windowState.maximized}
    >
      <div className={styles.brand}>
        <Logo size={22} alive={windowState.focused} />
        <span className={styles.wordmark}>Biolume</span>
      </div>

      <div className={styles.center}>
        <ActiveHuntChip hunt={hunt} />
      </div>

      <div className={styles.controls}>
        <HotkeyStatusPill />
        <IconButton
          label={windowState.overlayOpen ? 'Close mini-overlay' : 'Open mini-overlay'}
          size="sm"
          pressed={windowState.overlayOpen}
          tooltipPlacement="bottom"
          {...(toggleOverlayKey === undefined ? {} : { shortcut: toggleOverlayKey })}
          onClick={() => void actions.toggleOverlay()}
        >
          <PictureInPicture2 />
        </IconButton>
        <IconButton
          label={windowState.alwaysOnTop ? 'Unpin window' : 'Keep window on top'}
          size="sm"
          pressed={windowState.alwaysOnTop}
          tooltipPlacement="bottom"
          onClick={() => void actions.toggleAlwaysOnTop()}
        >
          <Pin />
        </IconButton>
        <WindowControls maximized={windowState.maximized} />
      </div>
    </header>
  );
}
