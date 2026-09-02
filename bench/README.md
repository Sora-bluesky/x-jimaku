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

## 実Chromeでの訳質採取（live2・2026-09-01 に無人化）

CfT には翻訳モデルが降りないため、訳質の jaClauses は実 Chrome でしか採れない。
人手のリロードとタブ前面化は不要になった。

```
node bench/live2.mjs --case tts2 --duration 95
```

fixture サーバ起動・Chrome 起動・拡張インストール・設定投入・再生・overlay 収集・
result JSON 保存・機械ゲート出力までを 1 コマンドで行う。
`--case tts|tts2` / `--model` / `--backend` / `--chrome` / `--profile` / `--extension` で切替。

A-6-5 は次の値で表示を判定または観測する。

| 名前 | 判定・観測内容 |
|---|---|
| `pageLineReuse` | `0`。連続するページが同じ非空行を共有しない。 |
| `nonEmptyPageTransitions` | `1` 以上。`0` は `insufficient` として終了コード `1` にする。 |
| `twoPageCuesObserved` | 同じ cue でページ `0` と `1` を観測した件数。合否には使わない。 |
| `blankBarSamples` | `.caption-stack` が表示中かつ空だった連続区間数。合否には使わない。値の上昇は、その区間が増えたことを示す。 |
| `captureToReplayMs` | キャプチャーが `running` と報告してから、巻き戻した動画の再生が始まるまでの時間。合否には使わない。 |
| `firstCaptionMs` | 巻き戻した動画の再生開始から、表示中の最初の非空 `.caption-tentative` または `.caption-primary` までの時間。合否には使わない。 |
| `firstTentativeMs` | 巻き戻した動画の再生開始から、表示中の `.caption-tentative` が初めて非空になるまでの時間。合否には使わない。 |
| `firstFinalMs` | 巻き戻した動画の再生開始から、表示中の `.caption-primary` のいずれかが初めて非空になるまでの時間。合否には使わない。 |
| `tentativeToFinalMs` | `firstFinalMs - firstTentativeMs`。どちらかを観測できない場合は `null`。合否には使わない。 |
| `finalIntervalMsP50` | 連続する非空ページ遷移の間隔の中央値。合否には使わない。間隔を算出できない場合は `null`。 |
| `finalIntervalMsP90` | 連続する非空ページ遷移の間隔の90パーセンタイル。合否には使わない。間隔を算出できない場合は `null`。 |
| `slotCountViolations` | `0`。`.caption-primary` は常に2個。 |
| `cueIdMissing` | `0`。採取した表示サンプルに `cueId` がある。 |
| `pageIdMissing` | `0`。採取した表示サンプルに `pageId` がある。 |
| `stopDrainTimedOut` | `false`。明示停止から45秒後もチップが `RUNNING` なら `true` とし、終了コード `1` にする。 |

時間値はページ側の `Date.now()` を300msごとのサンプルと動画の再生開始時に記録して算出する。
`live2` はtentative段階を観測するため、採取時だけ `showTentative` を `true` にする。
`captureToReplayMs` には `running` 検出後の一時停止、滞留排出、動画の巻き戻しが含まれる。
`firstCaptionMs`、`firstTentativeMs`、`firstFinalMs` は、巻き戻した動画の再生開始を基準にする。
`schemaVersion` が `1` の既存結果では、同名の3項目が `running` 検出時刻を基準にしている。`schemaVersion` が `2` の結果と直接比較しない。
発話時刻を取得できないため、発話から字幕表示までの遅延は測定しない。

成立条件（いずれか欠けると無音で失敗するので消さないこと）:

- **モデル入りプロファイル**が要る。既定は `%TEMP%` 配下の `x-jimaku-builtin-ai-nano`
  （2026-08-27 の Gemma4/Nano 実験で DL 済み・約 4.1GB）。消すと数GB 再 DL になる。
  起動直後に `LanguageModel.availability()` を検査し、`available` でなければ即中断する。
- **pipe 接続**が要る。CDP の `Extensions` ドメインは `--remote-debugging-port` には出ない。
  `puppeteer.launch({ pipe: true })` + `--enable-unsafe-extension-debugging`（2 つ同時に
  検証済み・個別の要否は未切り分け）。
- **拡張は `Extensions.loadUnpacked` で入れる**。**ブランド版 Chrome は 137 で
  `--load-extension` を削除した**（Chromium と Chrome for Testing には残っている）ので、
  Canary では `chrome://version` のコマンドラインに載っていても導入数 0 になる。
  毎回 dist/ を入れ直すのでリロードボタンは不要。
- **`puppeteer.defaultArgs()` は引数なしだと headless 既定を返す**（`--headless=new`・
  `--mute-audio`）。`ignoreDefaultArgs: true` と併用すると `headless: false` を無視して
  ヘッドレスで動き、拡張が入らない。`defaultArgs({ headless: false })` + `--headless` 除去が要る。
- **puppeteer 既定の `--disable-features=` 一式と `--disable-background-networking` を外す**。
  残すと Optimization Guide が死んでモデルが永遠に `unavailable` になる。
- **fixture は 1 タブだけで開く**。bench テンプレの `<video>` は `muted` なので、背面に回ると
  Chrome が「音声のない動画」として省電力停止する（"video-only background media was paused"）。
  再生は `--autoplay-policy=no-user-gesture-required` で実クリック不要。

計測環境は Canary + 専用プロファイルで、日常使いの Chrome Stable とは別物である。
ゲート判定はここで回し、リリース検収の体感確認だけ Stable で行う。

採点は上記「日本語訳質の採点」と同じ（agy はプロンプト直埋め・ツール使用禁止を明示する）。

### 手動採取（Stable での確認用フォールバック）

1. `node bench/serve-standalone.mjs <case>` で fixture サーバだけを起動する（8123 固定）。
2. 拡張を読み込んだ実 Chrome で `http://127.0.0.1:8123/case.html` を開く。**タブを前面にする**
   （背面だと上記の理由で再生が止まる）。
3. `window.postMessage({t:'CS_DEV_SET_SETTINGS', settings:{...}})` と `{t:'CS_DEV_TOGGLE'}` で
   切替。**settings の反映は fire-and-forget**（`src/background/index.ts:427`）なので、
   設定投稿からトグルまで 2 秒以上空け、意図した backend で動いていることを確認してから採用する。
4. **モデルが cold のときは fixture を先に再生しない**。トグル後に「字幕ON」へ達するまで動画を
   一時停止し、到達後に `currentTime = 0` へ巻き戻してから再生する。
5. overlay の shadow DOM から `.caption-primary` を 300ms 間隔で重複排除しつつ収集し、
   `recognition.jaClauses` に詰めた result JSON を `bench/results/live2-*.json` として保存する。

ベースライン（2026-08-30・95 秒ループ採取）: prompt-api/base = 誤訳10/欠落1/不自然10 (n=32)、
translator/base = 6/2/7 (n=21)。judge ノイズはカテゴリ ±2・合計 ±2（同一採取の2回採点で実測）。
