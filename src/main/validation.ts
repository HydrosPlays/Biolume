/**
 * Validation and sanitisation for every trust boundary of the main process.
 *
 *   - files on disk       → lenient `sanitize*` / `read*Document`: repair what can be
 *                           repaired, fill gaps from defaults, never throw on a bad field
 *   - renderer IPC input  → strict `parseInput(inputSchemas.*)`: throw a readable Error
 *   - imported files      → strict `recordSchemas.*`: reject the record and say why
 *
 * Every path rebuilds objects field by field from known keys, so unknown keys —
 * `__proto__` and `constructor` included — never reach application state.
 * Numbers are clamped with `LIMITS`, strings are capped, sprite URLs must be https.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  DEFAULT_GAME_ID,
  DEFAULT_TARGET_LEVEL,
  FULL_ODDS_METHOD_ID,
  LIMITS,
  SOUND_PACKS,
  createDefaultOddsSelection,
  createDefaultSettings,
} from '@shared/defaults';
import {
  HOTKEY_ACTIONS,
  MAX_BINDINGS_PER_ACTION,
  SCHEMA_VERSION,
  type AppState,
  type CompleteHuntInput,
  type CounterSource,
  type CreateHuntInput,
  type ExportDataset,
  type ExportFormat,
  type ExportRequest,
  type GeneralSettings,
  type HotkeyAction,
  type Hunt,
  type HuntPatch,
  type HuntStatus,
  type OddsInputValue,
  type OddsSelection,
  type PhaseEntry,
  type PhaseExportRow,
  type PhasePatch,
  type SessionRecord,
  type Settings,
  type SettingsPatch,
  type SoundPack,
  type TargetRef,
  type TargetSetup,
} from '@shared/types';

// ───────────────────────────── Bounds ─────────────────────────────

/** Structural caps that `LIMITS` does not cover. They exist to bound hostile or runaway input. */
export const BOUNDS = {
  hunts: 2_000,
  phasesPerHunt: 5_000,
  idLength: 64,
  slugLength: 100,
  urlLength: 2_048,
  acceleratorLength: 64,
  oddsInputs: 32,
  oddsInputText: 200,
  typesPerTarget: 3,
  /** PokeAPI ids of alternate forms start at 10001. */
  pokemonId: 1_000_000,
  /** Encounters folded into earlier phases. */
  priorCount: 999_999_999_999,
  /** Any cumulative total: `priorCount + count`. */
  total: 999_999_999_999 + LIMITS.count.max,
  /** A century of hunting time. */
  elapsedMs: 100 * 365 * 24 * 60 * 60 * 1_000,
} as const;

export const FALLBACK_HUNT_NAME = 'Untitled hunt';

/** Last instant of the year 9999 — keeps `toISOString()` in its fixed 24-character form. */
const MAX_TIMESTAMP_MS = 253_402_300_799_999;

// ───────────────────────────── Primitives ─────────────────────────────

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Cut to at most `max` UTF-16 units without splitting a surrogate pair. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff;
  return text.slice(0, splitsPair ? max - 1 : max);
}

/** Single-line text: control characters become spaces, then trim and cap. */
export function cleanLine(text: string, max: number): string {
  return truncate(
    text
      .slice(0, max * 4)
      .replace(/\p{Cc}+/gu, ' ')
      .trim(),
    max,
  ).trimEnd();
}

/** Multi-line text: newlines are normalised to LF, other control characters (except TAB) removed. */
export function cleanText(text: string, max: number): string {
  const normalised = text
    .slice(0, max * 4)
    .replace(/\r\n?/g, '\n')
    .replace(/[^\P{Cc}\n\t]+/gu, '');
  return truncate(normalised, max);
}

/** Names that must never be used as object keys or ids. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TYPE_PATTERN = /^[a-z]{1,16}$/;

/** Ids of hunts, phases and sessions: 1–64 characters from `A-Z a-z 0-9 _ . : -`. */
export function isValidId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= BOUNDS.idLength &&
    ID_PATTERN.test(value) &&
    !FORBIDDEN_KEYS.has(value)
  );
}

function isValidKey(value: string): boolean {
  return value.length <= BOUNDS.idLength && KEY_PATTERN.test(value) && !FORBIDDEN_KEYS.has(value);
}

/** Returns a normalised https URL without credentials, or null for anything else. */
export function toHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > BOUNDS.urlLength) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' && url.username === '' && url.password === ''
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Trim, drop blanks and case-insensitive duplicates (Electron accelerators ignore case). */
export function cleanBindings(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of list) {
    const accelerator = entry.trim();
    const key = accelerator.toLowerCase();
    if (accelerator === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(accelerator);
  }
  return out;
}

