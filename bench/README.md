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
result JSON 保存・機械ゲート出力までを 1 コマンドで行う。フラグなしでは英語行オフとオンを直列で両方回す（表示の確認はこれ）。片方だけなら `--show-original` または `--no-show-original`。
`--case tts|tts2` / `--model` / `--backend` / `--chrome` / `--profile` / `--extension` で切替。
表示の数字に設定の名前が付いていないものは証拠にならない。

翻訳経路の報告時刻と準備時間は次の3値で観測する。いずれも巻き戻した動画の再生開始を0とし、再生前なら負数になる。`gates` オブジェクトへ保存するが、合否には使わない。

| 名前 | 観測内容 |
|---|---|
| `pathFirstReportedMs` | 最初の `SW_TRANSLATION_STATE` がページへ到着した時刻。経路が `none` の報告しかない場合も値を持ち、報告が一度もない場合は `null`。 |
| `pathReadyMs` | `path` が存在し、値が `none` ではない最初の `SW_TRANSLATION_STATE` がページへ到着した時刻。利用可能な経路の報告がない場合は `null`。 |
| `pathReadyToFirstJapaneseMs` | `firstJapaneseMs - pathReadyMs`。どちらかを観測できない場合は `null`。利用可能な経路が早く報告されたのに日本語字幕が遅い場合、遅延箇所は後段の句の締切処理か `assembler` にある。利用可能な経路の報告自体が遅い場合、遅延箇所はモデル側にあり、句を並べ替えても短縮できない。 |

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
| `primaryClipped` | `0`。`primaryClippedVertical + primaryClippedHorizontal`。既存ゲート。 |
| `cueIdMissing` | `0`。採取した表示サンプルに `cueId` がある。 |
| `pageIdMissing` | `0`。採取した表示サンプルに `pageId` がある。 |
| `stopDrainTimedOut` | `false`。明示停止から45秒後もチップが `RUNNING` なら `true` とし、終了コード `1` にする。 |

| 名前 | 観測内容 |
|---|---|
| `bothRowsEnglish` | 原文行が表示され、主字幕が空ではなく、日本語文字を1文字も含まない折り畳みブロック数。 |
| `rowsIdentical` | 主字幕2枠を空白で連結した文字列と原文行を、それぞれ `trim()` した後に比較して一致した折り畳みブロック数。 |
| `originalRowShown` | 表示中かつ原文行が非空だった折り畳みブロック数。ほか3値の分母。 |
| `originalWithoutPrimary` | 原文行が表示されている一方で、主字幕2枠が両方とも空だった折り畳みブロック数。 |

4値はいずれも同じ表示が続く300msサンプルを1ブロックに折り畳んだ観測値で、合否には使わず、`rowsIdentical`または`bothRowsEnglish`が0でなければ、視聴者には字幕が二重に表示されたと知覚される。

位置の観測値（合否には使わない）。sampler は 300ms ごとに先頭 `.caption-primary` の `getBoundingClientRect().top`（四捨五入）と `.caption-stack` の高さを記録する。A caption that moves while its text is unchanged reads to a viewer as a new caption.

