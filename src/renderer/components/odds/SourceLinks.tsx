import { ExternalLink } from 'lucide-react';
import { actions } from '@renderer/store';
import styles from './SourceLinks.module.css';

/**
 * A readable name for a source URL: the site, then the last meaningful part of
 * the path — `https://bulbapedia.bulbagarden.net/wiki/Shiny_Pok%C3%A9mon` →
 * `{ site: 'bulbapedia.bulbagarden.net', page: 'Shiny Pokémon' }`.
 */
export function describeSource(url: string): { site: string; page: string } {
  try {
    const parsed = new URL(url);
    const site = parsed.hostname.replace(/^www\./, '');
    const segments = parsed.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1] ?? '';
    let page = last;
    try {
      page = decodeURIComponent(last);
    } catch {
      // A malformed escape: show the raw segment.
    }
    page = page
      .replace(/\.(s?html?|php|json|txt|png|js|cs|py)$/i, '')
      .replace(/[_-]+/g, ' ')
      .trim();
    return { site, page };
  } catch {
    return { site: url, page: '' };
  }
}

export interface SourceLinksProps {
  sources: readonly string[];
  /** Accessible name of the list. */
  label?: string;
}

/** Source URLs as buttons that open in the system browser (never inside the app window). */
export function SourceLinks({ sources, label = 'Sources' }: SourceLinksProps) {
  if (sources.length === 0) return null;
  return (
    <ul className={styles.list} aria-label={label}>
      {sources.map((url) => {
        const { site, page } = describeSource(url);
        return (
          <li key={url}>
            <button
              type="button"
              className={styles.link}
              title={url}
              onClick={() => void actions.openExternal(url)}
            >
              <ExternalLink className={styles.icon} aria-hidden="true" />
              <span className={styles.site}>{site}</span>
              {page ? <span className={styles.page}>{page}</span> : null}
              <span className="sr-only">(opens in your browser)</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