function cleanTypes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (out.length >= BOUNDS.typesPerTarget) break;
    if (typeof entry !== 'string') continue;
    const slug = entry.trim().toLowerCase();
    if (TYPE_PATTERN.test(slug) && !out.includes(slug)) out.push(slug);
  }
  return out;
}

/** Copies valid method-input values into a fresh object; anything unexpected is left behind. */
function cleanOddsInputs(raw: Record<string, unknown>): Record<string, OddsInputValue> {
  const out: Record<string, OddsInputValue> = {};
  let kept = 0;
  for (const key of Object.keys(raw)) {
    if (kept >= BOUNDS.oddsInputs) break;
    if (!isValidKey(key)) continue;
    const value = raw[key];
    if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'string') out[key] = truncate(value, BOUNDS.oddsInputText);
    else continue;
    kept += 1;
  }
  return out;
}

function freshId(taken: ReadonlySet<string>, generate: () => string): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = generate();
    if (isValidId(id) && !taken.has(id)) return id;
  }
  // The injected generator keeps colliding or returns malformed ids — fall back to a UUID.
  return randomUUID();
}

/** A hunt's display name: the cleaned input, else the target's name, else a generic label. */
export function resolveHuntName(name: string | undefined, target: TargetRef | null): string {
  const cleaned = name === undefined ? '' : cleanLine(name, LIMITS.huntName);
  return cleaned || target?.name || FALLBACK_HUNT_NAME;
}

// ───────────────────────────── Leaf schemas ─────────────────────────────

function oneOf<T extends string>(members: readonly T[]): z.ZodType<T> {
  return z.custom<T>(
    (value) => typeof value === 'string' && (members as readonly string[]).includes(value),
    `expected one of ${members.join(', ')}`,
  );
}

/** `Record<T, true>` makes the member list exhaustive at compile time. */
function oneOfKeys<T extends string>(members: Record<T, true>): z.ZodType<T> {
  return oneOf(Object.keys(members) as T[]);
}

const intBetween = (min: number, max: number) =>
  z.number().transform((value) => clamp(Math.trunc(value), min, max));
const numberBetween = (min: number, max: number) =>
  z.number().transform((value) => clamp(value, min, max));
const lineSchema = (max: number) => z.string().transform((value) => cleanLine(value, max));

const idSchema = z.string().refine(isValidId, 'expected 1–64 letters, digits or _ . : -');
const optionalIdSchema = z
  .string()
  .refine(
    (value) => value === '' || isValidId(value),
    'expected an id (letters, digits or _ . : -) or nothing',
  );
const keySchema = z.string().refine(isValidKey, 'expected a short id (letters, digits or _ . -)');
const nameSchema = lineSchema(LIMITS.huntName);
const notesSchema = z.string().transform((value) => cleanText(value, LIMITS.notes));
const countSchema = intBetween(LIMITS.count.min, LIMITS.count.max);
const priorCountSchema = intBetween(0, BOUNDS.priorCount);
const totalSchema = intBetween(0, BOUNDS.total);
const stepSchema = intBetween(LIMITS.step.min, LIMITS.step.max);
const levelSchema = intBetween(LIMITS.targetLevel.min, LIMITS.targetLevel.max);
const elapsedSchema = intBetween(0, BOUNDS.elapsedMs);
const pokemonIdSchema = z.number().int().min(1).max(BOUNDS.pokemonId);

const isoDateSchema = z
  .string()
  .max(64)
  .transform((value, ctx) => {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms) || ms < 0 || ms > MAX_TIMESTAMP_MS) {
      ctx.issues.push({ code: 'custom', message: 'expected a date and time', input: value });
      return z.NEVER;
    }
    return new Date(ms).toISOString();
  });

/** Never fails: anything that is not an https URL becomes null. */
const spriteUrlSchema = z.unknown().optional().transform(toHttpsUrl);

const huntStatusSchema = oneOfKeys<HuntStatus>({ active: true, completed: true, archived: true });
const counterSourceSchema = oneOfKeys<CounterSource>({
  ui: true,
  overlay: true,
  'hotkey-global': true,
  'hotkey-local': true,
  streamdeck: true,
  import: true,
  system: true,
});
const exportDatasetSchema = oneOfKeys<ExportDataset>({
  backup: true,
  sessions: true,
  phases: true,
  targets: true,
});
const exportFormatSchema = oneOfKeys<ExportFormat>({ json: true, csv: true });

