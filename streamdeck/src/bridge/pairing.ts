/**
 * Locating and reading the pairing file Biolume writes into its userData folder
 * (STREAM_DECK_PAIRING_FILE). The plugin runs as the same OS user, so finding
 * the file is the whole "pairing": no codes to type, and the token rotates on
 * every Biolume start.
 *
 * The file decides where the plugin sends its token and whose state its keys
 * show, so it must really be Biolume's: on macOS / Linux it has to be a regular
 * file owned by this user and writable by nobody else (a file another account
 * planted — e.g. under a shared `BIOLUME_USER_DATA` folder — is refused), and
 * it is opened without blocking and without following a symlink, so a FIFO or
 * link put in its place cannot hang or redirect the read. On Windows `%APPDATA%`
 * is private to the user and Node reports no file owner, so those checks are
 * skipped there.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { STREAM_DECK_PAIRING_FILE, type BridgePairing } from '../../../src/shared/streamDeck';
import { parsePairing } from './protocol';

/** Biolume's folder name under the OS's per-user application data directory. */
export const BIOLUME_APP_DIR = 'Biolume';

/** The pairing document is a few hundred bytes; anything bigger is not Biolume's. */
const MAX_PAIRING_BYTES = 16 * 1024;

/** Flags Node does not define on this platform (Windows) count as 0. */
const optionalFlag = (flag: number | undefined): number => flag ?? 0;

/**
 * Read-only; O_NONBLOCK so a FIFO in the file's place cannot block the open (and a
 * libuv worker thread) forever; O_NOFOLLOW so a symlink cannot point the read elsewhere.
 */
const OPEN_FLAGS =
  constants.O_RDONLY | optionalFlag(constants.O_NONBLOCK) | optionalFlag(constants.O_NOFOLLOW);

/** Group / others write bits: a pairing file anyone else can change is not trusted. */
const FOREIGN_WRITE_BITS = 0o022;

/** This process's uid where files have POSIX owners; null on Windows. */
export function currentOwnerUid(): number | null {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return null;
  return process.getuid();
}

export interface UserDataEnvironment {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  homedir: string;
}

/**
 * Where Biolume keeps its data — mirroring Electron's `app.getPath('userData')`
 * plus the `BIOLUME_USER_DATA` override that src/main/main.ts honours:
 *
 * - Windows: `%APPDATA%\Biolume`
 * - macOS:   `~/Library/Application Support/Biolume`
 * - other:   `$XDG_CONFIG_HOME/Biolume` (`~/.config/Biolume`)
 */
export function biolumeUserDataDir({ platform, env, homedir }: UserDataEnvironment): string {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const override = env['BIOLUME_USER_DATA']?.trim();
  if (override) return paths.resolve(override);
  if (platform === 'win32') {
    const appData = env['APPDATA']?.trim() || paths.join(homedir, 'AppData', 'Roaming');
    return paths.join(appData, BIOLUME_APP_DIR);
  }
  if (platform === 'darwin') {
    return paths.join(homedir, 'Library', 'Application Support', BIOLUME_APP_DIR);
  }
  const config = env['XDG_CONFIG_HOME']?.trim() || paths.join(homedir, '.config');
  return paths.join(config, BIOLUME_APP_DIR);
}

export function pairingFilePath(environment: UserDataEnvironment): string {
  const paths = environment.platform === 'win32' ? path.win32 : path.posix;
  return paths.join(biolumeUserDataDir(environment), STREAM_DECK_PAIRING_FILE);
}

/**
 * True when a process with this id exists. Signal 0 checks without signalling;
 * EPERM means it exists but belongs to someone else (still alive). On Windows
 * Node maps this onto OpenProcess, with the same error codes.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type PairingRead =
  | { kind: 'ok'; pairing: BridgePairing }
  /** No file: Biolume is not running (it removes the file on quit) or never ran. */
  | { kind: 'missing' }
  /** The process that wrote the file is gone (Biolume crashed or was killed). */
  | { kind: 'stale'; pid: number }
  /** Written by a Biolume speaking another bridge protocol version. */
  | { kind: 'incompatible'; protocol: number }
  /** Unreadable, oversized or malformed (possibly caught mid-write). */
  | { kind: 'invalid'; reason: string };

export interface ReadPairingOptions {
  isPidAlive?: (pid: number) => boolean;
  /**
   * The uid the file must belong to; null skips the owner and permission checks.
   * Default: {@link currentOwnerUid} (this user on macOS / Linux, null on Windows).
   */
  ownerUid?: number | null;
}

export async function readPairing(
  file: string,
  options: ReadPairingOptions = {},
): Promise<PairingRead> {
  const ownerUid = options.ownerUid === undefined ? currentOwnerUid() : options.ownerUid;
  let raw: string;
  try {
    const handle = await open(file, OPEN_FLAGS);
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) return { kind: 'invalid', reason: 'not a regular file' };
      if (ownerUid !== null) {
        if (stats.uid !== ownerUid) return { kind: 'invalid', reason: 'not owned by this user' };
        if ((stats.mode & FOREIGN_WRITE_BITS) !== 0) {
          return { kind: 'invalid', reason: 'writable by other users' };
        }
      }
      if (stats.size > MAX_PAIRING_BYTES) return { kind: 'invalid', reason: 'file too large' };
      const buffer = Buffer.alloc(MAX_PAIRING_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_PAIRING_BYTES) return { kind: 'invalid', reason: 'file too large' };
      raw = buffer.toString('utf8', 0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    return { kind: 'invalid', reason: code ?? 'unreadable' };
  }

  const parsed = parsePairing(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  if (parsed.kind !== 'ok') return parsed;
  const alive = options.isPidAlive ?? isPidAlive;
  if (!alive(parsed.pairing.pid)) return { kind: 'stale', pid: parsed.pairing.pid };
  return parsed;
}
