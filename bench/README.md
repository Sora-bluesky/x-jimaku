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

## 実Chromeでの訳質採取（live2 手順・2026-08-30 確立）

CfT には翻訳モデルが降りないため、訳質の jaClauses は実 Chrome でしか採れない。

1. `node bench/serve-standalone.mjs` で fixture サーバだけを起動する（8123 固定）。
2. 拡張を読み込んだ実 Chrome で `http://127.0.0.1:8123/case.html` を開く。再生開始はタブ前面 + 実クリックが要る（autoplay ポリシー）。
3. DEV origin なので `window.postMessage({t:'CS_DEV_SET_SETTINGS', settings:{...}})` と `{t:'CS_DEV_TOGGLE'}` で backend/model 切替とトグルを scripting できる。**settings の反映は fire-and-forget**（`src/background/index.ts:427` → capture は storage を独立に snapshot する）なので、設定投稿からトグルまで 2 秒以上空け、採取開始後に出力の文体か options ページの翻訳経路表示で意図した backend で動いていることを確認してから採用する。
4. **モデルが cold のときは fixture を先に再生しない**。ハーネスと同じく、トグル後に「字幕ON」へ達するまで動画を一時停止し、到達後に `currentTime = 0` へ巻き戻してから再生する（先に流すと最初のループ分の音声が採取から欠ける）。warm なら省略可（2026-08-30 のベースラインは warm・チップは即 字幕ON）。
5. overlay の shadow DOM から `.caption-primary` を 300ms 間隔で重複排除しつつ収集し、`recognition.jaClauses` に詰めた result JSON を `bench/results/live2-*.json` として保存する。
6. あとは上記「日本語訳質の採点」と同じ（agy はプロンプト直埋め・ツール使用禁止を明示する）。

ベースライン（2026-08-30・95 秒ループ採取）: prompt-api/base = 誤訳10/欠落1/不自然10 (n=32)、
translator/base = 6/2/7 (n=21)。judge ノイズはカテゴリ ±2・合計 ±2（同一採取の2回採点で実測）。