export function isExportDataset(value: unknown): value is ExportDataset {
  return exportDatasetSchema.safeParse(value).success;
}

const targetSchema: z.ZodType<TargetRef> = z.object({
  speciesId: pokemonIdSchema,
  pokemonId: pokemonIdSchema,
  slug: z
    .string()
    .max(BOUNDS.slugLength)
    .regex(SLUG_PATTERN, 'expected a PokeAPI slug (lowercase letters, digits and hyphens)'),
  name: nameSchema.refine((value) => value !== '', 'must not be empty'),
  types: z.unknown().optional().transform(cleanTypes),
  spriteUrl: spriteUrlSchema,
  shinySpriteUrl: spriteUrlSchema,
});

const oddsInputsSchema = z.record(z.string(), z.unknown()).transform(cleanOddsInputs);

// ───────────────────────────── Record schemas ─────────────────────────────

interface SchemaEnv {
  /** `lenient` substitutes a fallback for every invalid field; `strict` rejects the record. */
  mode: 'strict' | 'lenient';
  nowIso: () => string;
  newId: () => string;
  /** Called once per list entry that had to be discarded (lenient mode only). */
  onDrop: (count: number) => void;
}

function buildRecordSchemas(env: SchemaEnv) {
  const lenient = env.mode === 'lenient';

  const or = <T>(schema: z.ZodType<T>, fallback: () => T): z.ZodType<T> =>
    lenient ? schema.catch(() => fallback()) : schema;

  const listOf = <T>(item: z.ZodType<T>, max: number): z.ZodType<T[]> =>
    lenient
      ? z
          .unknown()
          .optional()
          .transform((raw): T[] => {
            if (!Array.isArray(raw)) return [];
            const out: T[] = [];
            for (let index = 0; index < raw.length; index += 1) {
              if (out.length >= max) {
                env.onDrop(raw.length - index);
                break;
              }
              const parsed = item.safeParse(raw[index]);
              if (parsed.success) out.push(parsed.data);
              else env.onDrop(1);
            }
            return out;
          })
      : z.array(item).max(max);

  const odds: z.ZodType<OddsSelection> = or(
    z.object({
      gameId: keySchema,
      methodId: keySchema,
      shinyCharm: or(z.boolean(), () => false),
      inputs: or(oddsInputsSchema, () => ({})),
    }),
    createDefaultOddsSelection,
  );

  const phase: z.ZodType<PhaseEntry> = z
    .object({
      id: or(idSchema, env.newId),
      speciesId: or(pokemonIdSchema.nullable(), () => null),
      speciesName: or(nameSchema, () => ''),
      spriteUrl: spriteUrlSchema,
      encounters: or(countSchema, () => 0),
      totalEncounters: or(totalSchema, () => 0),
      timestamp: or(isoDateSchema, env.nowIso),
      notes: or(notesSchema, () => ''),
    })
    .transform((value) =>
      value.totalEncounters >= value.encounters
        ? value
        : { ...value, totalEncounters: value.encounters },
    );

  const hunt: z.ZodType<Hunt> = z
    .object({
      id: or(idSchema, env.newId),
      name: or(z.string(), () => ''),
      status: or<HuntStatus>(huntStatusSchema, () => 'active'),
      target: or(targetSchema.nullable(), () => null),
      targetLevel: or(levelSchema, () => DEFAULT_TARGET_LEVEL),
      odds,
      count: or(countSchema, () => 0),
      priorCount: or(priorCountSchema, () => 0),
      step: or(stepSchema, () => 1),
      phases: listOf(phase, BOUNDS.phasesPerHunt),
      notes: or(notesSchema, () => ''),
      // '' marks a timestamp that could not be read; it is resolved against its sibling below.
      createdAt: or(isoDateSchema, () => ''),
      updatedAt: or(isoDateSchema, () => ''),
      completedAt: or(isoDateSchema.nullable(), () => null),
      elapsedMs: or(elapsedSchema, () => 0),
    })
    .transform((value, ctx): Hunt => {
      const seen = new Set<string>();
      const phases: PhaseEntry[] = [];
      for (const entry of value.phases) {
        if (!seen.has(entry.id)) {
          seen.add(entry.id);
          phases.push(entry);
        } else if (lenient) {
          const id = freshId(seen, env.newId);
          seen.add(id);
          phases.push({ ...entry, id });
        } else {
          ctx.issues.push({
            code: 'custom',
            message: `duplicate phase id "${entry.id}"`,
            input: value.phases,
            path: ['phases'],
          });
          return z.NEVER;
        }
      }
      // Timestamps are normalised ISO strings, so they order lexicographically.
      const createdAt = value.createdAt || value.updatedAt || env.nowIso();
      const updatedAt = value.updatedAt > createdAt ? value.updatedAt : createdAt;
      let completedAt = value.completedAt;
      if (value.status === 'active') completedAt = null;
      else if (value.status === 'completed' && completedAt === null) completedAt = updatedAt;
      return {
        ...value,
        name: resolveHuntName(value.name, value.target),
        phases,
        createdAt,
        updatedAt,
        completedAt,
      };
    });

  const session: z.ZodType<SessionRecord> = z
    .object({
      id: or(idSchema, env.newId),
      huntId: or(idSchema, () => 'unknown'),
      huntName: or(nameSchema, () => ''),
      targetName: or(nameSchema.nullable(), () => null),
      gameId: or(keySchema, () => DEFAULT_GAME_ID),
      methodId: or(keySchema, () => FULL_ODDS_METHOD_ID),
      startedAt: or(isoDateSchema, () => ''),
      endedAt: or(isoDateSchema, () => ''),
      startCount: or(totalSchema, () => 0),
      endCount: or(totalSchema, () => 0),
      encounters: or(totalSchema, () => 0),
      phasesLogged: or(intBetween(0, BOUNDS.phasesPerHunt), () => 0),
    })
    .transform((value) => {
      const startedAt = value.startedAt || value.endedAt || env.nowIso();
      const endedAt = value.endedAt > startedAt ? value.endedAt : startedAt;
      return startedAt === value.startedAt && endedAt === value.endedAt
        ? value
        : { ...value, startedAt, endedAt };
    });

  return { odds, phase, hunt, session };
}

