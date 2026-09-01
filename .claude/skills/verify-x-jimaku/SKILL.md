---
name: verify-x-jimaku
description: "Drive and verify x-jimaku, a Chrome MV3 extension that live-transcribes and translates X (Twitter) video audio into an on-page Japanese subtitle overlay. Use for /verify-x-jimaku, \"verify the extension\", \"run the bench\", or before claiming any change to capture, ASR, translation, or overlay behavior actually works."
---

# Verify x-jimaku

x-jimaku is a Chrome MV3 extension (offscreen ASR via `@huggingface/transformers`, content-script overlay, Chrome Translator API) that overlays live Japanese subtitles on X.com video audio. This skill drives the one scriptable verification path — the offline bench harness — and documents the manual real-Chrome path the harness cannot reach.

Two verification tiers exist and neither substitutes for the other:

1. **Scripted (this skill drives it):** `bench/run-bench.mjs` — a Puppeteer-driven, disposable-profile harness that loads `dist/` and replays a self-contained audio fixture through the real ASR pipeline. No manual step required. Proves ASR quality (WER, proper-noun recall, fragment rate) end to end.
2. **Manual only (documented, not automatable):** real Chrome + x.com playback. Required for anything the bench cannot reach — see `features/live-subtitle-overlay.md` for why (Chrome for Testing's Translator pack download never completes, so translation quality and the on-page overlay must be eyeballed in the user's real Chrome).

Never report "verified" for translation quality or overlay UI based on the bench run alone — it exercises tts/tibo ASR only, not the Translator path or the DOM overlay.

## Launch

Build before every verification run — a stale `dist/` teaches wrong steps:

```
npm run build
```

