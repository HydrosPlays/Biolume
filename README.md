<p align="center">
  <img src="docs/logo.png" alt="Biolume logo: the word Biolume beneath a glowing map pin with a shiny sparkle" width="440">
</p>

# Biolume

A desktop Pokémon shiny hunting and encounter utility: an encounter counter with global hotkeys and a
floating mini-overlay, a shiny odds engine for 17 games (Gen 2 to Legends: Z-A), a target analyzer that
predicts a wild Pokémon's moveset and flags the moves that can ruin a hunt, a Scarlet / Violet sandwich
helper, and a log of phases, sessions and finished hunts.

Built with Electron, electron-vite, React, TypeScript, zustand and TanStack Query.

## Prerequisites

- Node.js 22.12 or newer (24 LTS recommended) and npm
- Windows 10 / 11 is the primary target; the code also builds for macOS and Linux

## Commands

| Command                 | What it does                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `npm install`           | Install dependencies                                                                            |
| `npm run dev`           | Run the app with hot reload                                                                     |
| `npm run build`         | Type-check, then build main, preload and renderer into `out/`                                   |
| `npm start`             | Build and run the production build (`electron-vite preview`)                                    |
| `npm test`              | Unit and component tests (Vitest)                                                               |
| `npm run lint`          | ESLint                                                                                          |
| `npm run typecheck`     | TypeScript for the main and renderer projects                                                   |
| `npm run smoke`         | Build, then run the end-to-end smoke test (see below)                                           |
| `npm run dist`          | Build and package Windows installers (NSIS and portable) into `release/`                        |
| `npm run data:validate` | Re-check every odds checkpoint and risk move in the bundled data files                          |
| `npm run data:build`    | Regenerate the bundled species and move indexes from the PokeAPI CSV dumps (needs a connection) |

### Smoke test

`npm run smoke` starts the real app against a throw-away data directory without showing a window. It
seeds a demo hunt, screenshots every view into `.smoke/` (including each view at the minimum window size
of 940x600), drives the IPC bridge, the global hotkeys, the overlay, export / import and persistence, then
prints one line `[smoke] {...}` and exits with 0 when everything passed.

Set `BIOLUME_SMOKE_TOUR=1` to add review screenshots (`tour-*.png`): every view scrolled page by page,
each Log tab, the Hunt dialogs and the completed-hunt summary.

`BIOLUME_USER_DATA=<directory>` points a normal run at a different data directory.

## Layout of `src/`

```
src/
  shared/      Domain types, defaults and the window.biolume IPC contract, used by both processes
  main/        Electron main process: the state store (single source of truth), JSON storage,
               windows, global hotkeys, IPC handlers, export / import, security policy, smoke test
               preload.ts exposes the typed window.biolume bridge to the renderers
  renderer/
    api/         Cached PokeAPI client (TanStack Query, persisted in IndexedDB)
    components/  One file per view (Counter, TargetSearch, OddsEngine, SandwichHelper, LogView,
                 SettingsView, OverlayView, PhaseDialog) with a folder of parts for each,
                 layout/ (app shell, title bar, sidebar) and ui/ (the component kit)
    data/        Bundled data: oddsMethods.json, riskMoves.json, speciesIndex.json, moveIndex.json
    hooks/       Routing, in-app hotkeys, counter feedback, keyboard capture
    lib/         Odds engine and formulas, probability maths, moveset prediction, risk analysis,
                 species search, sprites, formatting, audio
    store/       zustand mirror of the main-process state, plus the actions that call it
    styles/      Design tokens and base styles
scripts/       Data build and validation scripts
```

The main process owns all state. Renderers call an action over IPC and update from the event that comes
back, so the main window and the overlay always agree.

## Global hotkeys

- While Biolume is in the background, minimised, or hidden behind the mini-overlay, the keys you bind are
  registered with the operating system and captured system-wide, so you can count without leaving the
  game. A registered key does not reach the game.
- While a Biolume window has focus, the same keys are handled inside the app instead, so keys such as
  Space stay typeable in text fields.
- Settings > Hotkeys shows whether each shortcut was registered. A key another program already owns is
  reported as unavailable. The whole feature can be switched off there.
- Games running in exclusive fullscreen can cover the mini-overlay. Run the game in borderless or
  windowed mode to keep the overlay visible.

Defaults: `Num +` counts, `Num -` takes one step back, `Ctrl+Shift+B` toggles the mini-overlay.

## Stream Deck

Biolume works with the Elgato Stream Deck in two ways: through its own plugin, or with no plugin at all
through Stream Deck's built-in Hotkey action. Either way the keys change the same hunt as the Hunt view,
which updates, plays its sounds and animates as if you had clicked.

**Plugin.** Open Settings > Stream Deck and choose **Install Stream Deck plugin**; the Stream Deck app asks
to add it. (In a development checkout, run `npm run streamdeck:pack` once first; without the packed
installer the button is disabled.) The plugin adds these actions:

| Action         | What it does                                                           |
| -------------- | ---------------------------------------------------------------------- |
| Counter        | Shows the live count of the active hunt; a press counts one encounter  |
| Increment      | Counts one encounter (one step of the hunt)                            |
| Decrement      | Takes one step back off the count                                      |
| Log Phase      | Logs a phase; identify the shiny later in Biolume                      |
| Shiny Found    | Press twice within 3 s: the key shows "Confirm?" after the first press |
| Undo           | Reverts the last count, phase or Shiny Found                           |
| Toggle Overlay | Opens or closes the mini-overlay                                       |

