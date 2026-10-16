import { useEffect, useState, type ReactNode } from 'react';
import { Download, FolderOpen, HardDrive, Upload } from 'lucide-react';
import type {
  ExportDataset,
  ExportFormat,
  ExportResult,
  ImportRequest,
  ImportResult,
} from '@shared/types';
import {
  Badge,
  Button,
  confirm,
  Field,
  Panel,
  SegmentedControl,
  Skeleton,
  type SegmentedOption,
  type Tone,
} from '@renderer/components/ui';
import { formatCount } from '@renderer/lib/format';
import { actions, toast } from '@renderer/store';
import { importedTotal, importOutcome, resolveExportFormat } from './huntStats';
import styles from './log.module.css';

const DATASETS: Record<ExportDataset, { label: string; description: string }> = {
  backup: {
    label: 'Full backup',
    description:
      'Everything: hunts with their phases, session history and settings. JSON only — this is the file to restore from.',
  },
  sessions: {
    label: 'Sessions',
    description: 'Session history: when you hunted, for how long and how many encounters.',
  },
  phases: {
    label: 'Phases',
    description: 'Every logged phase, one row per phase with the hunt it belongs to.',
  },
  targets: {
    label: 'Targets',
    description:
      'Hunt setups — target, game, method and step — without any progress. Handy for sharing a plan.',
  },
};

const DATASET_OPTIONS: SegmentedOption<ExportDataset>[] = (
  Object.keys(DATASETS) as ExportDataset[]
).map((value) => ({ value, label: DATASETS[value].label }));

const MODE_OPTIONS: SegmentedOption<ImportRequest['mode']>[] = [
  { value: 'merge', label: 'Merge' },
  { value: 'replace', label: 'Replace' },
];

const MODE_DESCRIPTIONS: Record<ImportRequest['mode'], string> = {
  merge:
    'Keeps what you have. Records from the file are added; ones with a matching id are updated.',
  replace:
    'Swaps the imported dataset in: what Biolume holds for it now is discarded. You are asked to confirm first.',
};

interface ResultCardProps {
  tone: Tone;
  title: string;
  path?: string | null;
  children?: ReactNode;
}

function ResultCard({ tone, title, path, children }: ResultCardProps) {
  return (
    <div className={styles.result} data-tone={tone} role="status">
      <span className={styles.resultTitle}>{title}</span>
      {children}
      {path ? <span className={styles.resultPath}>{path}</span> : null}
    </div>
  );
}

/** The outcome of the last export. `result` is null when the call itself failed (already toasted). */
function ExportOutcome({ result }: { result: ExportResult | null }) {
  if (result === null) {
    return <ResultCard tone="danger" title="The export could not be started." />;
  }
  if (result.error) {
    return (
      <ResultCard tone="danger" title="Export failed" path={result.filePath}>
        <span>{result.error}</span>
      </ResultCard>
    );
  }
  if (result.canceled) {
    return <ResultCard tone="neutral" title="Export cancelled — nothing was written." />;
  }
  return (
    <ResultCard
      tone="ok"
      title={`Exported ${formatCount(result.records)} ${result.records === 1 ? 'record' : 'records'}`}
      path={result.filePath}
    />
  );
}

const IMPORT_KINDS = ['hunts', 'phases', 'sessions', 'targets'] as const;

function ImportOutcomeCard({ result }: { result: ImportResult | null }) {
  if (result === null) {
    return <ResultCard tone="danger" title="The import could not be started." />;
  }
  const outcome = importOutcome(result);
  if (outcome === 'canceled') {
    return <ResultCard tone="neutral" title="Import cancelled — nothing was changed." />;
  }

  const title =
    outcome === 'unrecognised'
      ? 'This file is not a Biolume export'
      : outcome === 'nothing'
        ? 'Nothing was imported'
        : `Imported ${formatCount(importedTotal(result))} records${
            result.dataset ? ` from a ${DATASETS[result.dataset].label.toLowerCase()} file` : ''
          }`;
  const tone: Tone = outcome === 'clean' ? 'ok' : outcome === 'partial' ? 'warn' : 'danger';

  return (
    <ResultCard tone={tone} title={title} path={result.filePath}>
      <div className={styles.resultCounts}>
        {IMPORT_KINDS.map((kind) =>
          result.imported[kind] > 0 ? (
            <Badge key={kind} tone="ok" size="sm">
              {formatCount(result.imported[kind])} {kind}
            </Badge>
          ) : null,
        )}
        {result.skipped > 0 ? (
          <Badge tone="warn" size="sm">
            {formatCount(result.skipped)} skipped
          </Badge>
        ) : null}
        {result.errors.length > 0 ? (
          <Badge tone="danger" size="sm">
            {formatCount(result.errors.length)}{' '}
            {result.errors.length === 1 ? 'problem' : 'problems'}
          </Badge>
        ) : null}
      </div>
      {result.errors.length > 0 ? (
        <ul className={styles.errorList}>
          {result.errors.slice(0, 20).map((error, index) => (
            <li key={`${index}-${error}`}>{error}</li>
          ))}
          {result.errors.length > 20 ? (
            <li>…and {formatCount(result.errors.length - 20)} more.</li>
          ) : null}
        </ul>
      ) : null}
    </ResultCard>
  );
}

