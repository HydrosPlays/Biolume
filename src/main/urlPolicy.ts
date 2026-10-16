/**
 * URL decisions of the security layer: what counts as the app's own page and
 * which links may be handed to the operating system.
 *
 * This module must stay free of `electron` imports so it can be unit-tested.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTERNAL_URL_ALLOWLIST } from '@shared/ipc';

const MAX_URL_LENGTH = 2_048;

/**
 * Parses a link the renderer wants opened in the default browser. Only plain
 * `https:` URLs on the default port, without credentials, whose host is on the
 * allow-list pass; everything else yields null.
 */
export function parseExternalUrl(
  raw: unknown,
  allowlist: readonly string[] = EXTERNAL_URL_ALLOWLIST,
): URL | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text === '' || text.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port !== '') return null;
  if (url.username !== '' || url.password !== '') return null;
  return allowlist.includes(url.hostname) ? url : null;
}

export interface AppUrlPolicy {
  /** True for the renderer's own document: the dev server origin, or the packaged `index.html`. */
  isAppUrl(url: string): boolean;
}

export interface AppUrlPolicyOptions {
  /** Absolute path of the built renderer entry (`out/renderer/index.html`). */
  rendererFile: string;
  /** Dev-server URL the windows load instead; null / undefined when running from files. */
  devServerUrl?: string | null | undefined;
}

/** A dev-server URL is only honoured when it is a well-formed http(s) URL. */
export function parseDevServerUrl(raw: string | null | undefined): URL | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function comparablePath(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

export function createAppUrlPolicy(options: AppUrlPolicyOptions): AppUrlPolicy {
  const devOrigin = parseDevServerUrl(options.devServerUrl)?.origin ?? null;
  const rendererFile = comparablePath(options.rendererFile);

  return {
    isAppUrl(candidate) {
      let url: URL;
      try {
        url = new URL(candidate);
      } catch {
        return false;
      }
      if (devOrigin !== null) return url.origin === devOrigin;
      if (url.protocol !== 'file:') return false;
      try {
        // Query and hash are not part of the path, so `index.html#/odds` still matches.
        return comparablePath(fileURLToPath(url)) === rendererFile;
      } catch {
        return false;
      }
    },
  };
}