Keys show "Offline" while Biolume is closed or the bridge is switched off. The Hunt view shows a "Stream
Deck" chip while the plugin is connected, and Settings > Stream Deck shows the bridge's status.

**Pairing and security.** The plugin talks to Biolume over a small HTTP bridge that listens on
`127.0.0.1` only, so nothing outside this computer can reach it. When the bridge starts it writes a pairing
file (`streamdeck-bridge.json`, with the port and a fresh random token) to its data folder, and deletes it
— revoking that token — when it stops or Biolume quits. The plugin runs as the same user, reads the file
and sends the token with every request, so there is nothing to set up. Requests without the token, and any
request a web page makes (browsers always send an `Origin` header), are refused. Switch the bridge off
under Settings > Stream Deck if you do not use it.

**Shiny Found takes two presses.** From the Stream Deck or a hotkey, the first press only arms it: the key
and the Hunt view's "Shiny found!" button light up gold, with a countdown. A second press within 3 seconds
completes the hunt; otherwise nothing happens. A stray tap can never end a hunt, holding a hotkey down
counts as a single press, and Undo still takes a confirmed one back. The Hunt view's own button completes
at once.

**No plugin: F13–F16 with the Hotkey action.** F13 to F24 exist on hardly any keyboard and no game uses
them, so Biolume can register them system-wide without taking a key away from anything.

1. In Settings > Stream Deck, choose **Bind F13–F16**. It adds F13 (count), F14 (one step back), F15 (log
   phase) and F16 (Shiny Found) next to your existing shortcuts; a key that another action already uses
   is left alone and reported.
2. In the Stream Deck app, drag **System > Hotkey** onto a key and set its hotkey to one of those keys
   (F13 to F24 are in the Hotkey field's key list).
3. Keep **Global hotkeys** on under Settings > Hotkeys, so the keys work while your game has focus.

The Hotkey route has no live count on the keys; Shiny Found on F16 still needs two presses.

## Your data

Everything is stored locally as plain JSON in Electron's `userData` directory (on Windows
`%APPDATA%\Biolume`): `hunts.json`, `sessions.json`, `settings.json` and `window-state.json`. Saves are
atomic and the previous good copy of each file is kept beside it as `.bak`. Settings > Data & About and
Log > Data show the exact path and open the folder.

Export and import live under Log > Data:

| Dataset     | Formats   | Contents                                              |
| ----------- | --------- | ----------------------------------------------------- |
| Full backup | JSON      | Hunts with their phases, session history and settings |
| Sessions    | JSON, CSV | One record per hunting session                        |
| Phases      | JSON, CSV | One record per logged phase                           |
| Targets     | JSON, CSV | One record per hunt target                            |

Import detects which kind of file it was given. **Merge** keeps what you have and adds or updates records
by id; **Replace** swaps your data for the file's and always asks first. Restore from a full backup.

## Data sources and credits

- Species, moves, learnsets and sprites come from [PokéAPI](https://pokeapi.co/) and its sprite
  repository. Responses are cached on your computer; a small species and move index is bundled so search
  works offline.
- **Where to find a Pokémon** (the locations panel of the Target view: every location, how it is met,
  levels, rates, conditions, version exclusives and shiny locks) comes from two sources:
  - **PokéAPI** (`/pokemon/{id}/encounters`) for Gold / Silver / Crystal through Sword / Shield, including
    Let's Go and the Isle of Armor / Crown Tundra. It is fetched when first needed and cached like the rest
    of the PokéAPI data. Location names come from `src/renderer/data/locationIndex.json`, built from
    PokéAPI's CSV dumps by `npm run data:locations`. PokéAPI only lists where a Pokémon is met, so the panel
    never claims a Pokémon is missing from one of these games, and it has no shiny-lock flags.
  - **[PKHeX](https://github.com/kwsch/PKHeX)'s game data** (GPL-3.0) for the games PokéAPI has no locations
    for: Brilliant Diamond / Shining Pearl, Legends: Arceus, Scarlet / Violet (with the Teal Mask and the
    Indigo Disk) and Legends: Z-A (with Mega Dimension). Each game is bundled as
    `src/renderer/data/encounters/<game>.json` and loaded on demand. These files list every Pokémon in the
    game, so they also say when one is not in it, and they record which encounters are shiny-locked. They
    are extracted by `npm run data:bdsp`, `data:pla`, `data:sv` and `data:za`; only facts are taken
    (species, places, levels, conditions, shiny locks), re-keyed to PokéAPI's ids.
- **Pokémon Legends: Z-A** level-up learnsets are bundled in `src/renderer/data/zaLearnsets.json`, also
  written by `npm run data:za` from PKHeX's data, because PokéAPI lists the game but has no learnsets for
  it yet; when PokéAPI adds its own, those take precedence automatically.
- Shiny odds, method notes and sandwich recipes are in `src/renderer/data/oddsMethods.json`. Every method
  and recipe lists its own sources in that file (Bulbapedia, Serebii, datamine write-ups and others), and
  `npm run data:validate` re-checks all 316 odds checkpoints.
- Risk moves are in `src/renderer/data/riskMoves.json`.
- Fonts: Space Grotesk, Inter and JetBrains Mono (SIL Open Font License). Icons: Lucide.

## Disclaimer

Biolume is an unofficial, fan-made tool. It is not affiliated with, endorsed or sponsored by Nintendo,
Game Freak, Creatures or The Pokémon Company. Pokémon and Pokémon character names are trademarks of
their respective owners.