const strictSchemas = buildRecordSchemas({
  mode: 'strict',
  // Strict schemas never substitute fallbacks, so these are only type fillers.
  nowIso: () => new Date(0).toISOString(),
  newId: randomUUID,
  onDrop: () => undefined,
});

const phaseRowSchema: z.ZodType<PhaseExportRow> = z
  .object({
    huntId: optionalIdSchema,
    huntName: nameSchema,
    targetName: nameSchema,
    phaseNumber: intBetween(1, BOUNDS.phasesPerHunt),
    phaseId: optionalIdSchema,
    speciesId: pokemonIdSchema.nullable(),
    speciesName: nameSchema,
    encounters: countSchema,
    totalEncounters: totalSchema,
    timestamp: isoDateSchema,
    notes: notesSchema,
  })
  .refine((row) => row.huntId !== '' || row.huntName !== '', 'needs a huntId or a huntName')
  .transform((row) =>
    row.totalEncounters >= row.encounters ? row : { ...row, totalEncounters: row.encounters },
  );

const targetSetupSchema: z.ZodType<TargetSetup> = z.object({
  name: nameSchema,
  target: targetSchema.nullable(),
  targetLevel: levelSchema,
  odds: strictSchemas.odds,
  step: stepSchema,
  notes: notesSchema,
});

/** Strict schemas for records arriving from an import file. */
export const recordSchemas = {
  hunt: strictSchemas.hunt,
  session: strictSchemas.session,
  phaseRow: phaseRowSchema,
  targetSetup: targetSetupSchema,
} as const;

// ───────────────────────────── Settings ─────────────────────────────

const SETTING_DEFAULTS = createDefaultSettings();

const soundPackSchema = oneOf<SoundPack>(SOUND_PACKS);
const reducedMotionSchema = oneOfKeys<GeneralSettings['reducedMotion']>({
  system: true,
  on: true,
  off: true,
});
const volumeSchema = numberBetween(0, 1);
const opacitySchema = numberBetween(LIMITS.overlayOpacity.min, LIMITS.overlayOpacity.max);
const scaleSchema = numberBetween(LIMITS.overlayScale.min, LIMITS.overlayScale.max);
const idleMinutesSchema = numberBetween(
  LIMITS.sessionIdleMinutes.min,
  LIMITS.sessionIdleMinutes.max,
);

/** Renderer input: an over-long list or accelerator is an error the UI should hear about. */
const bindingListSchema = z
  .array(z.string())
  .max(32)
  .transform((list, ctx) => {
    const cleaned = cleanBindings(list);
    if (cleaned.some((accelerator) => accelerator.length > BOUNDS.acceleratorLength)) {
      ctx.issues.push({ code: 'custom', message: 'a shortcut is too long', input: list });
      return z.NEVER;
    }
    if (cleaned.length > MAX_BINDINGS_PER_ACTION) {
      ctx.issues.push({
        code: 'custom',
        message: `at most ${MAX_BINDINGS_PER_ACTION} shortcuts per action`,
        input: list,
      });
      return z.NEVER;
    }
    return cleaned;
  });

