import { useMemo, useState } from 'react';
import { ArchiveRestore, ListChecks, Plus, Radar } from 'lucide-react';
import { huntTotal, type Hunt } from '@shared/types';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconButton,
  Page,
  Select,
  Sprite,
  type SelectGroup,
  type SelectOption,
} from '@renderer/components/ui';
import { formatCount } from '@renderer/lib/format';
import {
  actions,
  useActiveHunt,
  useAppStore,
  useHunt,
  useHunts,
  useLastChange,
  useStreamDeckStatus,
} from '@renderer/store';
import { CompletedSummary } from './hunt/CompletedSummary';
import { registerMilestoneResolver, restoreHunt } from './hunt/huntActions';
import { HuntManagerDialog, NewHuntDialog, RenameHuntDialog } from './hunt/HuntDialogs';
import { HuntHero } from './hunt/HuntHero';
import { describeOddsSource, LuckPanel, StatTiles } from './hunt/HuntStatsPanels';
import { deriveHuntStats, groupHunts, huntOdds, listSpriteSources } from './hunt/huntStats';
import { PhaseList } from './hunt/PhaseList';
import styles from './hunt/hunt.module.css';

// The milestone chime needs to know each hunt's odds; wire the odds engine in once.
registerMilestoneResolver();

const STATUS_LABELS = { active: 'Active', completed: 'Completed', archived: 'Archived' } as const;

function huntOption(hunt: Hunt): SelectOption {
  return {
    value: hunt.id,
    label: hunt.name,
    meta: formatCount(huntTotal(hunt)),
    icon: <Sprite src={listSpriteSources(hunt.target)} alt="" size={22} />,
  };
}

/** Quick switcher in the page header: every hunt, grouped by status. */
function HuntPicker({ hunts, activeHuntId }: { hunts: Hunt[]; activeHuntId: string | null }) {
  const options = useMemo((): SelectGroup[] => {
    const groups = groupHunts(hunts);
    return (['active', 'completed', 'archived'] as const)
      .filter((status) => groups[status].length > 0)
      .map((status) => ({
        label: STATUS_LABELS[status],
        options: groups[status].map(huntOption),
      }));
  }, [hunts]);

  return (
    <Select
      aria-label="Hunt on the counter"
      className={styles.picker}
      fullWidth={false}
      options={options}
      value={activeHuntId}
      placeholder="Choose a hunt"
      onChange={(huntId) => void actions.setActiveHunt(huntId)}
    />
  );
}

/** "Stream Deck" in the header while the Biolume plugin is connected: its keys drive this view. */
function StreamDeckChip() {
  const { clients } = useStreamDeckStatus();
  if (clients <= 0) return null;
  const connections = `${formatCount(clients)} ${clients === 1 ? 'connection' : 'connections'}`;
  return (
    <Badge
      tone="teal"
      dot="pulse"
      className={styles.deckChip}
      title={`The Biolume Stream Deck plugin is connected (${connections}). Its keys count on the active hunt.`}
      data-testid="stream-deck-chip"
    >
      Stream Deck<span className="sr-only"> connected</span>
    </Badge>
  );
}

interface ActiveHuntProps {
  hunt: Hunt;
  onNewHunt: () => void;
  onRename: () => void;
}

/** The dashboard of the hunt on the counter: hero (or the finished summary), stats, luck, phases. */
function ActiveHunt({ hunt, onNewHunt, onRename }: ActiveHuntProps) {
  const selection = hunt.odds;
  const odds = useMemo(() => huntOdds({ odds: selection }), [selection]);
  const stats = useMemo(() => deriveHuntStats(hunt, odds?.perEncounter), [hunt, odds]);

  // Celebrate only a completion that happens while this view is watching.
  const lastChange = useLastChange();
  const [seenAtMount] = useState(() => useAppStore.getState().lastChange);
  const celebrationKey =
    lastChange !== null &&
    lastChange !== seenAtMount &&
    lastChange.huntId === hunt.id &&
    lastChange.change.kind === 'completed'
      ? `${lastChange.at}`
      : null;

  const completed = hunt.status === 'completed';

  return (
    <>
      {hunt.status === 'archived' ? (
        <div className={styles.notice} role="status">
          <span className={styles.noticeText}>
            This hunt is archived. It still counts, but it is hidden from the active list.
          </span>
          <Button size="sm" leadingIcon={<ArchiveRestore />} onClick={() => void restoreHunt(hunt)}>
            Restore
          </Button>
        </div>
      ) : null}
      <div className={styles.layout}>
        <div className={styles.main}>
          {completed ? (
            <CompletedSummary
              hunt={hunt}
              odds={odds}
              stats={stats}
              celebrationKey={celebrationKey}
              onNewHunt={onNewHunt}
            />
          ) : (
            <HuntHero hunt={hunt} odds={odds} stats={stats} onRename={onRename} />
          )}
          <StatTiles hunt={hunt} odds={odds} stats={stats} />
        </div>
        <div className={styles.side}>
          <LuckPanel stats={stats} completed={completed} />
          <PhaseList hunt={hunt} />
        </div>
      </div>
    </>
  );
}