This runs `vite build` (main bundle) then `vite build -c vite.config.iife.ts` (content script, IIFE, `emptyOutDir: false` — the second pass adds `content.js` without deleting the first pass's output). Confirm both passes wrote to `dist/` before driving anything.

- **Ready check:** `dist/manifest.json` exists and its `version` matches `public/manifest.json` (or is newer than the previous run's copy).
- **For the scripted path:** no separate launch step — `bench/run-bench.mjs` starts its own bench server (`127.0.0.1:8123`, fixed port) and its own disposable Chrome profile per invocation, and tears both down itself (`finally` block). Do not pre-start anything.
- **For the manual path:** open `chrome://extensions`, enable Developer mode, "Load unpacked" → the repo's `dist/` directory. After any rebuild, click the extension's reload icon (🔄) in `chrome://extensions` — a stale service worker survives a `dist/` overwrite otherwise. Then reload every already-open x.com test tab as well: the retired content script leaves `window.__xJimakuContentScriptVersion__` set, and since a rebuild keeps the same version, the freshly injected replacement treats itself as a duplicate and never initializes (`src/content/index.ts:265-279`) — manual checks then time out against a disconnected content script.
- **Teardown:** the scripted path self-terminates. For the manual path, remove the unpacked extension from `chrome://extensions` when done, or leave it if further manual checks follow in the same session.

## Doctor

Read-only, run before any drive:

- `dist/manifest.json` exists (build actually ran and produced output).
- A Chrome for the bench is resolvable through any of the three supported sources: a `--chrome <path>` you will pass, a set `BENCH_CHROME` env var, or `~/.cache/puppeteer/chrome/` containing at least one `chrome/win64-*` (or platform-equivalent) directory. Any one of them satisfies this check — an explicit `--chrome`/`BENCH_CHROME` does not need the cache to exist.
- Port 8123 is not already `LISTEN`ing (the bench server binds it fixed; a stale process from a prior killed run blocks the next one).
- `bench/refs/tts-speech.wav` exists (the `tts` case is self-contained on this file plus `tts-ja-ref.txt`/`tts-script.txt`; without it the `tts` case cannot run at all).

If any check fails, fix it before driving (rebuild, free the port, restore the refs directory) rather than reporting a false pass or a false failure.

## Drive

Harness: `node bench/run-bench.mjs --case <tts|tts2|tibo> --model <tiny|base|small|turbo> --duration <seconds>`.

- Chrome resolution order: `--chrome <path>` → env `BENCH_CHROME` → auto-discovery under `~/.cache/puppeteer/chrome/**` (this machine has `win64-149.0.7827.22`, so no override is normally needed).
- Every run gets a fresh `mkdtemp` profile loaded with `--load-extension` pointed at `dist/` — never the user's real Chrome profile. Runs do not share state and cannot corrupt a manual session.
- `--model` defaults to `base`, `--duration` defaults to `90` (seconds), `--backend` defaults to `prompt-api` (values: `auto`/`translator`/`prompt-api`; `DEFAULT_BACKEND`, `bench/run-bench.mjs:37`). Unknown arguments exit with code `2` (argument error), distinct from a run failure (exit `1`).
- Add `--trace` to capture the offscreen document's console output — it is written to a `.trace.log` file next to the result JSON (path echoed on stderr as `[bench] trace: <path>`), not inline. Use this whenever a run needs debugging, not just on the smoke pass.

Standard invocations:

- **Smoke (fast, use for "does it still run"):** `node bench/run-bench.mjs --case tts --model tiny --duration 30`
- **Quality observation (use for ASR metric review):** `node bench/run-bench.mjs --case tts --model base --duration 90`

The `tts` case is self-contained (`bench/refs/tts-speech.wav`, 14.1s at 22050Hz / 608KB, plus reference text) and is the case to reach for by default. The `tts2` case (added 2026-08-30) is also self-contained (`bench/refs/tts2-speech.wav` / `tts2-script.txt` / `tts2-ja-ref.txt`) and carries a hard-coded proper-noun list (`Roman`, `NASA Goddard`, `Kennedy Space Center`, `coronagraph` — `bench/run-bench.mjs:397-420`) so `properNounRecall` is actually scored there, unlike `tts` where it is `null`. There is no CLI flag to supply terms — the list lives in `loadCase`. The `tibo` case needs additional material fetched into `bench/work/` (gitignored) first — do not attempt it without confirming that material is present.

Translation quality is measured separately, because Chrome for Testing ships no built-in AI: `node bench/live2.mjs [--case tts|tts2] [--duration 95]` runs the whole real-Chrome capture unattended (`bench/live2.mjs`), installing the current `dist/` over CDP and printing the mechanical gates. `node bench/serve-standalone.mjs [tts|tts2]` starts only the fixture server for the manual fallback used to check against Chrome Stable. Both bind the same fixed port 8123 and conflict with a concurrent `run-bench.mjs`. Procedure and prerequisites: `bench/README.md` (live2 節).

Only one bench run at a time: the server binds `127.0.0.1:8123` fixed, so a second concurrent invocation fails on port conflict rather than running in parallel.

**Known transient (observed 2026-08-27, 1 of 4 runs):** the run can die at startup with `Error: Execution context is not available in detached frame or worker "chrome-extension://.../background.js"` from `evaluateInServiceWorker` → `waitForCaptureRunning` (`run-bench.mjs:911/864`) — the MV3 service worker restarted under the harness's feet. Exit code is `1` and no result JSON is written. On exactly this signature, retry once; two consecutive failures of any signature are a FAIL to report, not a thing to retry past. Run the harness from the repo root — a wrong cwd fails with `MODULE_NOT_FOUND` (exit `1`), which is an operator error, not a harness failure.

## Evidence

- **PASS is structural, not threshold-based:** (1) process exit code `0`, (2) stderr contains a `[bench] result: <path>` line (the metrics table goes to stdout; the result path goes to stderr), (3) the JSON file at that path exists, parses, and its `metrics` object has numeric `wer`, `werFiltered`, `fragmentRate` (from `bench/metrics.mjs`'s `computeMetrics`) — `properNounRecall` is `null`/`n/a` when the reference has no proper nouns to score (confirmed: a `tts` run with `properNounTotal: 0`), so treat a `null` there as expected, not a failure, (4) `metrics.clauseStats.count` is at least 1 — a zero-clause result means the fixture produced no transcript and the run did not exercise anything. Verified 2026-08-27: `node bench/run-bench.mjs --case tts --model tiny --duration 30` exited `0`, wrote `bench/results/tts-tiny-20260827-140331.json` with `metrics: {wer, werFiltered, fragmentRate, clauseStats.count: 6, properNounRecall: null, properNounTotal: 0}`.
- **No quality thresholds exist in code.** Do not invent a WER/recall cutoff and call it a gate. Record the observed metrics (also echoed as a markdown table on stdout) as a data point; a baseline only becomes meaningful once several runs accumulate. Report numbers, not verdicts, until the user sets a threshold.
- Result JSON lands at `bench/results/<case>-<model>-<YYYYMMDD-HHMMSS>.json` — this is timestamped and additive. Never overwrite or delete a prior result to "clean up."
- For the manual real-Chrome path, evidence is a screenshot or screen recording showing the overlay chip states (`字幕 準備中…N%` → `字幕ON`, or `対象外` on a non-target video) against actual x.com playback, per `features/live-subtitle-overlay.md`. A bench pass is not evidence for this path.

## Cleanup

- The bench script tears down its own Chrome instance and temp profile in a `finally` block — no manual browser cleanup needed after a normal or failed run.
- If a run was killed externally (Ctrl+C, timeout) and port 8123 is still `LISTEN`ing afterward, find and kill only the `node bench/run-bench.mjs` process this skill started (by PID from the command that launched it) — never kill by process name (`node`), which would also hit unrelated Node processes on the machine.
- Never delete `bench/results/*.json` as part of cleanup — those are evidence, not scratch state.
- `bench/work/` is gitignored scratch material for the `tibo` case; leave it unless the user asks to reclaim disk space.

## Helpers

No dedicated helper scripts ship with this skill — `bench/run-bench.mjs` (existing in the repo) is the harness itself and is invoked directly with the commands shown above. There is nothing here to reverse-engineer.
