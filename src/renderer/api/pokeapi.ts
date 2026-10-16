/**
 * PokeAPI client.
 *
 * Raw PokeAPI payloads are large (a single `/pokemon` response can be several
 * hundred kB), so every fetcher validates the response and trims it to the
 * {@link PokemonDetail} / {@link SpeciesDetail} shapes *before* returning —
 * nothing downstream (TanStack Query, the IndexedDB cache) ever sees a raw
 * payload. Bump `DATA_VERSION` in `queryClient.ts` whenever these shapes change.
 *
 * Network behaviour: a per-attempt timeout, retries with exponential backoff
 * on network errors / 5xx / 429 (never on 404), typed {@link PokeApiError}s and
 * support for the caller's `AbortSignal`.
 */
import { z } from 'zod';
import { displayName, findBySlug, getSpecies } from '@renderer/lib/species';

export const POKEAPI_BASE_URL = 'https://pokeapi.co/api/v2';

// ───────────────────────────── Trimmed shapes ─────────────────────────────

export interface PokemonStats {
  hp: number;
  atk: number;
  def: number;
  spa: number;
  spd: number;
  spe: number;
  /** Base stat total. */
  total: number;
}

export interface PokemonAbility {
  slug: string;
  /** English display name derived from the slug, e.g. `Snow Cloak`. */
  name: string;
  hidden: boolean;
}

/** Sprite URLs reported by PokeAPI; null where a set does not exist for this Pokémon. */
export interface PokemonSprites {
  pixel: string | null;
  pixelShiny: string | null;
  home: string | null;
  homeShiny: string | null;
  artwork: string | null;
  artworkShiny: string | null;
}

export interface LevelUpMove {
  /** PokeAPI move slug. */
  slug: string;
  /** Level the move is learned at; 0 marks a move learned on evolution. */
  level: number;
}

/** What a Pokémon can learn in one version group. */
export interface VersionGroupMoves {
  /**
   * Level-up learnset in the order the game stores it: by level, then by
   * PokeAPI's `order` within a level (entries without one first — see
   * `trimPokemon`). A move may appear more than once.
   */
  levelUp: LevelUpMove[];
  /** Move slugs learnable by other means, de-duplicated. */
  other: { machine: string[]; egg: string[]; tutor: string[] };
}

export interface PokemonDetail {
  /** PokeAPI `pokemon` id. */
  id: number;
  /** PokeAPI `pokemon` slug, e.g. `vulpix-alola`. */
  slug: string;
  /** National Pokédex number. */
  speciesId: number;
  /** English display name, e.g. `Alolan Vulpix`. */
  name: string;
  /** Type slugs in slot order. */
  types: string[];
  stats: PokemonStats;
  /** In slot order; the hidden ability, if any, comes last. */
  abilities: PokemonAbility[];
  /** Metres. */
  height: number;
  /** Kilograms. */
  weight: number;
  sprites: PokemonSprites;
  /** Movepool keyed by PokeAPI version-group slug, e.g. `scarlet-violet`. */
  moves: Record<string, VersionGroupMoves>;
}

export interface SpeciesVariety {
  pokemonId: number;
  slug: string;
  isDefault: boolean;
}

export interface SpeciesDetail {
  /** National Pokédex number. */
  id: number;
  slug: string;
  name: string;
  /** Generation the species debuted in. */
  generation: number;
  /** 3 (hardest) – 255 (easiest); null when PokeAPI has no value. */
  captureRate: number | null;
  /** Chance of being female in eighths (0–8); -1 for genderless species. */
  genderRate: number;
  baseHappiness: number | null;
  /** Growth-rate slug, e.g. `medium-slow`. */
  growthRate: string | null;
  /** Egg-group slugs, e.g. `['ground']`; `['no-eggs']` cannot breed. */
  eggGroups: string[];
  /** Egg cycles; null when PokeAPI has no value. */
  hatchCounter: number | null;
  isLegendary: boolean;
  isMythical: boolean;
  isBaby: boolean;
  /** Whether males and females look different (matters when judging a shiny). */
  hasGenderDifferences: boolean;
  /** e.g. `Fox Pokémon`. */
  genus: string | null;
  /** Most recent English Pokédex entry, whitespace-normalised. */
  flavorText: string | null;
  /** Version slug the entry comes from, e.g. `legends-arceus`. */
  flavorTextVersion: string | null;
  varieties: SpeciesVariety[];
}

