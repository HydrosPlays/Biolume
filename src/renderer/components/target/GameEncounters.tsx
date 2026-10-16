import { useMemo, useState, type ReactNode } from 'react';
import {
  ArrowLeftRight,
  Ban,
  CloudFog,
  CloudLightning,
  CloudRain,
  Crown,
  Fish,
  Footprints,
  Gift,
  Layers,
  Lock,
  MapPin,
  MapPinOff,
  Moon,
  Mountain,
  Radio,
  RefreshCw,
  Snowflake,
  Sparkles,
  Sun,
  Sunrise,
  Sunset,
  Swords,
  Target,
  TreeDeciduous,
  TriangleAlert,
  Users,
  Waves,
  WifiOff,
  Wind,
  type LucideIcon,
} from 'lucide-react';
import { describePokeApiError } from '@renderer/api/pokeapi';
import { Badge, Button, Chip, EmptyState, Skeleton } from '@renderer/components/ui';
import type { EncounterKind, GameEncounterSlice } from '@renderer/data/encounterSchema';
import {
  containsLevel,
  filterLines,
  fixedEncounters,
  formatRate,
  groupByLocation,
  isExpansionCondition,
  summarizeEncounters,
  useGameEncounters,
  versionSlug,
  type EncounterFilterId,
  type EncounterLine,
  type EncounterOrigin,
  type LevelRange,
  type LocationGroup,
} from '@renderer/lib/gameEncounters';
import styles from './GameEncounters.module.css';

/** Locations (and, separately, fixed encounters) shown before the list has to be expanded. */
const COLLAPSED_AREAS = 6;

const KIND_ICON: Record<EncounterKind, LucideIcon> = {
  wild: Footprints,
  surf: Waves,
  fishing: Fish,
  interact: TreeDeciduous,
  special: Radio,
  outbreak: Users,
  alpha: Crown,
  den: Mountain,
  raid: Swords,
  static: Target,
  gift: Gift,
  trade: ArrowLeftRight,
};

const FILTER_ICON: Record<EncounterFilterId, LucideIcon> = {
  wild: Footprints,
  water: Waves,
  fishing: Fish,
  interact: TreeDeciduous,
  special: Radio,
  outbreak: Users,
  alpha: Crown,
  den: Mountain,
  raid: Swords,
  fixed: Gift,
};

/** Time of day and weather get an icon; other conditions are plain text. */
const CONDITION_ICONS: readonly (readonly [RegExp, LucideIcon])[] = [
  [/^morning\b/i, Sunrise],
  [/^(day|daytime)\b/i, Sun],
  [/^(evening|dusk)\b/i, Sunset],
  [/^night\b/i, Moon],
  [/thunder/i, CloudLightning],
  [/rain/i, CloudRain],
  [/snow|blizzard|hail/i, Snowflake],
  [/sandstorm|wind/i, Wind],
  [/fog|mist/i, CloudFog],
  [/sun/i, Sun],
];

/** Name of the regional Pokédex whose number the bundled data carries: [base game, DLC]. */
const REGIONAL_DEX: Record<string, readonly [string, string?]> = {
  za: ['Lumiose', 'Mega Dimension'],
  pla: ['Hisui'],
  bdsp: ['Sinnoh'],
  // The DLC number is Kitakami's when the Pokémon has one, else Blueberry's; the file does not say which.
  sv: ['Paldea', 'Kitakami / Blueberry'],
};

/** Where a shiny can be hunted instead of a locked fixed encounter. */
const HUNT_PLACE: Partial<Record<EncounterKind, string>> = { outbreak: 'outbreaks', raid: 'raids' };

function huntWhere(kinds: readonly EncounterKind[]): string {
  const places = [...new Set(kinds.map((kind) => HUNT_PLACE[kind] ?? 'the wild'))];
  const last = places.pop() ?? 'the wild';
  return places.length === 0 ? last : `${places.join(', ')} or ${last}`;
}

function formatRange({ min, max }: LevelRange): string {
  return min === max ? `Lv. ${min}` : `Lv. ${min}–${max}`;
}

function dexBadge(gameId: string, dex: number, dlc: boolean): string {
  const [base, expansion] = REGIONAL_DEX[gameId] ?? [];
  const label = dlc ? (expansion ?? 'Regional') : (base ?? 'Regional');
  return `${label} Dex #${String(dex).padStart(3, '0')}`;
}

