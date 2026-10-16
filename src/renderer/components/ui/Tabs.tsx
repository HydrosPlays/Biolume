import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from './internal/cx';
import styles from './Tabs.module.css';

export interface TabItem<V extends string = string> {
  id: V;
  label: ReactNode;
  /** Leading icon (15px). */
  icon?: ReactNode;
  /** Trailing count or Badge. */
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps<V extends string = string> {
  /**
   * Id prefix shared with the matching {@link TabPanel}s; it links each tab to
   * its panel (`aria-controls` / `aria-labelledby`).
   */
  id: string;
  items: readonly TabItem<V>[];
  /** Id of the selected tab (controlled). */
  value: V;
  onChange: (id: V) => void;
  /** Names the tab list for assistive tech, e.g. "Log sections". */
  'aria-label': string;
  className?: string;
}

function tabDomId(tabsId: string, tabId: string): string {
  return `${tabsId}-tab-${tabId}`;
}

function panelDomId(tabsId: string, tabId: string): string {
  return `${tabsId}-panel-${tabId}`;
}

/**
 * An underlined tab list. Arrow keys move between tabs and select them
 * (automatic activation); Home / End jump to the ends.
 *
 *   <Tabs id="log" items={items} value={tab} onChange={setTab} aria-label="Log sections" />
 *   <TabPanel tabsId="log" tabId="sessions" active={tab === 'sessions'}>…</TabPanel>
 */
export function Tabs<V extends string = string>({
  id,
  items,
  value,
  onChange,
  className,
  ...rest
}: TabsProps<V>) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const selectedIndex = items.findIndex((item) => item.id === value);

  const select = (index: number): void => {
    const item = items[index];
    if (!item) return;
    onChange(item.id);
    document.getElementById(tabDomId(id, item.id))?.focus();
  };

  const step = (from: number, direction: 1 | -1): void => {
    for (let offset = 1; offset <= items.length; offset += 1) {
      const index = (from + direction * offset + items.length * offset) % items.length;
      if (!items[index]?.disabled) {
        select(index);
        return;
      }
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const current = selectedIndex === -1 ? 0 : selectedIndex;
    switch (event.key) {
      case 'ArrowRight':
        step(current, 1);
        break;
      case 'ArrowLeft':
        step(current, -1);
        break;
      case 'Home':
        step(-1, 1);
        break;
      case 'End':
        step(items.length, -1);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={rest['aria-label']}
      className={cx(styles.list, className)}
      onKeyDown={onKeyDown}
    >
      {items.map((item, index) => {
        const selected = index === selectedIndex;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={tabDomId(id, item.id)}
            aria-selected={selected}
            aria-controls={panelDomId(id, item.id)}
            disabled={item.disabled}
            tabIndex={selected || (selectedIndex === -1 && index === 0) ? 0 : -1}
            className={styles.tab}
            onClick={() => onChange(item.id)}
          >
            {item.icon ? <span className={styles.icon}>{item.icon}</span> : null}
            <span>{item.label}</span>
            {item.badge !== undefined && item.badge !== null ? (
              <span className={styles.badge}>{item.badge}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps {
  /** The `id` given to the matching `Tabs`. */
  tabsId: string;
  /** The tab this panel belongs to. */
  tabId: string;
  /** Whether this panel's tab is selected. */
  active: boolean;
  /** Keep the panel mounted (hidden) while inactive, preserving its state. Default false. */
  keepMounted?: boolean;
  className?: string;
  children: ReactNode;
}

/** Content region for one tab; unmounted while inactive unless `keepMounted`. */
export function TabPanel({
  tabsId,
  tabId,
  active,
  keepMounted = false,
  className,
  children,
}: TabPanelProps) {
  if (!active && !keepMounted) return null;
  return (
    <div
      role="tabpanel"
      id={panelDomId(tabsId, tabId)}
      aria-labelledby={tabDomId(tabsId, tabId)}
      hidden={!active}
      className={cx(styles.panel, className)}
    >
      {children}
    </div>
  );
}
