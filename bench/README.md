# Recognition accuracy bench

Build the extension first so the unpacked MV3 bundle is available in `dist/`.
Run TTS: `node bench/run-bench.mjs --case tts --model base --duration 90`.
Run Tibo: `node bench/run-bench.mjs --case tibo --model base --duration 90`.
`--model` defaults to `base`, and `--duration` defaults to 90 seconds.
Each run writes full JSON under `bench/results/` and prints a compact metrics table.
To add a case, add its media and reference metadata, then add a branch to `loadCase`.
Keep committed reference text and proper nouns beside the other files in `bench/refs/`.
The Tibo clip is fetched locally via `yt-dlp` and must never be committed.

## 日本語訳質の採点

1. `node bench/run-bench.mjs --case tts --model base --duration 90` を実行し、結果JSONを作る。
2. `node bench/score-ja.mjs prepare bench/results/<result.json>` で判定プロンプトを作り、表示されたパスを控える。
3. `agy -p "read_file ツールで <パス> を全文読み、その指示に従え" --print-timeout 10m > bench/work/judge-output.txt` で採点する。
4. `node bench/score-ja.mjs parse bench/work/judge-output.txt` を実行し、件数と合計をJSONで表示する。

## Known failure signatures

`Error: Execution context is not available in detached frame or worker ".../background.js"` from
`evaluateInServiceWorker` under `waitForCaptureRunning` means the MV3 service worker restarted mid-run:
exit 1 and no result JSON. Seen in 1 of 4 runs on 2026-08-27. Retry once on exactly this signature;
two consecutive failures of any signature are a real FAIL.
The `[bench] result: <path>` line goes to stderr (`console.error`, run-bench.mjs:1434-1436) while the
metrics table goes to stdout (`printMarkdownTable`, run-bench.mjs:1119-1131).
`--trace` writes a `.trace.log` beside the result JSON only inside the success path
(run-bench.mjs:1437-1439), so a run that dies earlier leaves no trace file.
`MODULE_NOT_FOUND` with exit 1 is operator error from the wrong cwd — run from the repo root.
The full verification recipe lives in `.claude/skills/verify-x-jimaku/SKILL.md`.
