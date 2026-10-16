/**
 * Biolume shared domain model.
 *
 * Imported by the main process, the preload script and the renderer, so this
 * file must stay free of runtime imports from `electron`, `node:*` or React.
 * The main process is the single source of truth for everything in
 * {@link AppState}; renderers mirror it through the IPC bridge in `ipc.ts`.
 */

/** Bumped whenever a persisted shape changes; storage migrates on load. */
export const SCHEMA_VERSION = 1;

/** ISO-8601 timestamp, e.g. `2026-10-13T18:04:11.201Z`. */
export type ISODateString = string;

// ───────────────────────────── Targets ─────────────────────────────

/** Snapshot of the Pokémon being hunted — enough to render offline. */
export interface TargetRef {
  /** National Pokédex number (PokeAPI `pokemon-species` id). */
  speciesId: number;
  /** PokeAPI `pokemon` id — differs from `speciesId` for alternate forms. */
  pokemonId: number;
  /** PokeAPI `pokemon` slug, e.g. `vulpix-alola`. */
  slug: string;
  /** Display name, e.g. `Alolan Vulpix`. */
  name: string;
  /** PokeAPI type slugs in slot order, e.g. `['ice']`. */
  types: string[];
  spriteUrl: string | null;
  shinySpriteUrl: string | null;
}

// ───────────────────────────── Odds ─────────────────────────────

export type OddsInputValue = boolean | number | string;

/**
 * Which hunting method a hunt uses. `gameId` / `methodId` index into
 * `src/renderer/data/oddsMethods.json`; `inputs` holds the values of that
 * method's declared inputs (missing keys fall back to the input's default).
 */
export interface OddsSelection {
  gameId: string;
  methodId: string;
  shinyCharm: boolean;
  inputs: Record<string, OddsInputValue>;
}

// ───────────────────────────── Hunts ─────────────────────────────

/** A non-target shiny that appeared mid-hunt (a "phase"). */
export interface PhaseEntry {
  id: string;
  /** National dex number, or null when the species was typed free-form / left unidentified. */
  speciesId: number | null;
  /** Display name; empty string while unidentified (quick-logged by hotkey). */
  speciesName: string;
  spriteUrl: string | null;
  /** Encounters in the phase that just ended — the "roll count". */
  encounters: number;
  /** The hunt's cumulative encounter total at the moment of logging. */
  totalEncounters: number;
  timestamp: ISODateString;
  notes: string;
}

export type HuntStatus = 'active' | 'completed' | 'archived';

export interface Hunt {
  id: string;
  name: string;
  status: HuntStatus;
  target: TargetRef | null;
  /** Wild level the encounter analyzer uses to predict the target's moveset (1–100). */
  targetLevel: number;
  odds: OddsSelection;
  /** Encounters in the current phase. */
  count: number;
  /** Encounters accumulated in earlier, already-logged phases. Total = priorCount + count. */
  priorCount: number;
  /** Amount one "increment" adds (e.g. 5 for Horde Encounters). Always ≥ 1. */
  step: number;
  phases: PhaseEntry[];
  notes: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  completedAt: ISODateString | null;
  /** Active hunting time in ms, accumulated from sessions. */
  elapsedMs: number;
}

/** Total encounters across every phase of a hunt. */
export function huntTotal(hunt: Pick<Hunt, 'count' | 'priorCount'>): number {
  return hunt.priorCount + hunt.count;
}

/**
 * One continuous stretch of counting on a single hunt. The main process opens
 * a session on the first counter change and closes it after
 * `settings.general.sessionIdleMinutes` of inactivity, a hunt switch, or quit.
 */
export interface SessionRecord {
  id: string;
  huntId: string;
  huntName: string;
  targetName: string | null;
  gameId: string;
  methodId: string;
  startedAt: ISODateString;
  /** Time of the last counter activity in the session. */
  endedAt: ISODateString;
  /** Hunt total when the session began / at its last activity. */
  startCount: number;
  endCount: number;
  /** Net encounters added during the session. */
  encounters: number;
  phasesLogged: number;
}

// ───────────────────────────── Settings ─────────────────────────────

export type HotkeyAction =
  'increment' | 'decrement' | 'undo' | 'logPhase' | 'shinyFound' | 'toggleOverlay';

export const HOTKEY_ACTIONS: readonly HotkeyAction[] = [
  'increment',
  'decrement',
  'undo',
  'logPhase',
  'shinyFound',
  'toggleOverlay',
];

/** Upper bound on accelerators bound to a single action. */
export const MAX_BINDINGS_PER_ACTION = 3;

export interface HotkeySettings {
  /** Master switch for OS-wide (unfocused) shortcuts. In-app shortcuts always work. */
  globalEnabled: boolean;
  /**
   * Electron accelerator strings per action, e.g. `{ increment: ['numadd', 'Space'] }`.
   * @see https://www.electronjs.org/docs/latest/api/accelerator
   */
  bindings: Record<HotkeyAction, string[]>;
}