// ───────────────────────────── Errors ─────────────────────────────

/**
 * - `offline`          — the request never reached PokeAPI (no connection, DNS, CORS, …), or
 *                        the connection dropped while the response was still arriving
 * - `timeout`          — no complete response within the time limit
 * - `not-found`        — 404, or an identifier that cannot exist
 * - `rate-limited`     — 429
 * - `server`           — 5xx
 * - `http`             — any other non-2xx status
 * - `invalid-response` — a 2xx response whose body was not the expected JSON
 */
export type PokeApiErrorKind =
  'offline' | 'timeout' | 'not-found' | 'rate-limited' | 'server' | 'http' | 'invalid-response';

const RETRYABLE_KINDS: ReadonlySet<PokeApiErrorKind> = new Set([
  'offline',
  'timeout',
  'rate-limited',
  'server',
]);

export class PokeApiError extends Error {
  readonly kind: PokeApiErrorKind;
  /** HTTP status when the server answered; null otherwise. */
  readonly status: number | null;
  readonly url: string;
  /** Server-requested wait before retrying (from `Retry-After`), in ms. */
  readonly retryAfterMs: number | null;

  constructor(
    kind: PokeApiErrorKind,
    message: string,
    details: { url: string; status?: number | null; retryAfterMs?: number | null; cause?: unknown },
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'PokeApiError';
    this.kind = kind;
    this.status = details.status ?? null;
    this.url = details.url;
    this.retryAfterMs = details.retryAfterMs ?? null;
  }

  /** Whether trying again later could succeed without changing the request. */
  get retryable(): boolean {
    return RETRYABLE_KINDS.has(this.kind);
  }
}

export function isPokeApiError(error: unknown): error is PokeApiError {
  return error instanceof PokeApiError;
}

/** One-line, user-facing explanation of a failed request. */
export function describePokeApiError(error: unknown): string {
  if (!isPokeApiError(error)) return 'Something went wrong while loading Pokémon data.';
  switch (error.kind) {
    case 'offline':
      return 'PokeAPI is unreachable — check your connection. Bundled data is still available.';
    case 'timeout':
      return 'PokeAPI took too long to respond.';
    case 'not-found':
      return 'PokeAPI has no data for this Pokémon.';
    case 'rate-limited':
      return 'PokeAPI is rate-limiting requests — try again in a moment.';
    case 'server':
      return 'PokeAPI is having server trouble — try again later.';
    case 'http':
    case 'invalid-response':
      return 'PokeAPI returned an unexpected response.';
  }
}

// ───────────────────────────── Raw payload schemas ─────────────────────────────
// Only the fields the app reads are declared; zod strips everything else.

const namedResource = z.object({ name: z.string().min(1), url: z.string().nullish() });
const spriteUrl = z.string().nullish();
const spritePair = z.object({ front_default: spriteUrl, front_shiny: spriteUrl }).nullish();

const rawPokemonSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  height: z.number().nullish(),
  weight: z.number().nullish(),
  species: namedResource,
  types: z.array(z.object({ slot: z.number(), type: namedResource })),
  stats: z.array(z.object({ base_stat: z.number(), stat: namedResource })),
  abilities: z
    .array(
      z.object({
        is_hidden: z.boolean().nullish(),
        slot: z.number().nullish(),
        ability: namedResource.nullish(),
      }),
    )
    .nullish(),
  sprites: z
    .object({
      front_default: spriteUrl,
      front_shiny: spriteUrl,
      other: z.object({ home: spritePair, 'official-artwork': spritePair }).nullish(),
    })
    .nullish(),
  moves: z
    .array(
      z.object({
        move: namedResource,
        version_group_details: z.array(
          z.object({
            level_learned_at: z.number().nullish(),
            order: z.number().nullish(),
            move_learn_method: namedResource,
            version_group: namedResource,
          }),
        ),
      }),
    )
    .nullish(),
});