/** Shown when hunts exist but none is on the counter: pick one up again, or start fresh. */
function ResumeList({ hunts }: { hunts: Hunt[] }) {
  const groups = groupHunts(hunts);
  const ordered = [...groups.active, ...groups.completed, ...groups.archived];

  return (
    <div className={styles.resume}>
      {ordered.map((hunt) => (
        <Card
          key={hunt.id}
          aria-label={`Open ${hunt.name}`}
          onClick={() => void actions.setActiveHunt(hunt.id)}
        >
          <span className={styles.resumeCard}>
            <Sprite src={listSpriteSources(hunt.target)} alt="" size={44} />
            <span className={styles.resumeText}>
              <span className={styles.resumeName}>{hunt.name}</span>
              <span className={styles.resumeMeta}>
                {formatCount(huntTotal(hunt))} encounters
                {hunt.phases.length > 0 ? ` · ${formatCount(hunt.phases.length)} phases` : ''}
              </span>
            </span>
            {hunt.status === 'active' ? null : (
              <Badge size="sm" tone={hunt.status === 'completed' ? 'shiny' : 'neutral'}>
                {STATUS_LABELS[hunt.status]}
              </Badge>
            )}
          </span>
        </Card>
      ))}
    </div>
  );
}

/**
 * Hunt view — the smart counter and phase tracker: the screen a hunter keeps
 * open for hours. The main process owns every number shown here; this view
 * only calls actions and renders what comes back.
 */
export default function Counter() {
  const hunts = useHunts();
  const hunt = useActiveHunt();
  const [dialog, setDialog] = useState<'none' | 'new' | 'manage'>('none');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const renaming = useHunt(renamingId);

  const closeDialog = (): void => setDialog('none');
  const openNewHunt = (): void => setDialog('new');

  const subtitle = hunt ? describeOddsSource(huntOdds(hunt)) : 'Smart counter and phase tracker';

  return (
    <Page
      title="Hunt"
      subtitle={subtitle}
      icon={<Radar />}
      actions={
        <>
          <StreamDeckChip />
          {hunts.length > 0 ? (
            <>
              <HuntPicker hunts={hunts} activeHuntId={hunt?.id ?? null} />
              <IconButton
                label="Manage hunts"
                variant="secondary"
                tooltipPlacement="bottom"
                onClick={() => setDialog('manage')}
              >
                <ListChecks />
              </IconButton>
            </>
          ) : null}
          <Button
            variant={hunt ? 'secondary' : 'primary'}
            leadingIcon={<Plus />}
            onClick={openNewHunt}
          >
            New hunt
          </Button>
        </>
      }
    >
      <div className={styles.view}>
        {hunt ? (
          <ActiveHunt
            key={hunt.id}
            hunt={hunt}
            onNewHunt={openNewHunt}
            onRename={() => setRenamingId(hunt.id)}
          />
        ) : hunts.length === 0 ? (
          <EmptyState
            icon={<Radar />}
            title="No hunts yet"
            description="Start a hunt to count encounters by click or hotkey, log the phases along the way and watch your odds in real time."
            action={
              <Button variant="primary" size="lg" leadingIcon={<Plus />} onClick={openNewHunt}>
                Start your first hunt
              </Button>
            }
          />
        ) : (
          <>
            <EmptyState
              icon={<Radar />}
              title="No hunt on the counter"
              description="Pick one of your hunts to keep counting, or start a new one."
              action={
                <Button variant="primary" leadingIcon={<Plus />} onClick={openNewHunt}>
                  New hunt
                </Button>
              }
            />
            <ResumeList hunts={hunts} />
          </>
        )}
      </div>

      <NewHuntDialog open={dialog === 'new'} onClose={closeDialog} />
      <HuntManagerDialog
        open={dialog === 'manage'}
        onClose={closeDialog}
        onNewHunt={openNewHunt}
        onRename={(entry) => setRenamingId(entry.id)}
      />
      <RenameHuntDialog hunt={renaming} onClose={() => setRenamingId(null)} />
    </Page>
  );
}
