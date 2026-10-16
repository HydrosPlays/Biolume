# Biolume for Stream Deck

An Elgato Stream Deck plugin (`app.biolume.streamdeck`) that drives the running
Biolume app: count encounters, log phases and confirm shinies from your Stream Deck,
with the live count right on the keys.

## Install

- **From Biolume:** use the Stream Deck section in Settings to install the plugin.
  Biolume opens the bundled `app.biolume.streamdeck.streamDeckPlugin` and the Stream
  Deck app offers to install it.
- **By hand:** double-click `build/streamdeck/app.biolume.streamdeck.streamDeckPlugin`
  (made by `npm run streamdeck:pack`).

Needs Stream Deck 7.1 or later (Windows 10+ or macOS 12+). The plugin then shows up
in the Stream Deck action list under **Biolume**. Biolume's Stream Deck bridge must
be on (the Stream Deck setting, on by default).

## The keys

| Key            | Face                                                                       | Press                                                                                                                                 |
| -------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Counter        | The active hunt's count, big, with the target's name (or its shiny sprite) | +1 encounter (the hunt's step)                                                                                                        |
| Increment      | `+1` (or `+step`)                                                          | +1 encounter, check mark                                                                                                              |
| Decrement      | `−1` (or `−step`)                                                          | One step back, check mark                                                                                                             |
| Log Phase      | The current phase number                                                   | Quick-logs a phase (an off-target shiny); count restarts                                                                              |
| Shiny Found    | Gold sparkle                                                               | **Press twice within 3 s**: the first press arms it (key turns gold, "Confirm?" with a countdown), the second marks the hunt as found |
| Undo           | Undo arrow                                                                 | Reverts the hunt's last change (including Shiny Found)                                                                                |
| Toggle Overlay | Overlay glyph                                                              | Shows / hides Biolume's mini-overlay                                                                                                  |

- Counts past 9,999 are shortened, always rounded down: `12.3k`, `123k`, `1.2M`.
- Every key shows **Offline** (red) while Biolume is not running or not reachable,
  **No hunt** when there is no active hunt, and **Update** when the app and plugin
  speak different bridge versions.
- A refused press (no active hunt, Biolume offline…) shows Stream Deck's yellow
  alert triangle. The Counter key does not flash a check mark on success — its
  number changing is the feedback.

Everything acts on the same hunt as the Hunt tab, so the app updates and animates
as you press.

## How pairing works

There is nothing to set up. When Biolume starts, its bridge listens on
`127.0.0.1` only (port 47637, or a free one if that is taken) and writes
`streamdeck-bridge.json` — port, a fresh random token and its process id — into
Biolume's data folder:

- Windows: `%APPDATA%\Biolume\streamdeck-bridge.json`
- macOS: `~/Library/Application Support/Biolume/streamdeck-bridge.json`
- or `$BIOLUME_USER_DATA` when that environment variable is set (use an absolute path)

The plugin runs as the same user, reads that file and connects with
`Authorization: Bearer <token>`. It watches the file, so restarting Biolume (new
token, maybe a new port) reconnects at once; a file whose process is gone is
ignored as stale. Requests from web pages are refused by the bridge, and the token
changes every time the bridge starts (app start, or the setting switched back on). Protocol: [`src/shared/streamDeck.ts`](../src/shared/streamDeck.ts).

## No plugin? Use Stream Deck's Hotkey action

Biolume's global hotkeys can be driven by Stream Deck's built-in **System → Hotkey**
action instead:

1. In Stream Deck, add four **Hotkey** actions and set them to **F13**, **F14**,
   **F15** and **F16**. Most keyboards have no F13–F24 and games practically never
   bind them, so Biolume can register them globally without stealing a key a game
   needs.
2. In Biolume's hotkey settings, record those keys (press the Stream Deck key while
   the binding field is listening) for _Count encounter_, _Undo count_,
   _Quick-log phase_ and _Shiny found (press twice)_.

Shiny Found still needs two presses within 3 seconds. The plugin's keys add the live
faces; the hotkeys work without it.

## Development

```sh
npm --prefix streamdeck ci       # once (streamdeck:pack does it when node_modules is missing)
npm run streamdeck:test          # unit tests (vitest): SSE parser, pairing, backoff, client, faces, keys
npm run streamdeck:build         # typecheck + bundle to app.biolume.streamdeck.sdPlugin/bin/plugin.js
npm run streamdeck:pack          # build, smoke-test the bundle, validate, pack to build/streamdeck/
npx electron scripts/streamdeck-icons.mjs   # regenerate the manifest images from build/icon.png
```

`npm run dist` packs the plugin before building the app. For live development link the
folder into Stream Deck (`npx streamdeck link app.biolume.streamdeck.sdPlugin` inside
`streamdeck/`) and run `npm run watch` there.

Layout:

- `src/bridge/` — the bridge client, free of SDK imports: pairing file, SSE parser,
  backoff, validation of everything the bridge sends.
- `src/faces/` — SVG key faces, count formatting, the sprite cache; `theme.json` holds the
  colours and glyphs shared with `scripts/streamdeck-icons.mjs`.
- `src/keys/` — the key controller (snapshots → faces, presses → actions) and the thin
  Stream Deck SDK adapters.
- `scripts/smoke.mjs` — boots the built bundle against a fake Stream Deck and a fake bridge.
- `scripts/e2e-live.mjs <userData>` — the same with a fake Stream Deck but the _real_ app:
  start Biolume with `BIOLUME_USER_DATA` pointing at a scratch folder that holds an active
  hunt, then run it with that folder. It counts, arms and confirms Shiny Found, checks every
  step against `GET /v1/state` and undoes it all; `--wait-offline 60 --wait-restart 60` also
  covers closing and restarting Biolume.