const language = z.object({ name: z.string() });

const rawSpeciesSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  capture_rate: z.number().nullish(),
  gender_rate: z.number().nullish(),
  base_happiness: z.number().nullish(),
  hatch_counter: z.number().nullish(),
  is_legendary: z.boolean().nullish(),
  is_mythical: z.boolean().nullish(),
  is_baby: z.boolean().nullish(),
  has_gender_differences: z.boolean().nullish(),
  growth_rate: namedResource.nullish(),
  generation: namedResource.nullish(),
  egg_groups: z.array(namedResource).nullish(),
  names: z.array(z.object({ name: z.string(), language })).nullish(),
  genera: z.array(z.object({ genus: z.string(), language })).nullish(),
  flavor_text_entries: z
    .array(z.object({ flavor_text: z.string(), language, version: namedResource.nullish() }))
    .nullish(),
  varieties: z
    .array(z.object({ is_default: z.boolean().nullish(), pokemon: namedResource }))
    .nullish(),
});

// ───────────────────────────── Trimming ─────────────────────────────

const STAT_KEYS: Record<string, Exclude<keyof PokemonStats, 'total'>> = {
  hp: 'hp',
  attack: 'atk',
  defense: 'def',
  'special-attack': 'spa',
  'special-defense': 'spd',
  speed: 'spe',
};

/** Learn methods kept in {@link VersionGroupMoves.other}; anything else (events, purification, …) is dropped. */
const OTHER_METHODS = ['machine', 'egg', 'tutor'] as const;
type OtherMethod = (typeof OTHER_METHODS)[number];

function isOtherMethod(method: string): method is OtherMethod {
  return (OTHER_METHODS as readonly string[]).includes(method);
}

const LOWERCASE_WORDS = new Set(['of', 'the', 'and', 'in', 'as']);
/**
 * Ability slugs whose name is not simply the slug in title case. Checked
 * against PokeAPI's English names for every main-series ability; the two
 * "As One" variants are told apart on purpose.
 */
const ABILITY_NAMES: Record<string, string> = {
  'soul-heart': 'Soul-Heart',
  'well-baked-body': 'Well-Baked Body',
  'rks-system': 'RKS System',
  'dragons-maw': "Dragon's Maw",
  'minds-eye': "Mind's Eye",
  'zero-to-hero': 'Zero to Hero',
  'as-one-glastrier': 'As One (Glastrier)',
  'as-one-spectrier': 'As One (Spectrier)',
};

