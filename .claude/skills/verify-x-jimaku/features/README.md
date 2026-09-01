# x-jimaku verification map

This directory is the maintained source for verifying x-jimaku's user-facing behavior. Read this index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Build first: `npm run build` (both vite passes must complete; `dist/manifest.json` is the ready signal).
- Scripted checks (`bench-offline-e2e`) need no manual setup — the harness loads `dist/` into a disposable Chrome profile itself.
- Manual checks (`live-subtitle-overlay`, `toggle-controls`, `model-selection`, `options-page`) need the extension loaded unpacked via `chrome://extensions` → Developer mode → Load unpacked → `dist/`, and a real x.com tab with a playing video with audio.
- Never drive a manual check against a `dist/` that was not just rebuilt and reloaded (🔄 in `chrome://extensions`) — a stale service worker silently serves old code.
- Port `127.0.0.1:8123` is reserved for the bench server; do not run the bench while anything else holds that port, and do not treat 8123 traffic in a manual session as expected (the content script also matches `http://127.0.0.1:8123/*` for bench purposes only).

## Driving conventions

- Prefer the scripted paths wherever a feature is reachable through them: `node bench/run-bench.mjs ...` for the ASR pipeline (CfT, no translation), `node bench/live2.mjs ...` for ASR → translation → overlay in real Chrome against the fixture page (no x.com DOM).
- Every other feature is manual-only in real Chrome. State this plainly in the feature file rather than pretending a script covers it.
- Treat every command in these files as literal — do not "improve" flags or paths while driving.
- Capture the action and the resulting state, not just a final screenshot: for the bench, that means the full stdout table plus the result JSON path; for manual checks, a screenshot showing both the trigger (click, keypress, video state) and the resulting chip/badge/panel state.

## Proof and skip reporting

- Bench proof = exit code, the `[bench] result:` line on stderr, and the resulting JSON file's parsed numeric metrics (see the skill's Evidence section — no thresholds exist, record observed values).
- Manual proof = a screenshot or recording showing the actual chip/badge text against a real x.com video, not a mocked DOM.
- Record which feature ID and entry point were used with every artifact.
- Report an unreachable path with the attempted command/action and the unmet precondition (e.g. "CfT cannot download the Translator pack, so options-page Translator diagnostics could not be exercised in the scripted profile").
- Do not report a manual-only feature as verified because the bench passed — they exercise different code paths entirely.

## Census (run before trusting this map)

The map drifts when a script is added to `bench/` or `package.json` without a matching entry here — that is how `live2.mjs` was described as impossible for a day. Before driving, enumerate and reconcile:

```bash
ls bench/*.mjs; grep -o '"[a-z:-]*": *"node bench[^"]*"' package.json
```

Every `bench/*.mjs` and every `bench:*` npm script must be named in exactly one of: a feature file's `Driving it` section, or the exclusion list below. Anything unlisted is drift — stop and update the map (or the exclusion list) before reporting a feature as manual-only.

Exclusions (libraries and CI-only helpers, never run by a verifier): `bench/metrics.mjs` (scoring library used by `run-bench.mjs`), `bench/assert-smoke.mjs` (CI smoke assertion), `bench/serve.mjs` (fixture server started by the harnesses). Entry points a verifier runs — `run-bench.mjs`, `live2.mjs`, `score-ja.mjs`, `serve-standalone.mjs` — must each have a `Driving it` bullet in a feature file. The npm scripts `bench:smoke` and `bench:quality` are aliases of the two `run-bench.mjs` commands in `bench-offline-e2e.md`.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior, then uses exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with <harness>`, `Gotchas`.

## Features

- [Bench offline E2E](./bench-offline-e2e.md) — the only scriptable path: replays a fixed audio fixture (`tts`, or `tts2` for proper-noun recall) through the real offscreen ASR pipeline and scores it against a reference transcript.
- [Live subtitle overlay](./live-subtitle-overlay.md) — the manual-only real-Chrome + x.com path: capture → ASR → sentence assembly → translation (with post-text proper-noun masking) → on-page Japanese subtitle bar, and why it cannot be automated.
- [Toggle controls](./toggle-controls.md) — the toolbar icon and `Ctrl+Shift+9` shortcut that turn subtitles on/off per tab, and the chip states a user sees.
- [Model selection](./model-selection.md) — choosing the ASR model (tiny/base/small/turbo) in the options page, the environment-based model recommendation hint, and the WebGPU→WASM fallback.
- [Options page](./options-page.md) — display settings (English original, tentative dimming), pipeline settings (source language, translation backend), translation-model preparation, and the Translator diagnostics panel.