export type SoundPack = 'sonar' | 'bubble' | 'click' | 'chime';

export interface AudioSettings {
  enabled: boolean;
  /** 0–1. */
  volume: number;
  pack: SoundPack;
  /** Extra chime when the count crosses an odds milestone (50% / 90% / over odds). */
  milestoneChime: boolean;
}

export interface OverlaySettings {
  /** Background opacity of the overlay card, 0.2–1. */
  opacity: number;
  /** UI scale, 0.75–1.5. */
  scale: number;
  showSprite: boolean;
  showOdds: boolean;
  showPhase: boolean;
  /** Let mouse clicks fall through to the game underneath. */
  clickThrough: boolean;
  /** Hide the main window while the overlay is open. */
  hideMainWindow: boolean;
}

export interface GeneralSettings {
  /** Ask before deleting hunts / phases or resetting counters. */
  confirmDestructive: boolean;
  /** Idle gap that closes a session. */
  sessionIdleMinutes: number;
  reducedMotion: 'system' | 'on' | 'off';
}

export interface Settings {
  schemaVersion: number;
  hotkeys: HotkeySettings;
  audio: AudioSettings;
  overlay: OverlaySettings;
  general: GeneralSettings;
  streamDeck: StreamDeckSettings;
}

/** Elgato Stream Deck integration (see `src/shared/streamDeck.ts`). */
export interface StreamDeckSettings {
  /** Run the local bridge the Biolume Stream Deck plugin connects to. */
  enabled: boolean;
}

/** Deep-partial patch accepted by `settings.update`; sections merge shallowly per key. */
export interface SettingsPatch {
  hotkeys?: Partial<Omit<HotkeySettings, 'bindings'>> & {
    bindings?: Partial<Record<HotkeyAction, string[]>>;
  };
  audio?: Partial<AudioSettings>;
  overlay?: Partial<OverlaySettings>;
  general?: Partial<GeneralSettings>;
  streamDeck?: Partial<StreamDeckSettings>;
}

// ───────────────────────────── App state ─────────────────────────────

export interface AppState {
  settings: Settings;
  hunts: Hunt[];
  activeHuntId: string | null;
  /** Newest first, capped by the main process. */
  sessions: SessionRecord[];
}

/** Where a counter change came from. `hotkey-global` = OS-wide shortcut while unfocused. */
export type CounterSource =
  'ui' | 'overlay' | 'hotkey-global' | 'hotkey-local' | 'streamdeck' | 'import' | 'system';

export type HuntChangeKind =
  | 'created'
  | 'edited'
  | 'increment'
  | 'decrement'
  | 'set-count'
  | 'phase-logged'
  | 'phase-edited'
  | 'phase-removed'
  | 'completed'
  | 'reopened'
  | 'undo';

/** Why a hunt changed — lets renderers pick audio / animation feedback. */
export interface HuntChange {
  kind: HuntChangeKind;
  /** Signed change applied to the current-phase count (0 when not a count change). */
  delta: number;
  source: CounterSource;
  phaseId?: string;
}

/** Pushed from main to every window whenever state changes. */
export type StateEvent =
  | { type: 'hunt-changed'; hunt: Hunt; change: HuntChange }
  | { type: 'hunt-removed'; huntId: string }
  | { type: 'active-hunt-changed'; activeHuntId: string | null }
  | { type: 'settings-changed'; settings: Settings }
  | { type: 'sessions-changed'; sessions: SessionRecord[] }
  | { type: 'state-replaced'; state: AppState };

// ───────────────────────────── Hunt mutations ─────────────────────────────

export interface CreateHuntInput {
  name?: string;
  target?: TargetRef | null;
  targetLevel?: number;
  odds?: OddsSelection;
  step?: number;
  notes?: string;
  /** Make the new hunt the active one (default true). */
  activate?: boolean;
}

/** Editable hunt fields. Counts go through `adjustCount` / `setCount` so they stay undoable. */
export type HuntPatch = Partial<
  Pick<Hunt, 'name' | 'target' | 'targetLevel' | 'odds' | 'step' | 'notes' | 'status'>
>;

export interface LogPhaseInput {
  speciesId: number | null;
  speciesName: string;
  spriteUrl?: string | null;
  notes?: string;
  /** Start a fresh phase: fold `count` into `priorCount` and reset it to 0 (default true). */
  resetCount?: boolean;
  source?: CounterSource;
}

export type PhasePatch = Partial<
  Pick<PhaseEntry, 'speciesId' | 'speciesName' | 'spriteUrl' | 'notes'>
>;

export interface CompleteHuntInput {
  notes?: string;
}

// ───────────────────────────── Hotkeys ─────────────────────────────

export interface HotkeyRegistration {
  action: HotkeyAction;
  accelerator: string;
  /** False when the OS refused it (already owned by another app) or it is invalid. */
  registered: boolean;
  error?: string;
}