/** `snow-cloak` → `Snow Cloak`, `power-of-alchemy` → `Power of Alchemy`. */
export function titleCaseSlug(slug: string): string {
  return slug
    .split('-')
    .filter((word) => word !== '')
    .map((word, index) =>
      index > 0 && LOWERCASE_WORDS.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ');
}

function abilityName(slug: string): string {
  // `hasOwn` keeps inherited keys such as "constructor" from reading as names.
  return Object.hasOwn(ABILITY_NAMES, slug)
    ? (ABILITY_NAMES[slug] ?? titleCaseSlug(slug))
    : titleCaseSlug(slug);
}

/** Trailing numeric id of a PokeAPI resource URL: `…/pokemon-species/37/` → 37. */
function idFromUrl(url: string | null | undefined): number | null {
  if (!url) return null;
  const match = /\/(\d+)\/?$/.exec(url);
  if (!match?.[1]) return null;
  const id = Number.parseInt(match[1], 10);
  return id > 0 ? id : null;
}

function httpsOrNull(url: string | null | undefined): string | null {
  return typeof url === 'string' && url.startsWith('https://') ? url : null;
}

const ROMAN: Record<string, number> = { i: 1, v: 5, x: 10 };

/** `generation-ix` → 9. */
function generationFromSlug(slug: string | undefined): number | null {
  const numeral = slug?.startsWith('generation-') ? slug.slice('generation-'.length) : '';
  if (numeral === '') return null;
  let total = 0;
  for (let index = 0; index < numeral.length; index += 1) {
    const value = ROMAN[numeral.charAt(index)];
    if (value === undefined) return null;
    const next = ROMAN[numeral.charAt(index + 1)] ?? 0;
    total += value < next ? -value : value;
  }
  return total > 0 ? total : null;
}

function invalidResponse(url: string, issues: z.core.$ZodIssue[]): PokeApiError {
  const first = issues[0];
  const where = first && first.path.length > 0 ? ` at ${first.path.join('.')}` : '';
  return new PokeApiError(
    'invalid-response',
    `Unexpected PokeAPI response${where}${first ? `: ${first.message}` : ''}`,
    { url },
  );
}

interface LevelUpDraft extends LevelUpMove {
  order: number | null;
  index: number;
}

/**
 * Reduces a raw `/pokemon/{id}` payload to a {@link PokemonDetail}.
 * @throws PokeApiError (`invalid-response`) when the payload is not a Pokémon.
 */
export function trimPokemon(raw: unknown, url = `${POKEAPI_BASE_URL}/pokemon`): PokemonDetail {
  const parsed = rawPokemonSchema.safeParse(raw);
  if (!parsed.success) throw invalidResponse(url, parsed.error.issues);
  const data = parsed.data;

  const speciesId =
    idFromUrl(data.species.url) ?? findBySlug(data.species.name)?.species.id ?? null;
  if (speciesId === null) {
    throw new PokeApiError('invalid-response', `Cannot tell which species "${data.name}" is`, {
      url,
    });
  }

  const stats: PokemonStats = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0, total: 0 };
  for (const entry of data.stats) {
    const key = Object.hasOwn(STAT_KEYS, entry.stat.name) ? STAT_KEYS[entry.stat.name] : undefined;
    if (key) stats[key] = entry.base_stat;
  }
  stats.total = stats.hp + stats.atk + stats.def + stats.spa + stats.spd + stats.spe;

  const abilities: PokemonAbility[] = [];
  for (const entry of [...(data.abilities ?? [])].sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))) {
    if (!entry.ability) continue;
    abilities.push({
      slug: entry.ability.name,
      name: abilityName(entry.ability.name),
      hidden: entry.is_hidden ?? false,
    });
  }

  const drafts = new Map<
    string,
    { levelUp: LevelUpDraft[]; other: Record<OtherMethod, Set<string>> }
  >();
  for (const [index, entry] of (data.moves ?? []).entries()) {
    const slug = entry.move.name;
    for (const detail of entry.version_group_details) {
      let group = drafts.get(detail.version_group.name);
      if (!group) {
        group = { levelUp: [], other: { machine: new Set(), egg: new Set(), tutor: new Set() } };
        drafts.set(detail.version_group.name, group);
      }
      const method = detail.move_learn_method.name;
      if (method === 'level-up') {
        const level = Math.max(0, Math.trunc(detail.level_learned_at ?? 0));
        if (!group.levelUp.some((move) => move.slug === slug && move.level === level)) {
          group.levelUp.push({ slug, level, order: detail.order ?? null, index });
        }
      } else if (isOtherMethod(method)) {
        group.other[method].add(slug);
      }
    }
  }

  const moves: Record<string, VersionGroupMoves> = {};
  for (const versionGroup of [...drafts.keys()].sort()) {
    const group = drafts.get(versionGroup);
    if (!group) continue;
    // A group in which nothing was kept (e.g. one that only has "train" entries) is not a movepool.
    const { machine, egg, tutor } = group.other;
    if (group.levelUp.length + machine.size + egg.size + tutor.size === 0) continue;
    group.levelUp.sort(
      (a, b) =>
        a.level - b.level ||
        // `order` is the in-game position within a level. Where PokeAPI numbers only part of a
        // same-level group (Gen 2–3 data), the unnumbered move is the one learned FIRST — Emerald
        // Hitmonchan at Lv. 26: Thunder Punch (no order), Ice Punch (3), Fire Punch (4), learned
        // in exactly that order — so a missing order sorts before any number. Groups with no
        // order at all keep the payload order.
        (a.order ?? Number.MIN_SAFE_INTEGER) - (b.order ?? Number.MIN_SAFE_INTEGER) ||
        a.index - b.index,
    );
    moves[versionGroup] = {
      levelUp: group.levelUp.map(({ slug, level }) => ({ slug, level })),
      other: {
        machine: [...group.other.machine],
        egg: [...group.other.egg],
        tutor: [...group.other.tutor],
      },
    };
  }

  return {
    id: data.id,
    slug: data.name,
    speciesId,
    name: displayName(data.id) ?? titleCaseSlug(data.name),
    types: [...data.types].sort((a, b) => a.slot - b.slot).map((entry) => entry.type.name),
    stats,
    abilities,
    // PokeAPI reports decimetres and hectograms.
    height: (data.height ?? 0) / 10,
    weight: (data.weight ?? 0) / 10,
    sprites: {
      pixel: httpsOrNull(data.sprites?.front_default),
      pixelShiny: httpsOrNull(data.sprites?.front_shiny),
      home: httpsOrNull(data.sprites?.other?.home?.front_default),
      homeShiny: httpsOrNull(data.sprites?.other?.home?.front_shiny),
      artwork: httpsOrNull(data.sprites?.other?.['official-artwork']?.front_default),
      artworkShiny: httpsOrNull(data.sprites?.other?.['official-artwork']?.front_shiny),
    },
    moves,
  };
}

