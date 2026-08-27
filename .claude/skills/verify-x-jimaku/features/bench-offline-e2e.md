# Bench offline E2E

The bench harness replays a fixed audio fixture through the extension's real offscreen ASR pipeline inside a disposable, Puppeteer-driven Chrome instance, and scores the transcript against a reference. It is the only feature in this map that a script can drive end to end without a human touching a browser.

## Sub-features

- `bench-tts-smoke` runs the self-contained `tts` case at the `tiny` model for a fast pass/fail check.
- `bench-tts-quality` runs the `tts` case at the `base` model over the full 90s duration and records observed WER/recall/fragment metrics.
- `bench-result-artifact` produces a timestamped result JSON plus a stdout markdown metrics table.
- `bench-trace` captures the offscreen document's console output inline for debugging a failing run.
- `bench-tibo` (needs external material staged into `bench/work/` first — confirm before attempting; not self-contained like `tts`).

## How to get to it (user POV)

- Run `node bench/run-bench.mjs --case tts --model <tiny|base|small|turbo> --duration <seconds>` from the repo root.
- There is no UI entry point — this is a CLI-only, script-driven path.

## Driving it with bench

Preconditions:

- `npm run build` has just completed; `dist/manifest.json` exists.
- Port `127.0.0.1:8123` is not already `LISTEN`ing.
- `bench/refs/tts-speech.wav` (and its paired `tts-ja-ref.txt`/`tts-script.txt`) exist.
- `~/.cache/puppeteer/chrome/` has a usable Chrome (or pass `--chrome <path>` / set `BENCH_CHROME` if not).

- **Smoke run.** Run `node bench/run-bench.mjs --case tts --model tiny --duration 30`. Exit code `0`; stdout ends with a `[bench] result: bench/results/tts-tiny-<timestamp>.json` line.
- **Quality run.** Run `node bench/run-bench.mjs --case tts --model base --duration 90`. Same shape as above, plus a markdown table on stdout with `wer`, `werFiltered`, `pnRecall`, `fragmentRate`, `clauses` columns.
- **Debug run.** Add `--trace` to either command above. Offscreen-document console lines appear inline in stdout, interleaved with the harness's own log lines.
- **Argument error.** Run with an unrecognized flag, e.g. `node bench/run-bench.mjs --bogus`. Exit code `2` (distinct from a run failure, which is exit `1`).
- **Proof.** Open the JSON path from the `[bench] result:` line. Confirm it parses and its `metrics` object has numeric `wer`, `werFiltered`, `fragmentRate`, and `clauseStats.count >= 1`. `metrics.properNounRecall` is `null` (with `properNounTotal: 0`) whenever the reference text has no proper nouns to score — that is expected for `tts`, not a failure. Record the observed numbers — there is no pass/fail threshold on them.

## Gotchas

- The bench server binds `127.0.0.1:8123` fixed — two runs cannot be driven concurrently; the second fails on port conflict.
- The `tibo` case is not self-contained (needs a fetch step into gitignored `bench/work/`) — don't run it without first confirming that material is staged, or it will fail for a reason unrelated to the extension itself.
- `--model` defaults to `base` and `--duration` defaults to `90` if omitted — a bare `--case tts` is a 90-second run, not instant.
- This case exercises ASR only. It does not touch the Translator API, the content-script overlay DOM, or real x.com — see `live-subtitle-overlay.md` for those.
- A stale `dist/` (forgot to rebuild) produces a run that "passes" against old code — always rebuild immediately before driving.
