import type { ViewId } from '@shared/ipc';
import { Tooltip } from '@renderer/components/ui';
import { useMediaQuery } from '@renderer/hooks/useReducedMotion';
import { viewHref } from '@renderer/hooks/useView';
import { VIEWS } from './views';
import styles from './Sidebar.module.css';

/** Below this window width the sidebar collapses to an icon rail (side-by-side play). */
export const SIDEBAR_COLLAPSE_QUERY = '(max-width: 880px)';

export interface SidebarProps {
  /** The view currently shown. */
  view: ViewId;
}

/**
 * Primary navigation. The items are plain hash links (`#/hunt`), so they work
 * with the keyboard, the context menu and `aria-current` without any routing
 * code; Ctrl+1..6 is handled by `useViewShortcuts`.
 */
export function Sidebar({ view }: SidebarProps) {
  const collapsed = useMediaQuery(SIDEBAR_COLLAPSE_QUERY);
  const modifier = window.biolume.platform === 'darwin' ? '⌘' : 'Ctrl';

  return (
    <aside className={styles.sidebar} data-collapsed={collapsed}>
      <nav aria-label="Views" className={styles.nav}>
        <ul className={styles.list}>
          {VIEWS.map((item) => {
            const active = item.id === view;
            const Icon = item.icon;
            return (
              <li key={item.id}>
                <Tooltip
                  placement="right"
                  delay={collapsed ? 150 : 700}
                  shortcut={`CommandOrControl+${item.shortcutDigit}`}
                  content={
                    <span className={styles.tip}>
                      <strong>{item.label}</strong>
                      <span>{item.hint}</span>
                    </span>
                  }
                >
                  <a
                    href={viewHref(item.id)}
                    className={styles.item}
                    aria-current={active ? 'page' : undefined}
                    aria-keyshortcuts={`Control+${item.shortcutDigit}`}
                    draggable={false}
                  >
                    <span className={styles.icon}>
                      <Icon aria-hidden="true" />
                    </span>
                    <span className={styles.label}>{item.label}</span>
                    {/* Compact text, not key caps: "Sandwiches" needs the room. */}
                    <span className={styles.shortcut} aria-hidden="true">
                      {modifier}
                      {modifier === '⌘' ? '' : '+'}
                      {item.shortcutDigit}
                    </span>
                  </a>
                </Tooltip>
              </li>
            );
          })}
        </ul>
      </nav>
      <footer className={styles.footer}>
        <span className={styles.version}>v{window.biolume.versions.app}</span>
        <span className={styles.tagline}>Light in the deep</span>
      </footer>
    </aside>
  );
}