/** Pokédex entries use hard line breaks, form feeds and soft hyphens from the games' text boxes. */
function cleanFlavorText(text: string): string {
  return text
    .replace(/\u00ad[\n\f\r]?/g, '')
    .replace(/[\n\f\r]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Reduces a raw `/pokemon-species/{id}` payload to a {@link SpeciesDetail}.
 * @throws PokeApiError (`invalid-response`) when the payload is not a species.
 */
export function trimSpecies(
  raw: unknown,
  url = `${POKEAPI_BASE_URL}/pokemon-species`,
): SpeciesDetail {
  const parsed = rawSpeciesSchema.safeParse(raw);
  if (!parsed.success) throw invalidResponse(url, parsed.error.issues);
  const data = parsed.data;
  const local = getSpecies(data.id);

  const english = <T extends { language: { name: string } }>(
    entries: T[] | null | undefined,
  ): T[] => (entries ?? []).filter((entry) => entry.language.name === 'en');
  // PokeAPI lists entries in release order, so the last English one is the newest.
  const flavor = english(data.flavor_text_entries).at(-1);

  const varieties: SpeciesVariety[] = [];
  for (const entry of data.varieties ?? []) {
    const local = findBySlug(entry.pokemon.name);
    const pokemonId =
      idFromUrl(entry.pokemon.url) ?? (local ? (local.form?.pokemonId ?? local.species.id) : null);
    if (pokemonId === null) continue;
    varieties.push({ pokemonId, slug: entry.pokemon.name, isDefault: entry.is_default ?? false });
  }

  return {
    id: data.id,
    slug: data.name,
    // The bundled index is the app's single source of display names.
    name: local?.name ?? english(data.names)[0]?.name ?? titleCaseSlug(data.name),
    generation:
      idFromUrl(data.generation?.url) ??
      generationFromSlug(data.generation?.name) ??
      local?.gen ??
      0,
    captureRate: data.capture_rate ?? null,
    genderRate: data.gender_rate ?? -1,
    baseHappiness: data.base_happiness ?? null,
    growthRate: data.growth_rate?.name ?? null,
    eggGroups: (data.egg_groups ?? []).map((group) => group.name),
    hatchCounter: data.hatch_counter ?? null,
    isLegendary: data.is_legendary ?? false,
    isMythical: data.is_mythical ?? false,
    isBaby: data.is_baby ?? false,
    hasGenderDifferences: data.has_gender_differences ?? false,
    genus: english(data.genera)[0]?.genus ?? null,
    flavorText: flavor ? cleanFlavorText(flavor.flavor_text) : null,
    flavorTextVersion: flavor?.version?.name ?? null,
    varieties,
  };
}

// ───────────────────────────── Transport ─────────────────────────────

export interface PokeApiClientOptions {
  baseUrl?: string;
  /** Defaults to the global `fetch`, looked up per request. */
  fetch?: typeof fetch;
  /** Time limit for one attempt, headers and body included (default 12 s). */
  timeoutMs?: number;
  /** Extra attempts after a retryable failure (default 2, i.e. up to 3 requests). */
  retries?: number;
  /** Delay before the first retry; doubles on each further one (default 400 ms). */
  backoffMs?: number;
  /** Upper bound for a single backoff delay, including `Retry-After` (default 5 s). */
  maxBackoffMs?: number;
  /** Defaults to `navigator.onLine`; when it reports false, requests fail fast as `offline`. */
  isOnline?: () => boolean;
}

export interface RequestOptions {
  /** Aborting rejects the request with the signal's reason (an `AbortError`), without retrying. */
  signal?: AbortSignal;
}

export interface PokeApiClient {
  /** `GET /pokemon/{idOrSlug}`, trimmed. Prefer numeric ids — slugs are occasionally renamed upstream. */
  fetchPokemon(idOrSlug: number | string, options?: RequestOptions): Promise<PokemonDetail>;
  /** `GET /pokemon-species/{idOrSlug}`, trimmed. */
  fetchSpecies(idOrSlug: number | string, options?: RequestOptions): Promise<SpeciesDetail>;
}

export const DEFAULT_TIMEOUT_MS = 12_000;
export const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 400;
const DEFAULT_MAX_BACKOFF_MS = 5_000;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The request was aborted.', 'AbortError');
}

/** Resolves after `ms`, or rejects with the signal's reason as soon as it aborts. */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal ? abortReason(signal) : undefined);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** `Retry-After` in delta-seconds form → ms; the HTTP-date form is ignored. */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