/** Files on disk: keep whatever is usable; a missing or malformed list falls back to the default. */
const storedBindings = (action: HotkeyAction) =>
  z
    .array(z.unknown())
    .transform((list) =>
      cleanBindings(list.filter((entry): entry is string => typeof entry === 'string'))
        .filter((accelerator) => accelerator.length <= BOUNDS.acceleratorLength)
        .slice(0, MAX_BINDINGS_PER_ACTION),
    )
    .catch(() => [...SETTING_DEFAULTS.hotkeys.bindings[action]]);

const storedSettingsSchema = z.object({
  hotkeys: z
    .object({
      globalEnabled: z.boolean().catch(SETTING_DEFAULTS.hotkeys.globalEnabled),
      bindings: z
        .object({
          increment: storedBindings('increment'),
          decrement: storedBindings('decrement'),
          undo: storedBindings('undo'),
          logPhase: storedBindings('logPhase'),
          shinyFound: storedBindings('shinyFound'),
          toggleOverlay: storedBindings('toggleOverlay'),
        })
        .catch(() => createDefaultSettings().hotkeys.bindings),
    })
    .catch(() => createDefaultSettings().hotkeys),
  audio: z
    .object({
      enabled: z.boolean().catch(SETTING_DEFAULTS.audio.enabled),
      volume: volumeSchema.catch(SETTING_DEFAULTS.audio.volume),
      pack: soundPackSchema.catch(SETTING_DEFAULTS.audio.pack),
      milestoneChime: z.boolean().catch(SETTING_DEFAULTS.audio.milestoneChime),
    })
    .catch(() => createDefaultSettings().audio),
  overlay: z
    .object({
      opacity: opacitySchema.catch(SETTING_DEFAULTS.overlay.opacity),
      scale: scaleSchema.catch(SETTING_DEFAULTS.overlay.scale),
      showSprite: z.boolean().catch(SETTING_DEFAULTS.overlay.showSprite),
      showOdds: z.boolean().catch(SETTING_DEFAULTS.overlay.showOdds),
      showPhase: z.boolean().catch(SETTING_DEFAULTS.overlay.showPhase),
      clickThrough: z.boolean().catch(SETTING_DEFAULTS.overlay.clickThrough),
      hideMainWindow: z.boolean().catch(SETTING_DEFAULTS.overlay.hideMainWindow),
    })
    .catch(() => createDefaultSettings().overlay),
  general: z
    .object({
      confirmDestructive: z.boolean().catch(SETTING_DEFAULTS.general.confirmDestructive),
      sessionIdleMinutes: idleMinutesSchema.catch(SETTING_DEFAULTS.general.sessionIdleMinutes),
      reducedMotion: reducedMotionSchema.catch(SETTING_DEFAULTS.general.reducedMotion),
    })
    .catch(() => createDefaultSettings().general),
  // Files written before the Stream Deck integration have no such section: they get the default.
  streamDeck: z
    .object({
      enabled: z.boolean().catch(SETTING_DEFAULTS.streamDeck.enabled),
    })
    .catch(() => createDefaultSettings().streamDeck),
});

/** Any value → valid settings: unknown keys dropped, gaps filled from the defaults, numbers clamped. */
export function sanitizeSettings(raw: unknown): Settings {
  const parsed = storedSettingsSchema.safeParse(raw);
  return parsed.success
    ? { schemaVersion: SCHEMA_VERSION, ...parsed.data }
    : createDefaultSettings();
}

const settingsPatchSchema: z.ZodType<SettingsPatch> = z.object({
  hotkeys: z
    .object({
      globalEnabled: z.boolean().optional(),
      bindings: z
        .object({
          increment: bindingListSchema.optional(),
          decrement: bindingListSchema.optional(),
          undo: bindingListSchema.optional(),
          logPhase: bindingListSchema.optional(),
          shinyFound: bindingListSchema.optional(),
          toggleOverlay: bindingListSchema.optional(),
        })
        .optional(),
    })
    .optional(),
  audio: z
    .object({
      enabled: z.boolean().optional(),
      volume: volumeSchema.optional(),
      pack: soundPackSchema.optional(),
      milestoneChime: z.boolean().optional(),
    })
    .optional(),
  overlay: z
    .object({
      opacity: opacitySchema.optional(),
      scale: scaleSchema.optional(),
      showSprite: z.boolean().optional(),
      showOdds: z.boolean().optional(),
      showPhase: z.boolean().optional(),
      clickThrough: z.boolean().optional(),
      hideMainWindow: z.boolean().optional(),
    })
    .optional(),
  general: z
    .object({
      confirmDestructive: z.boolean().optional(),
      sessionIdleMinutes: idleMinutesSchema.optional(),
      reducedMotion: reducedMotionSchema.optional(),
    })
    .optional(),
  streamDeck: z
    .object({
      enabled: z.boolean().optional(),
    })
    .optional(),
});

