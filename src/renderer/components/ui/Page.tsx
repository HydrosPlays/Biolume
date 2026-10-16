import { useCallback, useState, type ReactNode, type UIEvent } from 'react';
import { cx } from './internal/cx';
import styles from './Page.module.css';

export interface PageProps {
  /** View title — rendered as the window's single `<h1>`. */
  title: ReactNode;
  /** One calm line under the title: what this view is for, or the current context. */
  subtitle?: ReactNode;
  /** Icon tile before the title (20px lucide icon). */
  icon?: ReactNode;
  /** Header actions, right-aligned (primary button, overflow menu). */
  actions?: ReactNode;
  /** A fixed row between header and body — tabs, filters, a search field. */
  toolbar?: ReactNode;
  /**
   * Max content width: `narrow` (720) for forms, `default` (1180), `wide` (1480),
   * `full` for canvases and big tables.
   */
  width?: 'narrow' | 'default' | 'wide' | 'full';
  /**
   * `true` (default): the body scrolls. `false`: the body is a fixed-height flex
   * column and the view manages its own scrolling regions.
   */
  scroll?: boolean;
  /** Class for the body content wrapper (set your grid / stack here). */
  className?: string;
  children: ReactNode;
}

/**
 * Standard view scaffold: fixed header (title, subtitle, actions), optional
 * toolbar, and a scrollable, width-constrained body. Every view renders
 * exactly one Page so spacing and headings stay consistent across the app.
 */
export function Page({
  title,
  subtitle,
  icon,
  actions,
  toolbar,
  width = 'default',
  scroll = true,
  className,
  children,
}: PageProps) {
  const [scrolled, setScrolled] = useState(false);
  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    setScrolled(event.currentTarget.scrollTop > 2);
  }, []);

  return (
    <div className={styles.page} data-width={width} data-scroll={scroll}>
      <header className={styles.header} data-scrolled={scrolled || undefined}>
        <div className={styles.headerInner}>
          <div className={styles.heading}>
            {icon ? (
              <span className={styles.icon} aria-hidden="true">
                {icon}
              </span>
            ) : null}
            <div className={styles.titles}>
              <h1 className={styles.title}>{title}</h1>
              {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
            </div>
          </div>
          {actions ? <div className={styles.actions}>{actions}</div> : null}
        </div>
        {toolbar ? <div className={styles.toolbar}>{toolbar}</div> : null}
      </header>
      {scroll ? (
        <div className={styles.scroller} onScroll={onScroll}>
          <div className={cx(styles.content, className)}>{children}</div>
        </div>
      ) : (
        <div className={cx(styles.content, styles.fixed, className)}>{children}</div>
      )}
    </div>
  );
}