function errorForStatus(response: Response, url: string): PokeApiError {
  const { status } = response;
  if (status === 404) {
    return new PokeApiError('not-found', `PokeAPI has no resource at ${url}`, { url, status });
  }
  if (status === 429) {
    return new PokeApiError('rate-limited', 'PokeAPI rate limit reached', {
      url,
      status,
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
    });
  }
  if (status >= 500) {
    return new PokeApiError('server', `PokeAPI server error (HTTP ${status})`, { url, status });
  }
  return new PokeApiError('http', `PokeAPI request failed (HTTP ${status})`, { url, status });
}

/**
 * Normalises a path segment. Slugs are lower-case `[a-z0-9-]`; anything else
 * cannot name a PokeAPI resource (and must never be interpolated into a URL).
 */
function toIdentifier(idOrSlug: number | string): string | null {
  if (typeof idOrSlug === 'number') {
    return Number.isInteger(idOrSlug) && idOrSlug > 0 ? String(idOrSlug) : null;
  }
  const slug = idOrSlug.trim().toLowerCase();
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? slug : null;
}

export function createPokeApiClient(options: PokeApiClientOptions = {}): PokeApiClient {
  const baseUrl = (options.baseUrl ?? POKEAPI_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = Math.max(0, Math.floor(options.retries ?? DEFAULT_RETRIES));
  const backoffMs = Math.max(0, options.backoffMs ?? DEFAULT_BACKOFF_MS);
  const maxBackoffMs = Math.max(backoffMs, options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS);
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const isOnline =
    options.isOnline ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false);

  async function attempt(url: string, signal: AbortSignal | undefined): Promise<unknown> {
    if (signal?.aborted) throw abortReason(signal);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    // The caller's abort wins over everything; a timeout wins over the generic failure it causes.
    const classify = (cause: unknown, fallback: () => PokeApiError): unknown => {
      if (signal?.aborted) return abortReason(signal);
      if (timedOut) {
        return new PokeApiError('timeout', `PokeAPI did not respond within ${timeoutMs} ms`, {
          url,
          cause,
        });
      }
      return fallback();
    };

    try {
      let response: Response;
      try {
        response = await doFetch(url, { signal: controller.signal });
      } catch (cause) {
        throw classify(
          cause,
          () => new PokeApiError('offline', 'Could not reach PokeAPI', { url, cause }),
        );
      }
      if (!response.ok) {
        // The error body is never read; release the connection.
        void response.body?.cancel().catch(() => undefined);
        throw errorForStatus(response, url);
      }
      try {
        return (await response.json()) as unknown;
      } catch (cause) {
        throw classify(cause, () =>
          // Only a parse failure means the body itself is bad. Anything else is the connection
          // dropping while the body streamed in, which is transient and worth another attempt.
          cause instanceof Error && cause.name === 'SyntaxError'
            ? new PokeApiError('invalid-response', 'PokeAPI returned a body that is not JSON', {
                url,
                status: response.status,
                cause,
              })
            : new PokeApiError('offline', 'The connection to PokeAPI was lost mid-response', {
                url,
                status: response.status,
                cause,
              }),
        );
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function requestJson(path: string, signal: AbortSignal | undefined): Promise<unknown> {
    const url = `${baseUrl}/${path}`;
    if (signal?.aborted) throw abortReason(signal);
    if (!isOnline()) {
      throw new PokeApiError('offline', 'The device is offline', { url });
    }

    let failure: PokeApiError | null = null;
    for (let tries = 0; tries <= retries; tries += 1) {
      if (failure) {
        const backoff = Math.min(maxBackoffMs, backoffMs * 2 ** (tries - 1));
        const wait = Math.min(maxBackoffMs, Math.max(backoff, failure.retryAfterMs ?? 0));
        await delay(wait, signal);
      }
      try {
        return await attempt(url, signal);
      } catch (error) {
        // Aborts and permanent failures (404, bad payload, …) surface immediately.
        if (!isPokeApiError(error) || !error.retryable) throw error;
        failure = error;
      }
    }
    throw failure ?? new PokeApiError('offline', 'Could not reach PokeAPI', { url });
  }

  function resourceUrl(resource: string, idOrSlug: number | string): { path: string; url: string } {
    const identifier = toIdentifier(idOrSlug);
    if (identifier === null) {
      throw new PokeApiError(
        'not-found',
        `"${String(idOrSlug)}" is not a valid PokeAPI identifier`,
        {
          url: `${baseUrl}/${resource}`,
        },
      );
    }
    const path = `${resource}/${identifier}`;
    return { path, url: `${baseUrl}/${path}` };
  }

  return {
    async fetchPokemon(idOrSlug, requestOptions = {}) {
      const { path, url } = resourceUrl('pokemon', idOrSlug);
      return trimPokemon(await requestJson(path, requestOptions.signal), url);
    },
    async fetchSpecies(idOrSlug, requestOptions = {}) {
      const { path, url } = resourceUrl('pokemon-species', idOrSlug);
      return trimSpecies(await requestJson(path, requestOptions.signal), url);
    },
  };
}

/** The app-wide client. */
export const pokeApi: PokeApiClient = createPokeApiClient();

/** Fetches and trims one Pokémon variety (`/pokemon/{idOrSlug}`). */
export function fetchPokemon(
  idOrSlug: number | string,
  options?: RequestOptions,
): Promise<PokemonDetail> {
  return pokeApi.fetchPokemon(idOrSlug, options);
}

/** Fetches and trims one species (`/pokemon-species/{id}`). */
export function fetchSpecies(
  id: number | string,
  options?: RequestOptions,
): Promise<SpeciesDetail> {
  return pokeApi.fetchSpecies(id, options);
}
