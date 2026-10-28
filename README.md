# Exercise Timer

A large-number rep and hold timer for exercising a few feet from a screen, with saved presets.

- **Windows app** (Python + tkinter, standard library only): `dist\ExerciseTimer.exe`
- **iPhone / iPad web app** (plain HTML, CSS, JavaScript, works offline once installed): <https://mancedavis.github.io/exercise-timer/>
  Install steps for non-programmers: [docs/IOS_Install_Instructions.txt](docs/IOS_Install_Instructions.txt)

Both apps share the same exercise rules and the same preset file format, so presets move between them
as `.json` files. Nothing syncs automatically and nothing is sent anywhere.

## Exercise rules (both apps)

Sets, Reps and Hold each have an on/off checkbox.

| Setting off | Behaviour |
|---|---|
| Sets | One ungrouped set; set numbers hidden |
| Reps | Reps continue until **End Set** (also works during a rep break) |
| Hold | Manual rep stopwatch counting up until **Finish Rep**; never advances by itself |

Hold time counts up; get-ready, rep breaks and set rests count down. A rep break happens only between
reps of one set, set rest only between sets, get-ready once at the start; a break or rest of 0 is skipped.
Pause freezes the exact phase; Stop/Reset restores the starting counters. Settings and presets are locked
during a run. If the app is not updated for more than 2 seconds (computer sleep, a frozen page), it pauses itself.
A late timer callback never skips reps or shortens later phases; each phase starts when its predecessor is
noticed, so boundaries can drift by up to about 50 ms per phase (about 0.3 s over the 51 s example in the web app).

## Preset file format (version 1)

The same shape as the Windows `%APPDATA%\ExerciseTimer\presets.json`:

```json
{
  "version": 1,
  "presets": {
    "<preset name>": {
      "name": "<exercise name shown on screen>",
      "sets_enabled": true,  "sets": 3,
      "reps_enabled": true,  "reps": 10,
      "hold_enabled": true,  "hold": 10,
      "rep_break": 5,
      "rest_enabled": false, "rest": 30,
      "get_ready": 5
    }
  }
}
```

- The Windows file also has `"sound"` and `"last"`; they are ignored on import (an import never changes preferences).
- Export writes only `version` and `presets`, so exports and the full Windows file are both importable by both apps.
- Limits (validated before anything changes): file 256 KB, 500 presets, names 1-80 characters without leading or
  trailing spaces, sets/reps 1-9999, holds 1-86400 s, breaks/rests/get-ready 0-86400 s, every field present with the
  right type (whole numbers, real booleans), `version` exactly 1, no duplicate names (names compare ignoring case).
- Import adds new names; for an existing name you choose Replace, Skip or Cancel (decisions are collected first,
  then saved as one operation; a failed save or Cancel changes nothing). The result reads "3 added, 1 replaced, 2 skipped".

## Windows app

```
python main.py                 run from source
build.bat                      run the Python tests, then build dist\ExerciseTimer.exe (creates .venv)
build.bat skip-tests           build only
python -m unittest discover -s tests -t .
python main.py --self-test out.txt   (or ExerciseTimer.exe --self-test out.txt) checks window, storage, export/import
```

Presets live in `%APPDATA%\ExerciseTimer\presets.json`, outside the executable. To update, replace the old
`ExerciseTimer.exe` with the new one; presets are untouched. Keys: Space start/pause/resume, N Finish Rep,
E End Set, F11 / Esc full screen. A damaged presets file is kept as `presets.json.bad-<timestamp>`.

## Web app (`docs/`)

GitHub Pages serves `docs/` from the `main` branch at `/exercise-timer/`. All paths are relative; there is no build step.

```
npm install                         dev dependency: Playwright (browsers: npx playwright install webkit chromium)
npm test                            JavaScript unit tests (node:test, controlled clocks, shared fixtures)
npm run test:browser                WebKit + Chromium: layouts, offline, updates, import/export, interruptions
node tools/build-assets.mjs         regenerate the precache list and build id inside docs/sw.js (run after ANY change in docs/)
node tools/verify-live.mjs URL      check a deployed copy: same bytes, worker scope, "Offline ready", offline relaunch
node tools/make-icons.mjs           re-render docs/icons
python tools/gen_fixtures.py        regenerate fixtures/ from the Windows engine
```

How it behaves on a phone: the timer uses `performance.now()` and a 50 ms refresh; leaving the page or locking the
device pauses the workout ("Paused while away") and requires Resume; time away is never counted. A checkpoint is
saved at phase changes and every 5 seconds, so an app closed by iOS reopens paused at the last checkpoint (up to
about 5 seconds behind). The service worker only caches files (it is not a timer); an update installs in the background and
is applied only when you tap "Update now" while no exercise is running. Sound is Web Audio started from a tap; the screen
wake lock is requested while running and released on pause or when the page is hidden.

## Tests

`fixtures/` holds synthetic data (no personal presets) used by both test suites: timing timelines produced by the
Windows engine (the 2 x 3 x 4 s example: 6 holds, 4 rep breaks, 1 set rest, 51 s), a Windows-format `presets.json`,
export files, conflict scenarios, and 36 malformed or unsupported files.

## Layout

```
exercise_timer/   engine.py (phases, timing) · store.py · transfer.py (import/export) · sound.py · ui.py
tests/            Python unittest suite          main.py  launcher and --self-test
docs/             web app, service worker, icons, IOS_Install_Instructions.txt
web_tests/        unit/ (node:test) and browser/ (Playwright)
fixtures/ tools/  shared synthetic test data and generators
```
