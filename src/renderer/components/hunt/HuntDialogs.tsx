import { useMemo, useState } from 'react';
import { Archive, ArchiveRestore, ListChecks, Pencil, Plus, Radar, Trash2 } from 'lucide-react';
import { FULL_ODDS_METHOD_ID, LIMITS } from '@shared/defaults';
import { huntTotal, type Hunt } from '@shared/types';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  IconButton,
  Modal,
  Select,
  Sprite,
  TextField,
  Toggle,
  type SelectItem,
  type SelectOption,
} from '@renderer/components/ui';
import { formatCount, formatOdds, formatRelativeTime } from '@renderer/lib/format';
import { oddsEngine } from '@renderer/lib/oddsData';
import { toTargetRef } from '@renderer/lib/species';
import { actions, toast, useActiveHunt, useAppStore, useHunts } from '@renderer/store';
import { archiveHunt, deleteHunt, restoreHunt } from './huntActions';
import { groupHunts, huntOdds, listSpriteSources, suggestHuntName } from './huntStats';
import { SpeciesCombobox, SpeciesPreview, useSpeciesField } from './SpeciesCombobox';
import styles from './dialogs.module.css';

// ───────────────────────────── New hunt ─────────────────────────────

function gameOptions(): SelectItem[] {
  return oddsEngine.gamesByGeneration().map((group) => ({
    label: `Generation ${group.generation}`,
    options: group.games.map((game) => ({
      value: game.id,
      label: game.name,
      meta: game.shortName,
      keywords: game.shortName,
    })),
  }));
}

function NewHuntForm({ onClose }: { onClose: () => void }) {
  const activeHunt = useActiveHunt();
  // Hunters usually stay in one game: start from the game (and charm) of the hunt on the counter.
  const [gameId, setGameId] = useState(
    () => oddsEngine.getGame(activeHunt?.odds.gameId ?? '')?.id ?? oddsEngine.defaultGame.id,
  );
  const [methodId, setMethodId] = useState(FULL_ODDS_METHOD_ID);
  const [shinyCharm, setShinyCharm] = useState(() => activeHunt?.odds.shinyCharm ?? false);
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const species = useSpeciesField('', (result) => {
    if (!nameEdited) setName(suggestHuntName(result.name));
  });

  const games = useMemo(gameOptions, []);
  const selection = useMemo(
    () => oddsEngine.updateSelection(oddsEngine.defaultSelection(gameId, methodId), { shinyCharm }),
    [gameId, methodId, shinyCharm],
  );
  const odds = useMemo(() => oddsEngine.compute(selection), [selection]);
  const { game, method } = odds;

  const methods = useMemo(
    (): SelectOption[] =>
      game.methods.map((entry) => {
        const preview = oddsEngine.compute(
          oddsEngine.updateSelection(oddsEngine.defaultSelection(game.id, entry.id), {
            shinyCharm,
          }),
        );
        return {
          value: entry.id,
          label: entry.name,
          description: entry.summary,
          meta: formatOdds(preview.perEncounter),
        };
      }),
    [game, shinyCharm],
  );

  const charmUsable = odds.charmAvailable && method.charmApplies;
  const charmNote = !odds.charmAvailable
    ? `${game.name} has no Shiny Charm.`
    : !method.charmApplies
      ? `${method.name} ignores the Shiny Charm.`
      : `Adds ${formatCount(game.shinyCharmRolls ?? 0)} extra shiny rolls per encounter.`;

  const submit = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    const typedName = name.trim();
    const hunt = await actions.createHunt({
      name: typedName === '' ? suggestHuntName(species.resolved?.name) : typedName,
      target: species.resolved
        ? toTargetRef(species.resolved.species, species.resolved.form)
        : null,
      odds: selection,
      step: 1,
    });
    setSaving(false);
    if (hunt) {
      toast.success('Hunt started', { description: hunt.name });
      onClose();
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="New hunt"
      description="Pick what you are after and how you are hunting it. Everything can be changed later."
      icon={<Radar />}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={saving} leadingIcon={<Plus />}>
            Start hunt
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <Field label="Target" hint="Optional — search by name or dex number, forms included.">
          <SpeciesCombobox
            value={species.text}
            onValueChange={species.onValueChange}
            onSelect={species.onSelect}
            shiny
            placeholder="Search Pokémon…"
            onEscape={onClose}
          />
        </Field>
        <SpeciesPreview
          result={species.resolved}
          text={species.text}
          shiny
          variant="target"
          emptyLabel="No target yet"
          freeTextLabel="Not in the index — pick a result to attach a target"
        />

        <Field label="Hunt name">
          <TextField
            value={name}
            maxLength={LIMITS.huntName}
            placeholder={suggestHuntName(species.resolved?.name)}
            onValueChange={(value) => {
              setName(value);
              setNameEdited(value.trim() !== '');
            }}
          />
        </Field>

        <div className={styles.row}>
          <Field label="Game">
            <Select
              options={games}
              value={game.id}
              onChange={(value) => {
                setGameId(value);
                setMethodId(FULL_ODDS_METHOD_ID);
              }}
            />
          </Field>
          <Field label="Method">
            <Select options={methods} value={method.id} onChange={setMethodId} />
          </Field>
        </div>

        <Toggle
          checked={shinyCharm && charmUsable}
          disabled={!charmUsable}
          label="Shiny Charm"
          description={charmNote}
          onChange={setShinyCharm}
        />

        <div className={styles.oddsPreview}>
          <span className={styles.oddsValue}>{formatOdds(odds.perEncounter)}</span>
          <span>
            starting odds per encounter. Chains, bonuses and sandwiches are tuned in the Odds view.
          </span>
        </div>
      </div>
    </Modal>
  );
}

