import { BookOpenText } from 'lucide-react';
import type { MethodDef } from '@renderer/data/schema';
import { Panel } from '@renderer/components/ui';
import { SourceLinks } from './SourceLinks';
import styles from './Odds.module.css';

export interface MethodNotesProps {
  method: MethodDef;
}

/** How the method works, its caveats, and where the numbers come from. */
export function MethodNotes({ method }: MethodNotesProps) {
  const notes = method.notes ?? [];
  return (
    <Panel title="About this method" icon={<BookOpenText />} className={styles.notes}>
      <div className={styles.stack}>
        <p className={styles.details}>{method.details ?? method.summary}</p>

        {notes.length > 0 ? (
          <section aria-label="Caveats">
            <h3 className="eyebrow">Caveats</h3>
            <ul className={styles.caveats}>
              {notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </section>
        ) : null}

        <section aria-label="Sources">
          <h3 className="eyebrow">Sources</h3>
          {method.sources.length > 0 ? (
            <SourceLinks sources={method.sources} label={`Sources for ${method.name}`} />
          ) : (
            <p className={styles.muted}>No source is listed for this method.</p>
          )}
        </section>
      </div>
    </Panel>
  );
}