export interface GameEncountersProps {
  gameId: string;
  gameName: string;
  /** PokeAPI `pokemon` id of the analysed variety. */
  pokemonId: number;
  name: string;
  /** Level currently analysed; clicking a level range moves it. */
  level: number;
  onLevelChange: (level: number) => void;
}

// ───────────────────────────── Small parts ─────────────────────────────

interface LevelButtonProps {
  range: LevelRange;
  alpha?: boolean;
  level: number;
  onLevelChange: (level: number) => void;
}

/** A level range that, when clicked, analyses the top of the range (the most moves learned). */
function LevelButton({ range, alpha = false, level, onLevelChange }: LevelButtonProps) {
  return (
    <button
      type="button"
      className={styles.level}
      data-alpha={alpha || undefined}
      data-current={containsLevel(range, level) || undefined}
      title={`Analyse at Lv. ${range.max}`}
      onClick={() => onLevelChange(range.max)}
    >
      {alpha ? <Crown aria-hidden="true" /> : null}
      <span>{alpha ? `Alpha ${formatRange(range)}` : formatRange(range)}</span>
    </button>
  );
}

function Condition({ condition }: { condition: string }) {
  const Icon = CONDITION_ICONS.find(([pattern]) => pattern.test(condition))?.[1];
  return (
    <span
      className={styles.condition}
      data-expansion={isExpansionCondition(condition) || undefined}
    >
      {Icon ? <Icon aria-hidden="true" /> : null}
      {condition}
    </span>
  );
}

function Version({ version }: { version: string }) {
  return (
    <span
      className={styles.version}
      data-version={versionSlug(version)}
      title={`Only in ${version}`}
    >
      {version}
    </span>
  );
}

/** Conditions and version exclusives of a line. */
function Details({ conditions, versions }: { conditions: string[]; versions: string[] }) {
  if (conditions.length === 0 && versions.length === 0) return null;
  return (
    <>
      {conditions.map((condition) => (
        <Condition key={condition} condition={condition} />
      ))}
      {versions.map((version) => (
        <Version key={version} version={version} />
      ))}
    </>
  );
}

const isAlphaLine = (line: EncounterLine): boolean =>
  line.kind === 'alpha' || line.conditions.includes('Alpha');

interface NoteProps {
  tone: 'info' | 'warn' | 'danger' | 'neutral';
  icon: ReactNode;
  children: ReactNode;
}

function Note({ tone, icon, children }: NoteProps) {
  return (
    <p className={styles.note} data-tone={tone}>
      {icon}
      <span>{children}</span>
    </p>
  );
}

/** What the panel shows; exposed as `data-state` for the smoke run. */
type FrameState = 'loading' | 'error' | 'unsupported' | 'empty' | 'ready';

interface FrameProps {
  name: string;
  gameName: string;
  state: FrameState;
  facts?: ReactNode;
  source?: string | null;
  children: ReactNode;
}

/** The panel around every state: title, facts, body, attribution. */
function Frame({ name, gameName, state, facts, source, children }: FrameProps) {
  return (
    <section
      className={styles.root}
      aria-label={`${name} in ${gameName}`}
      aria-busy={state === 'loading' || undefined}
      data-panel="game-encounters"
      data-state={state}
    >
      <header className={styles.head}>
        <h4 className={styles.title}>
          <MapPin aria-hidden="true" />
          In {gameName}
        </h4>
        {facts ? <div className={styles.facts}>{facts}</div> : null}
      </header>
      {children}
      {source ? <p className={styles.source}>Location data: {source}.</p> : null}
    </section>
  );
}

// ───────────────────────────── Locations ─────────────────────────────

interface LevelProps {
  level: number;
  onLevelChange: (level: number) => void;
}