/** Copies the defined keys of `patch` over `base`, walking the keys of the trusted `base`. */
function mergeDefined<T extends object>(base: T, patch: Partial<T> | undefined): T {
  if (patch === undefined) return base;
  const next = { ...base };
  for (const key of Object.keys(base) as (keyof T)[]) {
    const value = patch[key];
    if (value !== undefined) next[key] = value;
  }
  return next;
}

/**
 * Applies a patch that already passed `inputSchemas.settingsPatch`: sections merge
 * key by key, hotkey bindings are replaced per action.
 */
export function mergeSettings(current: Settings, patch: SettingsPatch): Settings {
  const bindings = { ...current.hotkeys.bindings };
  for (const action of HOTKEY_ACTIONS) {
    const next = patch.hotkeys?.bindings?.[action];
    if (next !== undefined) bindings[action] = next;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    hotkeys: {
      globalEnabled: patch.hotkeys?.globalEnabled ?? current.hotkeys.globalEnabled,
      bindings,
    },
    audio: mergeDefined(current.audio, patch.audio),
    overlay: mergeDefined(current.overlay, patch.overlay),
    general: mergeDefined(current.general, patch.general),
    streamDeck: mergeDefined(current.streamDeck, patch.streamDeck),
  };
}

// ───────────────────────────── Renderer input ─────────────────────────────

const createHuntInputSchema: z.ZodType<CreateHuntInput> = z.object({
  name: nameSchema.optional(),
  target: targetSchema.nullable().optional(),
  targetLevel: levelSchema.optional(),
  odds: strictSchemas.odds.optional(),
  step: stepSchema.optional(),
  notes: notesSchema.optional(),
  activate: z.boolean().optional(),
});

const huntPatchSchema: z.ZodType<HuntPatch> = z.object({
  name: nameSchema.optional(),
  target: targetSchema.nullable().optional(),
  targetLevel: levelSchema.optional(),
  odds: strictSchemas.odds.optional(),
  step: stepSchema.optional(),
  notes: notesSchema.optional(),
  status: huntStatusSchema.optional(),
});

/** `LogPhaseInput` after validation: every optional field of the phase itself is resolved. */
export interface ValidLogPhaseInput {
  speciesId: number | null;
  speciesName: string;
  spriteUrl: string | null;
  notes: string;
  resetCount?: boolean | undefined;
  source?: CounterSource | undefined;
}

/** `speciesId` / `speciesName` may be omitted — a quick-log by hotkey has neither yet. */
const logPhaseInputSchema: z.ZodType<ValidLogPhaseInput> = z.object({
  speciesId: pokemonIdSchema.nullable().default(null),
  speciesName: nameSchema.default(''),
  spriteUrl: spriteUrlSchema,
  notes: notesSchema.default(''),
  resetCount: z.boolean().optional(),
  source: counterSourceSchema.optional(),
});

const phasePatchSchema: z.ZodType<PhasePatch> = z.object({
  speciesId: pokemonIdSchema.nullable().optional(),
  speciesName: nameSchema.optional(),
  // `undefined` means "leave as is"; anything else is coerced to an https URL or null.
  spriteUrl: z
    .unknown()
    .optional()
    .transform((value) => (value === undefined ? undefined : toHttpsUrl(value))),
  notes: notesSchema.optional(),
});

const completeHuntInputSchema: z.ZodType<CompleteHuntInput> = z.object({
  notes: notesSchema.optional(),
});

const exportRequestSchema: z.ZodType<ExportRequest> = z.object({
  dataset: exportDatasetSchema,
  format: exportFormatSchema,
  huntIds: z
    .array(z.string().max(BOUNDS.idLength * 4))
    .max(BOUNDS.hunts * 4)
    .optional(),
});

const wholeNumber = z.number().int('expected a whole number');