| 名前 | 観測内容 |
|---|---|
| `observations.captionTopChanges` | 同一の先頭主字幕テキストのまま `top` が動いた回数。 |
| `observations.captionTopValues` | 観測した `top` の重複なし一覧。2値の往復が一目で分かる。 |
| `observations.stackHeightChanges` | バー高さが変わった回数。 |
| `observations.captionMeasure` | 折返しが `canvas`（実フォントの measureText）か `units`（文字単位の仮定）か。実機では `canvas`。合否には使わない。 |
| `observations.captionLineMeasure` | 行スロットが `font`（`fontBoundingBoxAscent + fontBoundingBoxDescent`）か `constant`（`PRIMARY_LINE_HEIGHT`）か。実機では `font`。合否には使わない。 |
| `observations.primaryClippedVertical` | 非空の `.caption-primary` で `scrollHeight > clientHeight + 1` だった件数。合否には使わない。 |
| `observations.primaryClippedHorizontal` | 非空の `.caption-primary` で `scrollWidth > clientWidth + 1` だった件数。合否には使わない。 |
| `observations.phraseBoundaryRate` | 表示された行の改行のうち、BudouX（`.references/budoux`）の文節境界に落ちた割合。合否には使わない。文節境界での折返しは別変更であり、入るまでこの値は現行付近のままになる想定。 |
| `observations.phraseBoundarySamples` | その割合の**分母**（走行中の改行回数）。1 走行で 4〜15 回しか出ないことがあり、分母を見ずに率だけ読むと 4 回の全一致を「100%」と書いてしまう。率を引用するときは必ず添えること。 |
| `observations.placeholderSurvivalRate` | マスクしてモデルへ送った占位子のうち、訳文に受理形で戻ってきた割合。合否には使わない。復元成功とは別（重複は戻ったと数える）。 |
| `observations.placeholderSurvivalSamples` | その割合の**分母**（送った占位子の総数）。0 のとき率は `null`。率を引用するときは必ず添えること。 |
| `observations.glossaryLatinKept` | 英語側に KEEP_LATIN_TERMS の語があった節のうち、日本語出力にもその語がラテン文字で残っている件数。合否には使わない。 |
| `observations.glossaryLatinLost` | 英語側にあった語が日本語出力にラテン文字で残っていない件数。曖昧語では正しい判断のこともあるので、閾値にはしない。 |
| `observations.keepLatinSourceHits` | 英語原文（表示行または台本）に KEEP_LATIN 語が大小無視で出現した回数。マスク成否ではなく、認識側に名前があった回数。合否には使わない。 |
| `observations.maskedNameOccurrences` | 日本語出力に残った非曖昧 KEEP_LATIN 語のラテン文字出現回数。マスクして復元した語は必ずここに入る。合否には使わない。 |
| `observations.katakanaNameHits` | 日本語出力における既知のカタカナ音訳の出現回数。下がるべき値。合否には使わない。内訳は次の2値の合計。音訳は英語の語に紐付け、桶は glossary.data.ts の `ambiguous` 印が決める。 |
| `observations.katakanaNameHitsAmbiguous` | そのうち `ambiguous` の語に紐付けた音訳。証拠付きで止めるべき漏れ。合否には使わない。 |
| `observations.katakanaNameHitsPlain` | そのうち非曖昧語に紐付けた音訳。マスク穴。合否には使わない。 |

診断ログは次の観測値として保存する。いずれも合否判定には使わない。

| JSONフィールド | 内容 |
|---|---|
| `diagnostics.devLog[]` | `OFF_DEV_LOG`の`t`、`level`、`tag`、`message`、`data`を受信内容のまま保存する。 |
| `diagnostics.devLog[].timestampMs` | `handleOffscreenDevLog`が`performance.now()`で付ける単調増加時刻。 |
| `diagnostics.devLog[].arrivalMs` | `replayStartedAtMs`を0としたページ到着時刻。単位はミリ秒。 |
| `diagnostics.translationState[]` | ページへ転送された `SW_TRANSLATION_STATE` を受信内容のまま保存する。 |
| `diagnostics.translationState[].timestampMs` | content script がページへ転送するときに `performance.now()` で付ける単調増加時刻。 |
| `diagnostics.translationState[].arrivalMs` | `replayStartedAtMs`を0としたページ到着時刻。単位はミリ秒。 |
| `diagnostics.translationPaths` | 報告された `path` を初出順に並べ、重複を除いた配列。`path` がない報告は含めない。 |
| `diagnostics.clauseTimings[]` | `data.kind`が`clause-timing`の開発ログを受信内容のまま保存する。`data`は`lineId`、`outcome`、`path`、`enqueueToTerminalMs`、`modelCallMs`、`deadlineExpired`を持つ。 |
| `diagnostics.primaryClippedExample` | 最初に観測したクリップ1件。`text`、`scrollWidth`、`clientWidth`、`scrollHeight`、`clientHeight`。クリップがなければ `null`。 |
| `gates.clauseTimingSamples` | 有効な`enqueueToTerminalMs`の件数。 |
| `gates.clauseTranslateMsP50` | 句をキューへ入れてから翻訳またはフォールバックが確定するまでの時間の中央値。標本がない場合は`null`。 |
| `gates.clauseTranslateMsP90` | 同じ時間の90パーセンタイル。標本がない場合は`null`。 |
| `gates.clauseDeadlineHits` | 12秒の締切で`fallback`になった句の件数。 |
| `gates.devLogQueueDrop`、`gates.devLogRescueFailure`、`gates.devLogPassthrough` | `data.kind`が`queue-drop`、`rescue-failure`、`passthrough`だった件数。 |
| `gates.devLogOther` | 既知の4種類以外または`data.kind`がない診断ログの件数。 |
| `gates.englishPassthrough` | 表示台帳の文字列のうち、日本語文字を1文字も含まない件数。 |

`clauseTranslateMsP90`が12秒の締切に近い場合、遅い方の英語行は翻訳待ちで時間を使い切り、原文のまま解放されやすい。
`devLogQueueDrop`が増えた場合、検証に失敗したのではなく、翻訳処理の負荷が高い間に句が破棄されている。

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
