/**
 * Security hardening for every session and web contents the app creates.
 *
 * The renderer is our own bundled code behind a strict CSP, sandboxed and
 * context-isolated — these guards make sure it stays that way even if a bug or
 * a compromised dependency tries to leave the app's page, open windows, embed a
 * `<webview>` or ask for device permissions.
 */
import { app, session, shell, type Session, type WebContents } from 'electron';
import { parseExternalUrl, type AppUrlPolicy } from './urlPolicy';

export const BLOCKED_LINK_MESSAGE =
  'This link cannot be opened: Biolume only opens https links to PokeAPI, Bulbapedia, Serebii and GitHub.';

export interface SecurityOptions {
  policy: AppUrlPolicy;
  /** Development only: lets the DevTools front-end navigate within `devtools://`. */
  allowDevTools: boolean;
  log?: (message: string, detail?: unknown) => void;
}

/**
 * Opens an allow-listed https link in the default browser. Rejects with a
 * user-presentable Error for anything else — nothing is handed to the OS then.
 */
export async function openExternalLink(raw: unknown): Promise<void> {
  const url = parseExternalUrl(raw);
  if (url === null) throw new Error(BLOCKED_LINK_MESSAGE);
  // The normalised form, never the caller's string.
  await shell.openExternal(url.href);
}

/** Denies every permission request and check, device access and download on `target`. */
export function hardenSession(target: Session): void {
  target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
  target.setDevicePermissionHandler(() => false);
  // Exports are written by the main process; the renderer has no reason to download anything.
  target.on('will-download', (event) => event.preventDefault());
}

export function hardenWebContents(contents: WebContents, options: SecurityOptions): void {
  const { policy, allowDevTools } = options;
  const log = options.log ?? (() => undefined);

  const isTrusted = (url: string): boolean =>
    policy.isAppUrl(url) || (allowDevTools && url.startsWith('devtools://'));

  /** Allow-listed https links leave through the default browser instead of an app window. */
  const openOutside = (url: string): void => {
    const target = parseExternalUrl(url);
    if (target === null) {
      log(`Blocked navigation to ${url.slice(0, 200)}`);
      return;
    }
    shell.openExternal(target.href).catch((error: unknown) => {
      log('Could not open a link in the default browser', error);
    });
  };

  contents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (details) => {
    if (isTrusted(details.url)) return;
    details.preventDefault();
    openOutside(details.url);
  });

  // Sub-frames only: the main frame is already covered by `will-navigate`.
  contents.on('will-frame-navigate', (details) => {
    if (details.isMainFrame || isTrusted(details.url)) return;
    details.preventDefault();
    log(`Blocked a frame navigation to ${details.url.slice(0, 200)}`);
  });

  contents.on('will-redirect', (details) => {
    if (isTrusted(details.url)) return;
    details.preventDefault();
    log(`Blocked a redirect to ${details.url.slice(0, 200)}`);
  });

  contents.on('will-attach-webview', (event) => event.preventDefault());
}

/**
 * Applies the guards to the default session and to everything created from now
 * on. Call once, after the app is ready and before the first window exists.
 */
export function installSecurityGuards(options: SecurityOptions): void {
  hardenSession(session.defaultSession);
  app.on('session-created', (created) => hardenSession(created));
  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents, options));
}