/**
 * - `active`      — global shortcuts are registered with the OS.
 * - `disabled`    — `settings.hotkeys.globalEnabled` is off.
 * - `app-focused` — a focusable Biolume window has focus, so shortcuts are handled
 *                   in-renderer instead (keeps Space etc. typeable in text fields).
 * - `capturing`   — the settings UI is recording a new binding.
 */
export type HotkeyMode = 'active' | 'disabled' | 'app-focused' | 'capturing';

export interface HotkeyStatus {
  mode: HotkeyMode;
  /** Result of the most recent registration attempt for every configured binding. */
  registrations: HotkeyRegistration[];
}

// ───────────────────────────── Shiny Found confirmation ─────────────────────────────

/**
 * Shiny Found triggered from a hotkey or the Stream Deck needs two presses: the
 * first arms it for SHINY_CONFIRM_WINDOW_MS (src/shared/streamDeck.ts), a second
 * press inside that window completes the hunt. The Hunt view's own button
 * completes directly.
 */
export interface ShinyFoundResult {
  /** True when this press completed the hunt. */
  completed: boolean;
  /** Epoch ms the pending confirmation expires; null when not armed (completed or refused). */
  armedUntil: number | null;
  hunt: Hunt;
}

/** Pushed to every window whenever a hunt's Shiny Found confirmation is armed, confirmed or expires. */
export interface ShinyArmedEvent {
  huntId: string;
  /** Epoch ms the confirmation window closes; null once confirmed or expired. */
  armedUntil: number | null;
  source: CounterSource;
}

// ───────────────────────────── Stream Deck ─────────────────────────────

export interface StreamDeckStatus {
  /** settings.streamDeck.enabled */
  enabled: boolean;
  /** The bridge is accepting connections on 127.0.0.1. */
  listening: boolean;
  port: number | null;
  /** Stream Deck plugin instances currently connected (open event streams). */
  clients: number;
  /** The packaged .streamDeckPlugin installer ships with this build. */
  pluginBundled: boolean;
  /** Why the bridge is not listening, when it should be. */
  error: string | null;
}

/** Emitted to renderers when a *global* hotkey fired, after main applied its effect. */
export interface HotkeyActionEvent {
  action: HotkeyAction;
  accelerator: string;
  huntId: string | null;
  /** For `logPhase`: id of the quick-logged, still-unidentified phase. */
  phaseId?: string;
}

// ───────────────────────────── Windows ─────────────────────────────

export type WindowKind = 'main' | 'overlay';

export interface WindowStateInfo {
  kind: WindowKind;
  maximized: boolean;
  focused: boolean;
  /** Main window pinned above other windows. */
  alwaysOnTop: boolean;
  /** Whether the mini-overlay window is currently open. */
  overlayOpen: boolean;
}

// ───────────────────────────── Export / import ─────────────────────────────

/**
 * - `backup`   — everything (hunts incl. phases, sessions, settings). JSON only.
 * - `sessions` — session history.
 * - `phases`   — phase logs, flattened one row per phase.
 * - `targets`  — target setups (hunt configuration without progress).
 */
export type ExportDataset = 'backup' | 'sessions' | 'phases' | 'targets';
export type ExportFormat = 'json' | 'csv';

export interface ExportRequest {
  dataset: ExportDataset;
  format: ExportFormat;
  /** Restrict to these hunts (default: all). */
  huntIds?: string[];
}

export interface ExportResult {
  canceled: boolean;
  filePath: string | null;
  /** Rows / records written. */
  records: number;
  error?: string;
}

/** One phase, flattened with its hunt context — the row shape of phase-log exports. */
export interface PhaseExportRow {
  huntId: string;
  huntName: string;
  targetName: string;
  phaseNumber: number;
  phaseId: string;
  speciesId: number | null;
  speciesName: string;
  encounters: number;
  totalEncounters: number;
  timestamp: ISODateString;
  notes: string;
}

/** A hunt's configuration without progress — the row shape of target-setup exports. */
export interface TargetSetup {
  name: string;
  target: TargetRef | null;
  targetLevel: number;
  odds: OddsSelection;
  step: number;
  notes: string;
}

/** Envelope of every JSON file Biolume exports. */
export interface ExportBundle {
  app: 'biolume';
  kind: ExportDataset;
  schemaVersion: number;
  exportedAt: ISODateString;
  hunts?: Hunt[];
  sessions?: SessionRecord[];
  phases?: PhaseExportRow[];
  targets?: TargetSetup[];
  settings?: Settings;
}

export interface ImportRequest {
  /** `merge` keeps existing data (matching ids are updated); `replace` swaps the imported dataset in. */
  mode: 'merge' | 'replace';
}

export interface ImportResult {
  canceled: boolean;
  filePath: string | null;
  /** Detected dataset, or null when the file was not recognised. */
  dataset: ExportDataset | null;
  imported: { hunts: number; phases: number; sessions: number; targets: number };
  skipped: number;
  /** Human-readable problems (invalid rows, unknown hunts, …). Empty on a clean import. */
  errors: string[];
}
