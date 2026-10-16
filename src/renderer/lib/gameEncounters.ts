/**
 * Where a Pokémon is found in a game — every location, how it is met, at what
 * level, under which conditions and in which version — and, what matters most
 * to a shiny hunter, which of those encounters are shiny-locked.
 *
 * Two sources produce the same {@link GameEncounterSlice} (encounterSchema.ts):
 *   - bundled files `src/renderer/data/encounters/<gameId>.json`, extracted from
 *     PKHeX's game data by `scripts/build-*-data.mjs` for the games PokeAPI has
 *     no locations for. Each file is its own chunk, loaded on first use;
 *   - PokeAPI's `/pokemon/{id}/encounters` (`api/encounters.ts`) for the rest.
 *
 * {@link useGameEncounters} picks the source; the pure helpers below turn a
 * slice into what the locations panel renders.
 */
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { POKEAPI_ENCOUNTER_GAMES, usePokeApiEncounterSlice } from '@renderer/api/encounters';
import type {
  BundledEncounterFile,
  EncounterKind,
  EncounterRow,
  GameEncounterSlice,
} from '@renderer/data/encounterSchema';

// ───────────────────────────── Sources ─────────────────────────────

/** One lazily loaded chunk per bundled game; whatever files exist are picked up. */
const BUNDLED_FILES = import.meta.glob<BundledEncounterFile>('../data/encounters/*.json', {
  import: 'default',
});

const bundledLoaders = new Map(
  Object.entries(BUNDLED_FILES).map(([path, load]) => [
    /([^/\\]+)\.json$/.exec(path)?.[1] ?? path,
    load,
  ]),
);

/** Where a game's locations come from. */
export type EncounterOrigin = 'bundled' | 'pokeapi';

/** Biolume game ids with a bundled encounter file. */
export function bundledEncounterGames(): string[] {
  return [...bundledLoaders.keys()].sort();
}

/** The source of a game's locations; null when neither has any. Bundled data wins. */
export function encounterOrigin(gameId: string): EncounterOrigin | null {
  if (bundledLoaders.has(gameId)) return 'bundled';
  if (POKEAPI_ENCOUNTER_GAMES.has(gameId)) return 'pokeapi';
  return null;
}

/** Loads (once per query client) the bundled encounter file of a game. */
export async function loadBundledEncounters(gameId: string): Promise<BundledEncounterFile> {
  const load = bundledLoaders.get(gameId);
  if (load === undefined) throw new Error(`No bundled encounter data for "${gameId}"`);
  const file = await load();
  if (file.version !== 2) {
    throw new Error(`Unsupported encounter file version ${String(file.version)} for "${gameId}"`);
  }
  return file;
}

/** One Pokémon's part of a bundled file. Bundled files list every Pokémon in the game. */
export function sliceFromBundled(
  file: BundledEncounterFile,
  pokemonId: number,
): GameEncounterSlice {
  return {
    gameId: file.gameId,
    source: file.source,
    versions: file.versions,
    locations: file.locations,
    pokemon: file.pokemon[String(pokemonId)] ?? null,
    availabilityKnown: true,
  };
}

/** Query keys of the bundled files. Not under the PokeAPI root, so never persisted to disk. */
export const bundledEncounterKeys = {
  all: ['bundled-encounters'] as const,
  game: (gameId: string) => ['bundled-encounters', gameId] as const,
};

export type GameEncountersStatus = 'loading' | 'ready' | 'error' | 'unsupported';

export interface GameEncountersState {
  /** `unsupported`: no location data exists for the game (or no Pokémon was given). */
  status: GameEncountersStatus;
  origin: EncounterOrigin | null;
  /** Set exactly when `status` is `ready`. */
  slice: GameEncounterSlice | null;
  /** Why loading failed; null unless `status` is `error`. */
  error: unknown;
  /** Loads again after an error. */
  retry: () => void;
}

/**
 * Every encounter of a Pokémon (PokeAPI `pokemon` id) in a Biolume game, from
 * the bundled file when one exists, otherwise from PokeAPI. Must render inside
 * a QueryClientProvider (the app's PokeApiProvider).
 */
