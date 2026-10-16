/**
 * Session bookkeeping — pure functions over the newest-first session list.
 *
 * A session is one continuous stretch of counting on a single hunt. The store
 * holds the {@link OpenSession} marker in memory; a session's record is written
 * into the list as soon as it opens and updated on every activity, so closing a
 * session changes nothing on disk — it only stops further updates.
 */
import { LIMITS } from '@shared/defaults';
import type { Hunt, SessionRecord } from '@shared/types';
import { sortSessions } from './validation';

/** The session currently being extended. */
export interface OpenSession {
  id: string;
  huntId: string;
  /** Epoch ms of the most recent activity — the reference point for idle detection. */
  lastActivityMs: number;
}

export interface ActivityInput {
  hunt: Pick<Hunt, 'id' | 'name' | 'target' | 'odds'>;
  /** Hunt total (`priorCount + count`) before and after the change. */
  totalBefore: number;
  totalAfter: number;
  /** +1 when a phase was logged, negative when an undo took phases back. */
  phasesDelta: number;
  at: Date;
  /** Idle gap after which the running session is considered over. */
  idleMs: number;
  /** False for changes that may extend a running session but must not start one (undo). */
  canOpen: boolean;
  /** Called at most once, when a session opens. */
  newId: () => string;
}

export interface ActivityResult {
  /** The list to store; the same array instance when nothing changed. */
  sessions: SessionRecord[];
  open: OpenSession | null;
  /** Time since the previous activity in the same session — add it to `hunt.elapsedMs`. */
  gapMs: number;
  opened: boolean;
  /** The previously open session ended (idle gap, or activity on another hunt). */
  closed: boolean;
}

/** True when `open` cannot absorb activity on `huntId` at `atMs`. */
export function isSessionOver(
  open: OpenSession,
  huntId: string,
  atMs: number,
  idleMs: number,
): boolean {
  return open.huntId !== huntId || atMs - open.lastActivityMs > idleMs;
}

/**
 * Folds one counter activity into the session list: extends the open session,
 * or closes it and opens a new one when it idled out or belongs to another hunt.
 */
export function recordActivity(
  sessions: SessionRecord[],
  open: OpenSession | null,
  input: ActivityInput,
): ActivityResult {
  const { hunt, at } = input;
  const atMs = at.getTime();

  let current = open;
  let closed = false;
  if (current !== null && isSessionOver(current, hunt.id, atMs, input.idleMs)) {
    current = null;
    closed = true;
  }

  // The open session sits at the head of the list unless an import reshuffled it.
  let index = -1;
  if (current !== null) {
    const id = current.id;
    index = sessions[0]?.id === id ? 0 : sessions.findIndex((session) => session.id === id);
    if (index === -1) {
      current = null;
      closed = true;
    }
  }
  const previous = sessions[index];

  if (current === null || previous === undefined) {
    if (!input.canOpen) return { sessions, open: null, gapMs: 0, opened: false, closed };
    const iso = at.toISOString();
    const record: SessionRecord = {
      id: input.newId(),
      huntId: hunt.id,
      huntName: hunt.name,
      targetName: hunt.target?.name ?? null,
      gameId: hunt.odds.gameId,
      methodId: hunt.odds.methodId,
      startedAt: iso,
      endedAt: iso,
      startCount: input.totalBefore,
      endCount: input.totalAfter,
      encounters: Math.max(0, input.totalAfter - input.totalBefore),
      phasesLogged: Math.max(0, input.phasesDelta),
    };
    return {
      sessions: [record, ...sessions].slice(0, LIMITS.sessions),
      open: { id: record.id, huntId: hunt.id, lastActivityMs: atMs },
      gapMs: 0,
      opened: true,
      closed,
    };
  }

  // A clock that jumps backwards must not shorten the session or produce negative time.
  const gapMs = Math.max(0, atMs - current.lastActivityMs);
  const iso = at.toISOString();
  const updated: SessionRecord = {
    ...previous,
    huntName: hunt.name,
    targetName: hunt.target?.name ?? null,
    gameId: hunt.odds.gameId,
    methodId: hunt.odds.methodId,
    endedAt: iso > previous.endedAt ? iso : previous.endedAt,
    endCount: input.totalAfter,
    encounters: Math.max(0, input.totalAfter - previous.startCount),
    phasesLogged: Math.max(0, previous.phasesLogged + input.phasesDelta),
  };
  const next = sessions.slice();
  next[index] = updated;
  return {
    sessions: next,
    open: { ...current, lastActivityMs: Math.max(atMs, current.lastActivityMs) },
    gapMs,
    opened: false,
    closed: false,
  };
}

/**
 * Adds the incoming sessions whose ids are not present yet. The result is
 * newest first and capped at `LIMITS.sessions`; `added` counts the incoming
 * sessions that made it into the result.
 */
export function mergeSessions(
  existing: readonly SessionRecord[],
  incoming: readonly SessionRecord[],
): { sessions: SessionRecord[]; added: number; duplicates: number } {
  const known = new Set(existing.map((session) => session.id));
  const fresh: SessionRecord[] = [];
  let duplicates = 0;
  for (const session of incoming) {
    if (known.has(session.id)) {
      duplicates += 1;
      continue;
    }
    known.add(session.id);
    fresh.push(session);
  }
  if (fresh.length === 0) return { sessions: [...existing], added: 0, duplicates };
  const freshIds = new Set(fresh.map((session) => session.id));
  const sessions = sortSessions([...existing, ...fresh]).slice(0, LIMITS.sessions);
  const added = sessions.reduce((count, session) => count + (freshIds.has(session.id) ? 1 : 0), 0);
  return { sessions, added, duplicates };
}