/** Strict schemas for everything the renderer sends over IPC. */
export const inputSchemas = {
  createHunt: createHuntInputSchema,
  huntPatch: huntPatchSchema,
  logPhase: logPhaseInputSchema,
  phasePatch: phasePatchSchema,
  completeHunt: completeHuntInputSchema,
  settingsPatch: settingsPatchSchema,
  counterSource: counterSourceSchema,
  /** Signed count change; clamped so that any delta can at most span the whole range. */
  delta: wholeNumber.transform((value) => clamp(value, -LIMITS.count.max, LIMITS.count.max)),
  count: wholeNumber.transform((value) => clamp(value, LIMITS.count.min, LIMITS.count.max)),
  exportRequest: exportRequestSchema,
} as const;

/** "`path`: problem; …" for the first few issues — safe to show to the user (never echoes values). */
export function describeIssues(error: z.ZodError, limit = 3): string {
  const parts = error.issues.slice(0, limit).map((issue) => {
    const path = issue.path.map(String).join('.');
    const message = issue.message.replace(/^Invalid input: /, '');
    return path === '' ? message : `${path}: ${message}`;
  });
  const more = error.issues.length - parts.length;
  return truncate(parts.join('; ') + (more > 0 ? ` (+${more} more)` : ''), 300);
}

/** Parses untrusted input, throwing `Error("Invalid <what>: …")` when it does not fit. */
export function parseInput<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`Invalid ${what}: ${describeIssues(result.error)}`);
  return result.data;
}

// ───────────────────────────── Lenient sanitisers ─────────────────────────────

export interface SanitizeContext {
  /** Stands in for missing or unparsable timestamps (default: the current time). */
  now?: Date;
  /** Supplies ids for records that lack a valid or unique one (default: `randomUUID`). */
  idGenerator?: () => string;
}

function lenientSchemas(context: SanitizeContext) {
  const tally = { dropped: 0 };
  const nowIso = (context.now ?? new Date()).toISOString();
  const schemas = buildRecordSchemas({
    mode: 'lenient',
    nowIso: () => nowIso,
    newId: context.idGenerator ?? randomUUID,
    onDrop: (count) => {
      tally.dropped += count;
    },
  });
  return { schemas, tally, newId: context.idGenerator ?? randomUUID };
}

/**
 * Any value → valid hunts with unique ids. Entries that are not objects are
 * dropped and counted; everything else is repaired in place.
 */
export function sanitizeHunts(
  raw: unknown,
  context: SanitizeContext = {},
): { hunts: Hunt[]; dropped: number } {
  const { schemas, tally, newId } = lenientSchemas(context);
  const hunts: Hunt[] = [];
  const seen = new Set<string>();
  const list = Array.isArray(raw) ? raw : [];
  for (let index = 0; index < list.length; index += 1) {
    if (hunts.length >= BOUNDS.hunts) {
      tally.dropped += list.length - index;
      break;
    }
    const parsed = schemas.hunt.safeParse(list[index]);
    if (!parsed.success) {
      tally.dropped += 1;
      continue;
    }
    const id = seen.has(parsed.data.id) ? freshId(seen, newId) : parsed.data.id;
    seen.add(id);
    hunts.push(id === parsed.data.id ? parsed.data : { ...parsed.data, id });
  }
  return { hunts, dropped: tally.dropped };
}

/** Newest first by start time; stable, so equal timestamps keep their relative order. */
export function sortSessions(sessions: readonly SessionRecord[]): SessionRecord[] {
  return [...sessions].sort((a, b) =>
    a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0,
  );
}

/** Any value → valid sessions: unique ids, newest first, capped at `LIMITS.sessions`. */
export function sanitizeSessions(
  raw: unknown,
  context: SanitizeContext = {},
): { sessions: SessionRecord[]; dropped: number } {
  const { schemas, tally } = lenientSchemas(context);
  const sessions: SessionRecord[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw) ? raw : []) {
    const parsed = schemas.session.safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.id)) {
      tally.dropped += 1;
      continue;
    }
    seen.add(parsed.data.id);
    sessions.push(parsed.data);
  }
  const sorted = sortSessions(sessions);
  // Trimming the oldest sessions beyond the cap is routine housekeeping, not data damage.
  return { sessions: sorted.slice(0, LIMITS.sessions), dropped: tally.dropped };
}

/** The most recently updated hunt that can still be counted on, or null. */
export function pickFallbackActiveHunt(hunts: readonly Hunt[]): string | null {
  let best: Hunt | null = null;
  for (const hunt of hunts) {
    if (hunt.status !== 'active') continue;
    if (best === null || hunt.updatedAt > best.updatedAt) best = hunt;
  }
  return best?.id ?? null;
}

