# Bench offline E2E

The bench harness replays a fixed audio fixture through the extension's real offscreen ASR pipeline inside a disposable, Puppeteer-driven Chrome instance, and scores the transcript against a reference. It is the only feature in this map that a script can drive end to end without a human touching a browser.

## Sub-features

- `bench-tts-smoke` runs the self-contained `tts` case at the `tiny` model for a fast pass/fail check.
- `bench-tts-quality` runs the `tts` case at the `base` model over the full 90s duration and records observed WER/recall/fragment metrics.
- `bench-result-artifact` produces a timestamped result JSON plus a stdout markdown metrics table.
- `bench-trace` captures the offscreen document's console output to a sibling `.trace.log` file (path echoed on stderr) for debugging.
- `bench-tts2-proper-nouns` runs the second self-contained case (`tts2`, added 2026-08-30) whose reference carries a hard-coded proper-noun list (`Roman`, `NASA Goddard`, `Kennedy Space Center`, `coronagraph` — `bench/run-bench.mjs:397-420`), so `properNounRecall` is actually numeric there, unlike `tts`.
- `bench-tibo` (needs external material staged into `bench/work/` first — confirm before attempting; not self-contained like `tts`/`tts2`).

## How to get to it (user POV)

- Run `node bench/run-bench.mjs --case <tts|tts2> --model <tiny|base|small|turbo> --duration <seconds>` from the repo root.
- There is no UI entry point — this is a CLI-only, script-driven path.

## Driving it with bench

Preconditions:

- `npm run build` has just completed; `dist/manifest.json` exists.
- Port `127.0.0.1:8123` is not already `LISTEN`ing.
- `bench/refs/tts-speech.wav` (and its paired `tts-ja-ref.txt`/`tts-script.txt`) exist.
- `~/.cache/puppeteer/chrome/` has a usable Chrome (or pass `--chrome <path>` / set `BENCH_CHROME` if not).

- **Smoke run.** Run `node bench/run-bench.mjs --case tts --model tiny --duration 30`. Exit code `0`; **stderr** carries the `[bench] result: bench/results/tts-tiny-<timestamp>.json` line (the metrics table is what goes to stdout) — capture both streams, or merge them, when scripting the proof check.
- **Quality run.** Run `node bench/run-bench.mjs --case tts --model base --duration 90`. Same shape as above, plus a markdown table on stdout with `wer`, `werFiltered`, `pnRecall`, `fragmentRate`, `clauses` columns.
- **Debug run.** Add `--trace` to either command above. Offscreen-document console lines are written to a `.trace.log` file next to the result JSON, and its path is echoed on stderr as `[bench] trace: <path>` — nothing appears inline. The trace file is only written after a successful result, so a run that dies before producing the JSON leaves no trace file; for those failures, the error output on stderr is the only evidence.
- **Argument error.** Run with an unrecognized flag, e.g. `node bench/run-bench.mjs --bogus`. Exit code `2` (distinct from a run failure, which is exit `1`).
- **Proper-noun run.** Run `node bench/run-bench.mjs --case tts2 --model base --duration 90` when proper-noun recall itself is under review — `tts2` is the only case whose reference scores it (`properNounTotal > 0`); on `tts` the field is always `null`.
- **Proof.** Open the JSON path from the `[bench] result:` line. Confirm it parses and its `metrics` object has numeric `wer`, `werFiltered`, `fragmentRate`, and `clauseStats.count >= 1`. `metrics.properNounRecall` is `null` (with `properNounTotal: 0`) whenever the reference text has no proper nouns to score — that is expected for `tts`, not a failure (for `tts2` a numeric value is expected). Record the observed numbers — there is no pass/fail threshold on them.

## Gotchas

- The bench server binds `127.0.0.1:8123` fixed — two runs cannot be driven concurrently; the second fails on port conflict. `bench/live2.mjs` (the unattended real-Chrome translation-quality capture) and `bench/serve-standalone.mjs` (fixture server only, for the manual Stable fallback) both bind the same port, so neither can coexist with a bench run.
- The `tibo` case is not self-contained (needs a fetch step into gitignored `bench/work/`) — don't run it without first confirming that material is staged, or it will fail for a reason unrelated to the extension itself.
- `--model` defaults to `base` and `--duration` defaults to `90` if omitted — a bare `--case tts` is a 90-second run, not instant.
- This case exercises ASR only. It does not touch the Translator API, the content-script overlay DOM, or real x.com — see `live-subtitle-overlay.md` for those.
- A stale `dist/` (forgot to rebuild) produces a run that "passes" against old code — always rebuild immediately before driving.