/** Export, import and where the data lives. */
export function DataTab() {
  const [dataset, setDataset] = useState<ExportDataset>('backup');
  const [preferredFormat, setPreferredFormat] = useState<ExportFormat>('json');
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<{ result: ExportResult | null } | null>(null);

  const [mode, setMode] = useState<ImportRequest['mode']>('merge');
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<{ result: ImportResult | null } | null>(null);

  /** `undefined` while loading, `null` when the path could not be read. */
  const [dataPath, setDataPath] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void actions.getDataPath().then((path) => {
      if (alive) setDataPath(path);
    });
    return () => {
      alive = false;
    };
  }, []);

  const format = resolveExportFormat(dataset, preferredFormat);
  const formatOptions: SegmentedOption<ExportFormat>[] = [
    { value: 'json', label: 'JSON' },
    { value: 'csv', label: 'CSV', disabled: dataset === 'backup' },
  ];

  const runExport = async (): Promise<void> => {
    if (exporting) return;
    setExporting(true);
    const result = await actions.exportData({ dataset, format });
    setExporting(false);
    setExported({ result });
    if (result && !result.canceled && !result.error) {
      toast.success(`${DATASETS[dataset].label} exported`, {
        description: `${formatCount(result.records)} records`,
      });
    }
  };

  const runImport = async (): Promise<void> => {
    if (importing) return;
    if (mode === 'replace') {
      // Always asked, whatever the "confirm destructive actions" setting says: this can wipe everything.
      const confirmed = await confirm({
        tone: 'danger',
        title: 'Replace your data with the file?',
        message:
          'Whatever the file contains replaces what Biolume holds for it now — a full backup replaces every hunt, phase, session and setting. Export a backup first if you are not sure.',
        confirmLabel: 'Choose file and replace',
      });
      if (!confirmed) return;
    }
    setImporting(true);
    const result = await actions.importData({ mode });
    setImporting(false);
    setImported({ result });
    if (!result || result.canceled) return;
    const outcome = importOutcome(result);
    if (outcome === 'clean') {
      toast.success('Import complete', {
        description: `${formatCount(importedTotal(result))} records`,
      });
    } else if (outcome === 'partial') {
      toast.warning('Imported with problems', {
        description: `${formatCount(result.skipped)} skipped, ${formatCount(result.errors.length)} problems — see the details.`,
      });
    } else {
      toast.error('Nothing was imported', {
        description: result.errors[0] ?? 'The file was not recognised as a Biolume export.',
      });
    }
  };

  return (
    <div className={styles.dataGrid}>
      <Panel title="Export" icon={<Download />}>
        <div className={styles.dataBody}>
          <Field label="Dataset" hint={DATASETS[dataset].description}>
            <SegmentedControl
              fullWidth
              options={DATASET_OPTIONS}
              value={dataset}
              onChange={setDataset}
            />
          </Field>
          <Field
            label="Format"
            hint={
              dataset === 'backup'
                ? 'A full backup is always JSON.'
                : 'CSV opens in any spreadsheet; JSON can be imported back.'
            }
          >
            <SegmentedControl
              options={formatOptions}
              value={format}
              onChange={setPreferredFormat}
            />
          </Field>
          <div className={styles.dataActions}>
            <Button
              variant="primary"
              leadingIcon={<Download />}
              loading={exporting}
              onClick={() => void runExport()}
            >
              Export {DATASETS[dataset].label.toLowerCase()} as {format.toUpperCase()}…
            </Button>
          </div>
          {exported ? <ExportOutcome result={exported.result} /> : null}
        </div>
      </Panel>

      <Panel title="Import" icon={<Upload />}>
        <div className={styles.dataBody}>
          <p className={styles.dataHint}>
            Reads a file exported by Biolume — a full backup, or a sessions, phases or targets file
            — and detects which one it is.
          </p>
          <Field label="Existing data" hint={MODE_DESCRIPTIONS[mode]}>
            <SegmentedControl options={MODE_OPTIONS} value={mode} onChange={setMode} />
          </Field>
          <div className={styles.dataActions}>
            <Button
              variant={mode === 'replace' ? 'danger' : 'secondary'}
              leadingIcon={<Upload />}
              loading={importing}
              onClick={() => void runImport()}
            >
              {mode === 'replace' ? 'Import and replace…' : 'Import and merge…'}
            </Button>
          </div>
          {imported ? <ImportOutcomeCard result={imported.result} /> : null}
        </div>
      </Panel>

      <Panel title="Storage" icon={<HardDrive />} className={styles.dataWide}>
        <div className={styles.dataBody}>
          <p className={styles.dataHint}>
            Everything is stored locally on this computer, in plain files you can back up yourself.
          </p>
          <div className={styles.pathRow}>
            {dataPath === undefined ? (
              <Skeleton width="60%" height={30} />
            ) : (
              <span className={styles.path}>
                {dataPath ?? 'The data folder could not be located.'}
              </span>
            )}
            <Button leadingIcon={<FolderOpen />} onClick={() => void actions.revealDataFolder()}>
              Open data folder
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}