export function useGameEncounters(gameId: string, pokemonId: number | null): GameEncountersState {
  const origin = encounterOrigin(gameId);
  const usable = pokemonId !== null && Number.isInteger(pokemonId) && pokemonId > 0;

  const bundled = useQuery({
    queryKey: bundledEncounterKeys.game(gameId),
    queryFn: () => loadBundledEncounters(gameId),
    enabled: origin === 'bundled',
    // A file inside the app: it never goes stale, needs no network and is too big to diff.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    networkMode: 'always',
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    structuralSharing: false,
  });
  const pokeApi = usePokeApiEncounterSlice(
    gameId,
    origin === 'pokeapi' && usable ? pokemonId : null,
  );

  const file = bundled.data;
  const bundledSlice = useMemo(
    () => (file !== undefined && usable ? sliceFromBundled(file, pokemonId) : null),
    [file, usable, pokemonId],
  );

  const { refetch: refetchBundled } = bundled;
  const { refetch: refetchPokeApi } = pokeApi;
  const retry = useCallback(() => {
    if (origin === 'bundled') void refetchBundled();
    else if (origin === 'pokeapi') void refetchPokeApi();
  }, [origin, refetchBundled, refetchPokeApi]);

  if (origin === null || !usable) {
    return { status: 'unsupported', origin, slice: null, error: null, retry };
  }
  const slice = origin === 'bundled' ? bundledSlice : (pokeApi.data ?? null);
  if (slice !== null) return { status: 'ready', origin, slice, error: null, retry };
  const failed = origin === 'bundled' ? bundled.isError : pokeApi.isError;
  if (failed) {
    const error: unknown = origin === 'bundled' ? bundled.error : pokeApi.error;
    return { status: 'error', origin, slice: null, error, retry };
  }
  return { status: 'loading', origin, slice: null, error: null, retry };
}

// ───────────────────────────── Kinds & filters ─────────────────────────────

/** Display order of encounter kinds. */
export const KIND_ORDER: readonly EncounterKind[] = [
  'wild',
  'surf',
  'fishing',
  'interact',
  'special',
  'outbreak',
  'alpha',
  'den',
  'raid',
  'static',
  'gift',
  'trade',
];

export const KIND_LABEL: Record<EncounterKind, string> = {
  wild: 'Wild',
  surf: 'Surfing',
  fishing: 'Fishing',
  interact: 'Interaction',
  special: 'Special',
  outbreak: 'Outbreak',
  alpha: 'Alpha',
  den: 'Den',
  raid: 'Raid',
  static: 'Static encounter',
  gift: 'Gift',
  trade: 'In-game trade',
};

/** One-off encounters, listed apart from the location cards. */
const FIXED_KINDS: ReadonlySet<EncounterKind> = new Set<EncounterKind>(['static', 'gift', 'trade']);

/** Random wild battles; their levels make up the "wild" level span. */
const WILD_KINDS: ReadonlySet<EncounterKind> = new Set<EncounterKind>([
  'wild',
  'surf',
  'fishing',
  'interact',
  'special',
  'outbreak',
  'den',
]);

export function isFixedKind(kind: EncounterKind): boolean {
  return FIXED_KINDS.has(kind);
}

/** The filter chips of the panel. */
export type EncounterFilterId =
  | 'wild'
  | 'water'
  | 'fishing'
  | 'interact'
  | 'special'
  | 'outbreak'
  | 'alpha'
  | 'den'
  | 'raid'
  | 'fixed';

export const FILTER_OF_KIND: Record<EncounterKind, EncounterFilterId> = {
  wild: 'wild',
  surf: 'water',
  fishing: 'fishing',
  interact: 'interact',
  special: 'special',
  outbreak: 'outbreak',
  alpha: 'alpha',
  den: 'den',
  raid: 'raid',
  static: 'fixed',
  gift: 'fixed',
  trade: 'fixed',
};

export const FILTER_ORDER: readonly EncounterFilterId[] = [
  'wild',
  'water',
  'fishing',
  'interact',
  'special',
  'outbreak',
  'alpha',
  'den',
  'raid',
  'fixed',
];

export const FILTER_LABEL: Record<EncounterFilterId, string> = {
  wild: 'Wild',
  water: 'Water',
  fishing: 'Fishing',
  interact: 'Interactions',
  special: 'Special',
  outbreak: 'Outbreaks',
  alpha: 'Alphas',
  den: 'Dens',
  raid: 'Raids',
  fixed: 'Static & gifts',
};

// ───────────────────────────── Small helpers ─────────────────────────────

export interface LevelRange {
  min: number;
  max: number;
}

