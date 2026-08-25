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