function LocationCard({ group, level, onLevelChange }: { group: LocationGroup } & LevelProps) {
  const head = (
    <span className={styles.place}>
      <span className={styles.placeName}>{group.name}</span>
      {group.shared.map((condition) => (
        <Condition key={condition} condition={condition} />
      ))}
      {group.shinyLocked ? (
        <Badge tone="danger" size="sm" icon={<Lock />}>
          Shiny-locked
        </Badge>
      ) : null}
    </span>
  );

  if (group.compact) {
    return (
      <li className={styles.area} data-locked={group.shinyLocked || undefined}>
        {head}
        <span className={styles.levels}>
          {group.lines.map((line, index) =>
            line.levels ? (
              <LevelButton
                key={index}
                range={line.levels}
                alpha={line.kind === 'alpha'}
                level={level}
                onLevelChange={onLevelChange}
              />
            ) : null,
          )}
        </span>
      </li>
    );
  }

  return (
    <li className={styles.area} data-detailed="" data-locked={group.shinyLocked || undefined}>
      {head}
      <ul className={styles.lines}>
        {group.lines.map((line, index) => {
          const Icon = KIND_ICON[line.kind];
          return (
            <li key={index} className={styles.line} data-locked={line.shinyLocked || undefined}>
              <span className={styles.lineMain}>
                <span className={styles.kind} data-kind={line.kind}>
                  <Icon aria-hidden="true" />
                  {line.label}
                </span>
                {line.method ? <span className={styles.method}>{line.method}</span> : null}
                <Details conditions={line.conditions} versions={line.versions} />
                {line.rate !== null ? (
                  <span className={styles.rate} title="Encounter rate">
                    {formatRate(line.rate)}
                  </span>
                ) : null}
                {line.shinyLocked && !group.shinyLocked ? (
                  <Badge tone="danger" size="sm" icon={<Lock />}>
                    Shiny-locked
                  </Badge>
                ) : null}
              </span>
              {line.levels ? (
                <LevelButton
                  range={line.levels}
                  alpha={isAlphaLine(line)}
                  level={level}
                  onLevelChange={onLevelChange}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </li>
  );
}

function FixedItem({
  line,
  locksKnown,
  level,
  onLevelChange,
}: { line: EncounterLine; locksKnown: boolean } & LevelProps) {
  const Icon = KIND_ICON[line.kind];
  const title = line.method ?? line.location ?? line.label;
  const where = [
    title === line.label ? null : line.label,
    line.method !== null ? line.location : null,
  ].filter((part) => part !== null);
  const alpha = isAlphaLine(line);
  // The alpha level pill already says "Alpha".
  const conditions =
    alpha && line.levels ? line.conditions.filter((c) => c !== 'Alpha') : line.conditions;
  return (
    <li className={styles.area} data-fixed="" data-locked={line.shinyLocked || undefined}>
      <span className={styles.place}>
        <span className={styles.placeName}>
          {where.length === 0 ? <Icon aria-hidden="true" /> : null}
          {title}
        </span>
        {where.length > 0 ? (
          <span className={styles.where}>
            <Icon aria-hidden="true" />
            {where.join(' · ')}
          </span>
        ) : null}
        <Details conditions={conditions} versions={line.versions} />
        {line.shinyLocked ? (
          <Badge tone="danger" size="sm" icon={<Lock />}>
            Shiny-locked
          </Badge>
        ) : locksKnown ? (
          <Badge tone="shiny" size="sm" icon={<Sparkles />}>
            Can be shiny
          </Badge>
        ) : null}
      </span>
      <span className={styles.levels}>
        {line.levels ? (
          <LevelButton
            range={line.levels}
            alpha={alpha}
            level={level}
            onLevelChange={onLevelChange}
          />
        ) : null}
      </span>
    </li>
  );
}

// ───────────────────────────── Ready ─────────────────────────────

interface ContentProps extends GameEncountersProps {
  slice: GameEncounterSlice;
  origin: EncounterOrigin | null;
}

function EncounterContent({
  slice,
  origin,
  gameId,
  gameName,
  name,
  level,
  onLevelChange,
}: ContentProps) {
  const summary = useMemo(() => summarizeEncounters(slice), [slice]);
  const [filter, setFilter] = useState<EncounterFilterId | 'all'>('all');
  const [expanded, setExpanded] = useState(false);
  const [fixedExpanded, setFixedExpanded] = useState(false);

  const { groups, fixed } = useMemo(() => {
    if (filter === 'all') return { groups: summary.groups, fixed: summary.fixed };
    const lines = filterLines(summary.lines, filter);
    return { groups: groupByLocation(lines), fixed: fixedEncounters(lines) };
  }, [summary, filter]);

  // PKHeX data records every shiny lock; PokeAPI knows none, so only explicit locks are shown.
  const locksKnown = origin === 'bundled';
  const { wildLevels, alphaLevels, shinySource, dex, dlc } = summary;
  const expansionLabel = REGIONAL_DEX[gameId]?.[1];

  if (summary.presence === 'missing') {
    return (
      <Note tone="warn" icon={<Ban aria-hidden="true" />}>
        <strong>Not in {gameName}.</strong> {name} cannot be encountered or hunted there; anything
        shown below comes from another game.
      </Note>
    );
  }

  const facts = (
    <>
      {dex !== null ? (
        <Badge tone="info" size="sm">
          {dexBadge(gameId, dex, dlc)}
        </Badge>
      ) : null}
      {dlc && (dex === null || expansionLabel === undefined) ? (
        <Badge tone="violet" size="sm" title="Added by the game's DLC / expansion">
          DLC
        </Badge>
      ) : null}
      {wildLevels ? <Badge size="sm">Wild {formatRange(wildLevels)}</Badge> : null}
      {alphaLevels ? (
        <Badge tone="warn" size="sm" icon={<Crown />}>
          Alpha {formatRange(alphaLevels)}
        </Badge>
      ) : null}
    </>
  );

  if (summary.presence === 'empty') {
    return (
      <Frame name={name} gameName={gameName} state="empty" facts={facts} source={summary.source}>
        {summary.availabilityKnown ? (
          <Note tone="info" icon={<Sparkles aria-hidden="true" />}>
            {name} has no direct encounter in {gameName} — evolve it from an earlier stage, or breed
            or trade for it.
          </Note>
        ) : (
          <Note tone="neutral" icon={<MapPinOff aria-hidden="true" />}>
            No wild locations listed — {name} may only be obtainable by evolving, breeding or
            trading in {gameName}.
          </Note>
        )}
      </Frame>
    );
  }

  const visible = expanded ? groups : groups.slice(0, COLLAPSED_AREAS);
  const outOfRange =
    (wildLevels !== null || alphaLevels !== null) &&
    !containsLevel(wildLevels, level) &&
    !containsLevel(alphaLevels, level);
  const suggested = wildLevels ?? alphaLevels;

  return (
    <Frame name={name} gameName={gameName} state="ready" facts={facts} source={summary.source}>
      {shinySource === 'locked' ? (
        <Note tone="danger" icon={<Lock aria-hidden="true" />}>
          <strong>Shiny-locked in {gameName}.</strong> Every encounter with {name} here can never be
          shiny — it cannot be hunted in this game.
        </Note>
      ) : null}
      {shinySource === 'fixed' ? (
        <Note tone="info" icon={<Sparkles aria-hidden="true" />}>
          {locksKnown
            ? `${name} does not spawn in the wild, but the encounter below can be shiny — count each attempt as one encounter.`
            : `${name} does not spawn in the wild here. Gifts and static encounters can usually be reset for a shiny, but some are shiny-locked — check before you start.`}
        </Note>
      ) : null}
      {shinySource === 'wild' && summary.lockedFixed.length > 0 ? (
        <Note tone="warn" icon={<TriangleAlert aria-hidden="true" />}>
          {summary.lockedFixed.length === 1
            ? `The fixed ${name} encounter listed below (${summary.lockedFixed[0] ?? ''}) is shiny-locked.`
            : `The fixed ${name} encounters listed below (${summary.lockedFixed.join(', ')}) are shiny-locked.`}{' '}
          Hunt it in {huntWhere(summary.huntableKinds)} instead.
        </Note>
      ) : null}
      {outOfRange && suggested !== null ? (
        <Note tone="info" icon={<TriangleAlert aria-hidden="true" />}>
          Lv. {level} is outside the levels {name} appears at here (
          {[
            wildLevels && formatRange(wildLevels),
            alphaLevels && `alphas ${formatRange(alphaLevels)}`,
          ]
            .filter(Boolean)
            .join(', ')}
          ).{' '}
          <button
            type="button"
            className={styles.inline}
            onClick={() => onLevelChange(suggested.max)}
          >
            Analyse at Lv. {suggested.max}
          </button>
        </Note>
      ) : null}

      {summary.filters.length > 1 ? (
        <div className={styles.filters} role="group" aria-label="Show encounters by kind">
          <Chip
            size="sm"
            icon={<Layers />}
            selected={filter === 'all'}
            onClick={() => setFilter('all')}
          >
            All
          </Chip>
          {summary.filters.map((option) => {
            const Icon = FILTER_ICON[option.id];
            return (
              <Chip
                key={option.id}
                size="sm"
                icon={<Icon />}
                selected={filter === option.id}
                onClick={() => setFilter(option.id)}
              >
                {option.label} <span className={styles.count}>{option.count}</span>
              </Chip>
            );
          })}
        </div>
      ) : null}

      {groups.length > 0 ? (
        <>
          <ul className={styles.areas} aria-label="Locations">
            {visible.map((group) => (
              <LocationCard
                key={group.key}
                group={group}
                level={level}
                onLevelChange={onLevelChange}
              />
            ))}
          </ul>
          {groups.length > COLLAPSED_AREAS ? (
            <button
              type="button"
              className={styles.more}
              aria-expanded={expanded}
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? 'Show fewer locations' : `Show all ${groups.length} locations`}
            </button>
          ) : null}
        </>
      ) : null}

      {fixed.length > 0 ? (
        <>
          <ul
            className={styles.fixed}
            data-alone={groups.length === 0 || undefined}
            aria-label="Gifts, static encounters and trades"
          >
            {(fixedExpanded ? fixed : fixed.slice(0, COLLAPSED_AREAS)).map((line, index) => (
              <FixedItem
                key={index}
                line={line}
                locksKnown={locksKnown}
                level={level}
                onLevelChange={onLevelChange}
              />
            ))}
          </ul>
          {fixed.length > COLLAPSED_AREAS ? (
            <button
              type="button"
              className={styles.more}
              aria-expanded={fixedExpanded}
              onClick={() => setFixedExpanded((open) => !open)}
            >
              {fixedExpanded
                ? 'Show fewer fixed encounters'
                : `Show all ${fixed.length} gifts, static encounters and trades`}
            </button>
          ) : null}
        </>
      ) : null}
    </Frame>
  );
}

// ───────────────────────────── Panel ─────────────────────────────

/**
 * "Where is it, at what level, and can it even be shiny there?" — every
 * location of the analysed Pokémon in the selected game: bundled PKHeX data for
 * Brilliant Diamond / Shining Pearl, Legends: Arceus, Scarlet / Violet and
 * Legends: Z-A, PokeAPI for Gold / Silver through Sword / Shield.
 */
export function GameEncounters(props: GameEncountersProps) {
  const { gameId, gameName, pokemonId, name } = props;
  const state = useGameEncounters(gameId, pokemonId);

  if (state.status === 'ready' && state.slice !== null) {
    // Keyed so the filter and "show all" reset for another Pokémon or game.
    return (
      <EncounterContent
        key={`${gameId}:${pokemonId}`}
        {...props}
        slice={state.slice}
        origin={state.origin}
      />
    );
  }

  if (state.status === 'loading') {
    return (
      <Frame name={name} gameName={gameName} state="loading">
        <div className={styles.skeleton} aria-label="Loading locations">
          <div className={styles.skeletonFacts}>
            <Skeleton width={120} height={18} />
            <Skeleton width={96} height={18} />
          </div>
          <div className={styles.skeletonGrid}>
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} shape="block" height={46} />
            ))}
          </div>
        </div>
      </Frame>
    );
  }

  if (state.status === 'error') {
    return (
      <Frame name={name} gameName={gameName} state="error">
        <EmptyState
          size="sm"
          tone="danger"
          icon={<WifiOff />}
          title="Locations unavailable"
          description={
            state.origin === 'pokeapi'
              ? `${describePokeApiError(state.error)} Locations for ${gameName} come from PokeAPI and are cached once loaded.`
              : `The bundled location data for ${gameName} could not be loaded.`
          }
          action={
            <Button size="sm" leadingIcon={<RefreshCw />} onClick={state.retry}>
              Try again
            </Button>
          }
          className={styles.empty}
        />
      </Frame>
    );
  }

  return (
    <Frame name={name} gameName={gameName} state="unsupported">
      <Note tone="neutral" icon={<MapPinOff aria-hidden="true" />}>
        Location data isn’t available for {gameName}.
      </Note>
    </Frame>
  );
}