export function widen(range: LevelRange | null, other: LevelRange | null): LevelRange | null {
  if (other === null) return range;
  if (range === null) return { ...other };
  return { min: Math.min(range.min, other.min), max: Math.max(range.max, other.max) };
}

export function containsLevel(range: LevelRange | null, level: number): boolean {
  return range !== null && level >= range.min && level <= range.max;
}

/** A row's level range; null when the source does not know it. */
export function rowLevels(row: Pick<EncounterRow, 'n' | 'x'>): LevelRange | null {
  const min = Math.min(row.n, row.x);
  const max = Math.max(row.n, row.x);
  if (!Number.isFinite(max) || max <= 0) return null;
  return { min: Math.max(1, min), max };
}

/**
 * Names of the versions a row is limited to. Empty when the mask is absent,
 * when the row is in every version, or when the game has a single version.
 */
export function versionLabels(mask: number | undefined, versions: readonly string[]): string[] {
  if (mask === undefined || versions.length <= 1) return [];
  const every = 2 ** versions.length - 1;
  if ((mask & every) === every) return [];
  return versions.filter((_, index) => (mask & (1 << index)) !== 0);
}

/** Stable styling hook for a version name: `Let's Go, Pikachu!` → `lets-go-pikachu`. */
export function versionSlug(version: string): string {
  return version
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/^pokemon\s+/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Conditions that mean "needs the DLC / expansion" — those locations are listed last. */
const LATE_CONDITION = /mega dimension|isle of armor|crown tundra|teal mask|indigo disk|\bdlc\b/i;

/** Whether a condition names the game's DLC / expansion (`Mega Dimension`, `The Teal Mask` …). */
export function isExpansionCondition(condition: string): boolean {
  return LATE_CONDITION.test(condition);
}

/** `30%`, `4.5%`, `0.25%`. */
export function formatRate(rate: number): string {
  const digits = rate >= 10 ? 0 : rate >= 1 ? 1 : 2;
  return `${Number(rate.toFixed(digits))}%`;
}

// ───────────────────────────── Shaping a slice ─────────────────────────────

/** One encounter, ready to render. */
export interface EncounterLine {
  kind: EncounterKind;
  filter: EncounterFilterId;
  /** Kind label, e.g. `Fishing`. */
  label: string;
  /** Method detail, e.g. `Old Rod`; null when there is none. */
  method: string | null;
  /** Location name; null when unknown. */
  location: string | null;
  /** Conditions not already shown on the location they are grouped under. */
  conditions: string[];
  /** Versions it is exclusive to; empty when in every version. */
  versions: string[];
  /** Encounter rate in percent; null when unknown. */
  rate: number | null;
  levels: LevelRange | null;
  shinyLocked: boolean;
  /** Version mask as stored, for merging identical lines. */
  mask: number | null;
}

/** Every non-fixed encounter at one location (same-named location ids are merged). */
export interface LocationGroup {
  key: string;
  name: string;
  /** False for rows without a location (shown as "Various locations"). */
  known: boolean;
  lines: EncounterLine[];
  /** Conditions shared by every line, shown once next to the name. */
  shared: string[];
  /** Every line is shiny-locked. */
  shinyLocked: boolean;
  /** Only plain wild / alpha lines: rendered as level pills beside the name. */
  compact: boolean;
  /** Every line needs the game's DLC / expansion. */
  late: boolean;
  /** Lowest level met here; null when no level is known. */
  minLevel: number | null;
}

/**
 * How a shiny can be obtained directly:
 * - `wild`   — it appears in the wild (or in raids, outbreaks …) and can be shiny there;
 * - `fixed`  — only through a gift / static encounter / trade that can be shiny (re-roll it);
 * - `locked` — every direct encounter is shiny-locked;
 * - `none`   — no direct encounter at all (evolve, breed or trade for it).
 */
export type ShinySource = 'wild' | 'fixed' | 'locked' | 'none';

/**
 * - `missing` — the bundled data says the Pokémon is not in the game;
 * - `empty`   — no encounter is listed (in the game but not met directly, or —
 *               for PokeAPI, which only lists locations — unknown);
 * - `listed`  — at least one encounter.
 */
export type EncounterPresence = 'missing' | 'empty' | 'listed';

export interface FilterOption {
  id: EncounterFilterId;
  label: string;
  /** Locations (or fixed encounters, for `fixed`) the filter shows. */
  count: number;
}

export interface EncounterSummary {
  presence: EncounterPresence;
  availabilityKnown: boolean;
  /** Regional Pokédex number; null when there is none. */
  dex: number | null;
  /** Belongs to the game's DLC / expansion. */
  dlc: boolean;
  lines: EncounterLine[];
  /** Non-fixed encounters by location, base game first, then by level. */
  groups: LocationGroup[];
  /** Gifts, statics and trades. */
  fixed: EncounterLine[];
  /** Kinds present, in {@link KIND_ORDER}. */
  kinds: EncounterKind[];
  /** Filters present, in {@link FILTER_ORDER}. */
  filters: FilterOption[];
  /** Span of random wild battles (walking, surfing, fishing, outbreaks …). */
  wildLevels: LevelRange | null;
  alphaLevels: LevelRange | null;
  shinySource: ShinySource;
  /** Labels of the shiny-locked fixed encounters, de-duplicated. */
  lockedFixed: string[];
  /** Kinds of the non-fixed encounters that can be shiny, in {@link KIND_ORDER}. */
  huntableKinds: EncounterKind[];
  source: string;
}

const kindRank = (kind: EncounterKind): number => KIND_ORDER.indexOf(kind);

/** Turns every row of a slice into a line (without grouping). */
export function buildLines(slice: GameEncounterSlice): EncounterLine[] {
  const rows = slice.pokemon?.rows ?? [];
  return rows.map((row): EncounterLine => {
    const name = row.l === 0 ? null : (slice.locations[String(row.l)] ?? `Location ${row.l}`);
    const label = KIND_LABEL[row.k];
    const method = row.m?.trim() ?? '';
    return {
      kind: row.k,
      filter: FILTER_OF_KIND[row.k],
      label,
      // "Surfing · Surfing" says nothing twice.
      method: method === '' || method.toLowerCase() === label.toLowerCase() ? null : method,
      location: name,
      conditions: [...new Set(row.c ?? [])],
      versions: versionLabels(row.v, slice.versions),
      rate: row.r ?? null,
      levels: rowLevels(row),
      shinyLocked: row.s === 1,
      mask: row.v ?? null,
    };
  });
}

/** Identity of a line apart from its levels. */
const lineKey = (line: EncounterLine): string =>
  JSON.stringify([
    line.kind,
    line.method,
    line.conditions,
    line.mask,
    line.rate,
    line.shinyLocked,
    line.levels === null,
  ]);

/** Merges lines that differ only in level (same-named locations, cosmetic forms). */
function mergeLines(lines: readonly EncounterLine[]): EncounterLine[] {
  const merged = new Map<string, EncounterLine>();
  for (const line of lines) {
    const key = lineKey(line);
    const existing = merged.get(key);
    if (existing === undefined) merged.set(key, { ...line, conditions: [...line.conditions] });
    else existing.levels = widen(existing.levels, line.levels);
  }
  // Stable: source order within a kind (Old Rod before Good Rod, Morning before Night).
  return [...merged.values()].sort((a, b) => kindRank(a.kind) - kindRank(b.kind));
}

const isPlain = (line: EncounterLine): boolean =>
  (line.kind === 'wild' || line.kind === 'alpha') &&
  line.method === null &&
  line.versions.length === 0 &&
  line.rate === null &&
  line.conditions.length === 0 &&
  line.levels !== null;

/** Groups non-fixed lines by location name and sorts the groups. */
export function groupByLocation(lines: readonly EncounterLine[]): LocationGroup[] {
  const byName = new Map<string, EncounterLine[]>();
  for (const line of lines) {
    if (isFixedKind(line.kind)) continue;
    const key = line.location ?? '';
    const list = byName.get(key);
    if (list === undefined) byName.set(key, [line]);
    else list.push(line);
  }

  const groups = [...byName.entries()].map(([key, raw]): LocationGroup => {
    const merged = mergeLines(raw);
    const shinyLocked = merged.every((line) => line.shinyLocked);
    const lift = (shared: readonly string[]) =>
      merged.map((line) => ({
        ...line,
        conditions: line.conditions.filter((condition) => !shared.includes(condition)),
      }));
    const isCompact = (lines: readonly EncounterLine[]) =>
      lines.every((line) => isPlain(line) && (shinyLocked || !line.shinyLocked));

    let shared = (merged[0]?.conditions ?? []).filter((condition) =>
      merged.every((line) => line.conditions.includes(condition)),
    );
    let own = lift(shared);
    // A lone encounter keeps its conditions, unless lifting them turns the card into level pills.
    if (merged.length === 1 && shared.length > 0 && !isCompact(own)) {
      shared = [];
      own = lift(shared);
    }
    const levels = own.reduce<LevelRange | null>((span, line) => widen(span, line.levels), null);
    return {
      key: key === '' ? '~unknown' : key,
      name: key === '' ? 'Various locations' : key,
      known: key !== '',
      lines: own,
      shared,
      shinyLocked,
      compact: isCompact(own),
      late: merged.every((line) => line.conditions.some(isExpansionCondition)),
      minLevel: levels?.min ?? null,
    };
  });

  return groups.sort(
    (a, b) =>
      Number(a.late) - Number(b.late) ||
      Number(!a.known) - Number(!b.known) ||
      (a.minLevel ?? Number.POSITIVE_INFINITY) - (b.minLevel ?? Number.POSITIVE_INFINITY) ||
      // Numeric: "Bell Tower — 2F" before "Bell Tower — 10F".
      a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
}

/** Gifts, statics and trades, merged where they differ only in level. */
export function fixedEncounters(lines: readonly EncounterLine[]): EncounterLine[] {
  const fixed = lines.filter((line) => isFixedKind(line.kind));
  const merged = new Map<string, EncounterLine>();
  for (const line of fixed) {
    const key = `${lineKey(line)}|${line.location ?? ''}|${line.levels?.min ?? ''}`;
    if (!merged.has(key)) merged.set(key, line);
  }
  return [...merged.values()].sort((a, b) => kindRank(a.kind) - kindRank(b.kind));
}

/** Whether, and how, a shiny can be obtained from these encounters. */
export function shinySourceOf(
  lines: readonly Pick<EncounterLine, 'kind' | 'shinyLocked'>[],
): ShinySource {
  if (lines.some((line) => !isFixedKind(line.kind) && !line.shinyLocked)) return 'wild';
  if (lines.some((line) => isFixedKind(line.kind) && !line.shinyLocked)) return 'fixed';
  return lines.length > 0 ? 'locked' : 'none';
}

/** Label of a fixed encounter: its method (`Z-A Starters`) or its kind. */
export function fixedLabel(line: Pick<EncounterLine, 'method' | 'label'>): string {
  return line.method ?? line.label;
}

/** Keeps the lines a filter selects (`all` keeps everything). */
export function filterLines(
  lines: readonly EncounterLine[],
  filter: EncounterFilterId | 'all',
): EncounterLine[] {
  return filter === 'all' ? [...lines] : lines.filter((line) => line.filter === filter);
}

/** Everything the locations panel shows for one slice. */
export function summarizeEncounters(slice: GameEncounterSlice): EncounterSummary {
  const lines = buildLines(slice);
  const groups = groupByLocation(lines);
  const fixed = fixedEncounters(lines);

  let wildLevels: LevelRange | null = null;
  let alphaLevels: LevelRange | null = null;
  for (const line of lines) {
    if (line.kind === 'alpha') alphaLevels = widen(alphaLevels, line.levels);
    else if (WILD_KINDS.has(line.kind)) wildLevels = widen(wildLevels, line.levels);
  }

  const kinds = KIND_ORDER.filter((kind) => lines.some((line) => line.kind === kind));
  const filters = FILTER_ORDER.flatMap((id): FilterOption[] => {
    const count =
      id === 'fixed'
        ? fixed.length
        : groups.filter((group) => group.lines.some((line) => line.filter === id)).length;
    return count > 0 ? [{ id, label: FILTER_LABEL[id], count }] : [];
  });

  const presence: EncounterPresence =
    slice.pokemon === null && slice.availabilityKnown
      ? 'missing'
      : lines.length === 0
        ? 'empty'
        : 'listed';
  const dex = slice.pokemon?.dex;

  return {
    presence,
    availabilityKnown: slice.availabilityKnown,
    dex: typeof dex === 'number' && dex > 0 ? dex : null,
    dlc: slice.pokemon?.dlc === 1,
    lines,
    groups,
    fixed,
    kinds,
    filters,
    wildLevels,
    alphaLevels,
    shinySource: shinySourceOf(lines),
    lockedFixed: [...new Set(fixed.filter((line) => line.shinyLocked).map(fixedLabel))],
    huntableKinds: KIND_ORDER.filter((kind) =>
      lines.some((line) => line.kind === kind && !isFixedKind(kind) && !line.shinyLocked),
    ),
    source: slice.source,
  };
}