export interface NewHuntDialogProps {
  open: boolean;
  onClose: () => void;
}

/** Creates a hunt: optional target, name, game and method with that method's default inputs. */
export function NewHuntDialog({ open, onClose }: NewHuntDialogProps) {
  // Mounted per opening, so every dialog starts from a clean form.
  return open ? <NewHuntForm onClose={onClose} /> : null;
}

// ───────────────────────────── Rename ─────────────────────────────

function RenameForm({ hunt, onClose }: { hunt: Hunt; onClose: () => void }) {
  const [name, setName] = useState(hunt.name);
  const [saving, setSaving] = useState(false);
  const trimmed = name.trim();

  const submit = async (): Promise<void> => {
    if (trimmed === '' || saving) return;
    if (trimmed !== hunt.name) {
      setSaving(true);
      const updated = await actions.updateHunt(hunt.id, { name: trimmed });
      setSaving(false);
      if (!updated) return;
    }
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title="Rename hunt"
      icon={<Pencil />}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={saving} disabled={trimmed === ''}>
            Save
          </Button>
        </>
      }
    >
      <Field label="Hunt name" error={trimmed === '' ? 'A hunt needs a name.' : undefined}>
        <TextField
          value={name}
          maxLength={LIMITS.huntName}
          data-autofocus=""
          onFocus={(event) => event.currentTarget.select()}
          onValueChange={setName}
        />
      </Field>
    </Modal>
  );
}

export interface RenameHuntDialogProps {
  /** The hunt being renamed; null keeps the dialog closed. */
  hunt: Hunt | null;
  onClose: () => void;
}

export function RenameHuntDialog({ hunt, onClose }: RenameHuntDialogProps) {
  return hunt ? <RenameForm key={hunt.id} hunt={hunt} onClose={onClose} /> : null;
}

// ───────────────────────────── Manager ─────────────────────────────

interface HuntRowProps {
  hunt: Hunt;
  current: boolean;
  onOpen: () => void;
  onRename: () => void;
}

function HuntRow({ hunt, current, onOpen, onRename }: HuntRowProps) {
  const odds = huntOdds(hunt);
  const meta = [
    `${formatCount(huntTotal(hunt))} encounters`,
    hunt.phases.length > 0 ? `${formatCount(hunt.phases.length)} phases` : null,
    odds ? odds.game.shortName : null,
    `updated ${formatRelativeTime(hunt.updatedAt)}`,
  ].filter((part): part is string => part !== null);

  return (
    <li className={styles.huntRow} data-current={current ? '' : undefined}>
      <Sprite src={listSpriteSources(hunt.target)} alt="" size={40} />
      <div className={styles.huntRowText}>
        <span className={styles.huntRowName}>{hunt.name}</span>
        <span className={styles.huntRowMeta}>{meta.join(' · ')}</span>
      </div>
      <div className={styles.huntRowActions}>
        {current ? (
          <Badge tone="accent" dot="pulse">
            On the counter
          </Badge>
        ) : (
          <Button size="sm" onClick={onOpen}>
            Open
          </Button>
        )}
        <IconButton size="sm" label={`Rename ${hunt.name}`} onClick={onRename}>
          <Pencil />
        </IconButton>
        {hunt.status === 'archived' ? (
          <IconButton
            size="sm"
            label={`Restore ${hunt.name} from the archive`}
            onClick={() => void restoreHunt(hunt)}
          >
            <ArchiveRestore />
          </IconButton>
        ) : (
          <IconButton
            size="sm"
            label={`Archive ${hunt.name}`}
            onClick={() => void archiveHunt(hunt)}
          >
            <Archive />
          </IconButton>
        )}
        <IconButton size="sm" label={`Delete ${hunt.name}`} onClick={() => void deleteHunt(hunt)}>
          <Trash2 />
        </IconButton>
      </div>
    </li>
  );
}

export interface HuntManagerDialogProps {
  open: boolean;
  onClose: () => void;
  onNewHunt: () => void;
  onRename: (hunt: Hunt) => void;
}

/** Every hunt by status — switch to one, rename, archive / restore, delete. */
export function HuntManagerDialog({ open, onClose, onNewHunt, onRename }: HuntManagerDialogProps) {
  const hunts = useHunts();
  const activeHuntId = useAppStore((state) => state.activeHuntId);
  const groups = useMemo(() => groupHunts(hunts), [hunts]);
  const sections: [label: string, list: Hunt[]][] = [
    ['Active', groups.active],
    ['Completed', groups.completed],
    ['Archived', groups.archived],
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Hunts"
      description="Switch the counter to another hunt, or rename, archive and delete."
      icon={<ListChecks />}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
          <Button variant="primary" leadingIcon={<Plus />} onClick={onNewHunt}>
            New hunt
          </Button>
        </>
      }
    >
      {hunts.length === 0 ? (
        <EmptyState
          size="sm"
          icon={<Radar />}
          title="No hunts yet"
          description="Start one to begin counting."
        />
      ) : (
        <div className={styles.groups}>
          {sections.map(([label, list]) =>
            list.length === 0 ? null : (
              <section key={label} aria-label={`${label} hunts`}>
                <h3 className={`eyebrow ${styles.groupTitle ?? ''}`}>
                  {label} · {formatCount(list.length)}
                </h3>
                <ul className={styles.huntList}>
                  {list.map((hunt) => (
                    <HuntRow
                      key={hunt.id}
                      hunt={hunt}
                      current={hunt.id === activeHuntId}
                      onOpen={() => {
                        void actions.setActiveHunt(hunt.id);
                        onClose();
                      }}
                      onRename={() => onRename(hunt)}
                    />
                  ))}
                </ul>
              </section>
            ),
          )}
        </div>
      )}
    </Modal>
  );
}