/** Keeps `candidate` when it names an existing hunt, keeps an explicit null, otherwise picks a fallback. */
export function resolveActiveHuntId(hunts: readonly Hunt[], candidate: unknown): string | null {
  if (candidate === null) return null;
  if (typeof candidate === 'string' && hunts.some((hunt) => hunt.id === candidate))
    return candidate;
  return pickFallbackActiveHunt(hunts);
}

/** Rebuilds a complete, invariant-respecting `AppState` from an untrusted object. */
export function sanitizeAppState(raw: unknown, context: SanitizeContext = {}): AppState {
  if (!isRecord(raw)) throw new Error('Invalid state: expected an object');
  const { hunts } = sanitizeHunts(raw['hunts'], context);
  return {
    settings: sanitizeSettings(raw['settings']),
    hunts,
    activeHuntId: resolveActiveHuntId(hunts, raw['activeHuntId']),
    sessions: sanitizeSessions(raw['sessions'], context).sessions,
  };
}

// ───────────────────────────── Persisted documents ─────────────────────────────

export type DocumentKind = 'settings' | 'hunts' | 'sessions';

/** Upgrades a raw document by exactly one schema version. */
export type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;
export type MigrationTable = Record<DocumentKind, Partial<Record<number, Migration>>>;

/**
 * `MIGRATIONS[kind][n]` turns a version-n document into version n + 1. Schema
 * v1 is current, so the table is empty; add an entry here when bumping
 * `SCHEMA_VERSION`. Gaps are fine — the lenient sanitisers fill new fields.
 */
const MIGRATIONS: MigrationTable = { settings: {}, hunts: {}, sessions: {} };

export interface MigrationResult {
  doc: Record<string, unknown>;
  /** Version the document was written with (documents without one count as v1). */
  fromVersion: number;
  /** True when the document comes from a newer Biolume than this one. */
  newer: boolean;
}

export function migrateDocument(
  kind: DocumentKind,
  doc: Record<string, unknown>,
  migrations: MigrationTable = MIGRATIONS,
  targetVersion: number = SCHEMA_VERSION,
): MigrationResult {
  const stored = doc['schemaVersion'];
  const fromVersion =
    typeof stored === 'number' && Number.isInteger(stored) && stored >= 1 ? stored : 1;
  let current = doc;
  for (let version = fromVersion; version < targetVersion; version += 1) {
    const migrate = migrations[kind][version];
    if (migrate) current = migrate(current);
  }
  return { doc: current, fromVersion, newer: fromVersion > targetVersion };
}

/** The file parsed as JSON but is not a document of the expected kind. */
export class InvalidDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDocumentError';
  }
}

export interface DocumentReadResult<T> {
  value: T;
  /** Records that could not be salvaged. */
  dropped: number;
  fromVersion: number;
  newer: boolean;
}

export interface HuntsDocument {
  hunts: Hunt[];
  activeHuntId: string | null;
}

function openDocument(kind: DocumentKind, raw: unknown): MigrationResult {
  if (!isRecord(raw)) throw new InvalidDocumentError('expected a JSON object');
  return migrateDocument(kind, raw);
}

/** `settings.json` → `Settings`. Throws {@link InvalidDocumentError} unless it is an object. */
export function readSettingsDocument(raw: unknown): DocumentReadResult<Settings> {
  const { doc, fromVersion, newer } = openDocument('settings', raw);
  return { value: sanitizeSettings(doc), dropped: 0, fromVersion, newer };
}

/** `hunts.json` → hunts + active id. Throws {@link InvalidDocumentError} without a `hunts` array. */
export function readHuntsDocument(
  raw: unknown,
  context: SanitizeContext = {},
): DocumentReadResult<HuntsDocument> {
  const { doc, fromVersion, newer } = openDocument('hunts', raw);
  if (!Array.isArray(doc['hunts'])) throw new InvalidDocumentError('expected a "hunts" array');
  const { hunts, dropped } = sanitizeHunts(doc['hunts'], context);
  return {
    value: { hunts, activeHuntId: resolveActiveHuntId(hunts, doc['activeHuntId']) },
    dropped,
    fromVersion,
    newer,
  };
}

/** `sessions.json` → sessions. Throws {@link InvalidDocumentError} without a `sessions` array. */
export function readSessionsDocument(
  raw: unknown,
  context: SanitizeContext = {},
): DocumentReadResult<SessionRecord[]> {
  const { doc, fromVersion, newer } = openDocument('sessions', raw);
  if (!Array.isArray(doc['sessions']))
    throw new InvalidDocumentError('expected a "sessions" array');
  const { sessions, dropped } = sanitizeSessions(doc['sessions'], context);
  return { value: sessions, dropped, fromVersion, newer };
}
