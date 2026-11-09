# Recognition accuracy bench

Build the extension first so the unpacked MV3 bundle is available in `dist/`.
Run TTS: `node bench/run-bench.mjs --case tts --model base --duration 90`.
Run Tibo: `node bench/run-bench.mjs --case tibo --model base --duration 90`.
`--model` defaults to `base`, and `--duration` defaults to 90 seconds.
Both `run-bench` and `live2` accept `--backend plamo`
(the only backend, and the default) and `--plamo-model 0.8b|2b|8b` (default: `0.8b`).
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

PLaMoの翻訳とoverlayをfixtureで採取する。人手のリロードとタブ前面化は不要。

```
node bench/live2.mjs --case tts2 --duration 95
```

fixture サーバ起動・Chrome 起動・拡張インストール・設定投入・再生・overlay 収集・
result JSON 保存・機械ゲート出力までを 1 コマンドで行う。フラグなしでは英語行オフとオンを直列で両方回す（表示の確認はこれ）。片方だけなら `--show-original` または `--no-show-original`。
`--case tts|tts2` / `--model` / `--backend plamo` / `--plamo-model 0.8b|2b|8b` / `--chrome` / `--profile` / `--extension` で切替。
表示の数字に設定の名前が付いていないものは証拠にならない。

PLaMoの例: `node bench/live2.mjs --case tts2 --backend plamo --plamo-model 0.8b`。
PLaMoはWebGPUを使う。翻訳バックエンドの選択肢はPLaMoだけで、`--backend plamo`は省略できる。
サイズごとの初回にはGGUFをダウンロードする（0.8B: 573 MB、2B: 1.8 GB、8B: 5.3 GB）。
Phase 0のcold 2Bロードは288秒だった。`live2`は開発ログの`PLaMo download: loaded/total bytes`で受信バイト数の増加を監視し、進捗が続く間は待つ。
既存の`READY_TIMEOUT_MS`（120秒）の間、ダウンロードまたは初期化の進捗がなければエラーにする。
翻訳パスが`none`なら初期化失敗として終了し、`plamo`とcaptureのrunning状態を両方確認してから計測へ進む。
結果JSONの`backend`・`plamoModel`と`meta.backend`・`meta.plamoModel`に選択値を記録する。

各走行の結果には、`dist/build-info.json`から読んだ`build`と`nameTableHash`を記録する。このファイルが無い場合や、ディスク上の名前表がビルド時と異なる場合は、再ビルドを求めて停止する。前回ログを消去できたかは`captionLogCleared`に残す。`display.pages`には`replayStartedAt`以降に現れた字幕ログのページを保存し、時刻を解析できなかったページは`pagesUnparsed`に数える。

### service workerをbuild済みのdistと揃える

`live2`は`x-jimaku-bench-plamo`を再利用し、そのプロファイルに属するOPFSのモデルキャッシュを保持する。同じ`--profile`と拡張のパスを使うことで次回もキャッシュを使える。既定の`--profile`は一時ルート配下の`x-jimaku-builtin-ai-nano`（既存のPLaMoキャッシュを保持するため従来のルート名を維持）。

`Extensions.loadUnpacked`の後で、workerのbuild stampを`dist/manifest.json`の`version_name`と照合する。古いworkerが応答した場合はブラウザーを閉じ、安全確認後にプロファイルをリセットして一度だけ再起動する。削除できないときは時刻付きの代替ディレクトリを使い、その旨を出力と結果JSONの`profileDirectory`に残す。リセットした場合、モデルは再ダウンロードされる。再起動後もビルドが一致しない場合またはworker未起動なら、計測を始めず終了コード`1`で止まる。2026-09-05より前の結果は、古いworkerを測った可能性がある。

両ベンチは実行開始時に、一時ルート直下の残存プロファイルを掃除する。対象名の許可リストは`bench/temp-profiles.mjs`に置き、`run-bench`が作る`x-jimaku-accuracy-bench-`と英数字6文字の接尾辞に完全一致するディレクトリだけを削除する。削除したパスと失敗をログに残し、削除失敗では実行を中断しない。`live2`の`--profile`とその親子ディレクトリは保護し、シンボリックリンクは対象にしない。`bench/results/`と`bench/work/`の保持処理は変更しない。

字幕を1行も採取できなかった実行では、`gates`の識別情報（`displayConfig`・`showOriginal`・`displayCoverage`）を残し、それ以外の値をすべて`null`にして、結果のトップレベルに`gatesSuppressed: "no captured lines"`を記録する。未採取を問題件数`0`として扱わず、`0`だけで正常と判断しない。`score-ja.mjs prepare`と`assert-smoke.mjs`は、空でない文字列の`error`を持つ結果を拒否する。

## 名前表記コーパス

`node bench/naming-corpus.mjs`は`bench/results/live2-*.json`をすべて読み、`naming-corpus.json`と`naming-candidates.md`を結果ディレクトリへ書く。`--results`、`--out`、`--case`で入出力とケースを絞れる。

コーパスは状態ではない。走行JSONを正本として、実行のたびにゼロから作り直す。`recognition.jaClauses`または新形式の`display.lines`が空でない走行を取り込む。`error`がない走行と、`display gate `で始まるエラーだけを採用し、`gatesSuppressed`がある走行は除外理由を記録する。

名前表は`src/offscreen/glossary.data.ts`を`bench/work/name-table.mts`へバイト単位で複写し、SHA-256を記録してから読み込む。この読み込みはNodeの型除去に頼るので、集計はNode 22.18以降で動く（古いNodeでは理由を出して止まる）。新形式の`display.lines`と`display.pages[].sources`がある走行では出現率を計算する。旧形式の走行は生の表記件数だけを残し、率を`null`にする。

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
| `observations.phraseBoundaryRate` | 表示された行の改行のうち、npm パッケージ `budoux` 同梱の日本語モデルの文節境界に落ちた割合。合否には使わない。文節境界での折返しは別変更であり、入るまでこの値は現行付近のままになる想定。 |
| `observations.phraseBoundarySamples` | その割合の**分母**（走行中の改行回数）。1 走行で 4〜15 回しか出ないことがあり、分母を見ずに率だけ読むと 4 回の全一致を「100%」と書いてしまう。率を引用するときは必ず添えること。 |
| `observations.glossaryLatinKept` | 英語側に KEEP_LATIN_TERMS の語があった節のうち、日本語出力にもその語がラテン文字で残っている件数。合否には使わない。 |
| `observations.glossaryLatinLost` | 英語側にあった語が日本語出力にラテン文字で残っていない件数。曖昧語では正しい判断のこともあるので、閾値にはしない。 |
| `observations.keepLatinSourceHits` | 英語原文（表示行または台本）に KEEP_LATIN 語が大小無視で出現した回数。マスク成否ではなく、認識側に名前があった回数。合否には使わない。 |
| `observations.maskedNameOccurrences` | 日本語出力に残った非曖昧 KEEP_LATIN 語のラテン文字出現回数。合否には使わない。 |
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
| `gates.devLogQueueDrop`、`gates.devLogPassthrough` | `data.kind`が`queue-drop`、`passthrough`だった件数。 |
| `gates.devLogOther` | 既知の4種類以外または`data.kind`がない診断ログの件数。 |
| `gates.englishPassthrough` | 計測区間の表示ページ台帳にある主字幕の非空行のうち、日本語文字を1文字も含まない件数。全ソース行のASR確定時刻が`replayStartedAt`より後のページだけを数える。開発ログの有無には依存しない。 |

`devLogPassthrough`は情報値であり、`englishPassthrough`との一致は要求しない。品質比較には行単位の`englishPassthrough`を使う。
`observations.englishPassthroughSource`は`caption-display-log/asr-finalized-after-replay`。`wrongSenseRoma`、`unresolvedPlaceholders`、`romanKept`、`romanKeptInJapanese`も同じページの主字幕から数える。`display.pages[].sources[].finalizedAt`と`display.lines[].finalizedAt`には認識行の`at`を保存し、表示・受理時刻と区別する。時刻不明や対象ページなしはエラーにする。`gateWindow`に採用・除外の根拠を記録し、表示ログ自体は調査用に保持する。

`node bench/recount-gates.mjs <result.json>...`で同じ5項目を再集計する。旧形式では`lines.acceptedAt - clause.enqueueToTerminalMs`、`lines.acceptedAt`、`pages.appearedAt`（ページログがなければ`blocks.sampledAtMs`）の順に代用する。各ファイルの`timestampSources`は使用したフィールド別のソース参照数で、ページ数ではない。旧形式の推定値は台帳の解放・表示遅延を含み得るため、ASR確定時刻による厳密な比較とは区別する。

ウォームアップは同じキャプチャのまま動画を一時停止し、既存の静穏待機後に巻き戻して再生する。ウォームアップ中の診断は`diagnostics.warmupDevLog`に保持する。

`clauseTranslateMsP90`が12秒の締切に近い場合、遅い方の英語行は翻訳待ちで時間を使い切り、原文のまま解放されやすい。
`devLogQueueDrop`が増えた場合、検証に失敗したのではなく、翻訳処理の負荷が高い間に句が破棄されている。

時間値はページ側の `Date.now()` を300msごとのサンプルと動画の再生開始時に記録して算出する。
`live2` はtentative段階を観測するため、採取時だけ `showTentative` を `true` にする。
`captureToReplayMs` には `running` 検出後の一時停止、滞留排出、動画の巻き戻しが含まれる。
`firstCaptionMs`、`firstTentativeMs`、`firstFinalMs` は、巻き戻した動画の再生開始を基準にする。
`schemaVersion` が `1` の既存結果では、同名の3項目が `running` 検出時刻を基準にしている。`schemaVersion` が `2` の結果と直接比較しない。
`latency.utterances`は音声区切り→組み立てた句→実際に表示したページを結合した記録。`segmentIds`で音声区切りを参照し、`pages[].clauseIds`でページに含まれる句を参照する。句にまとめられなかった音声区切りも残す。時刻は`performance.timeOrigin + performance.now()`の絶対ミリ秒。音声の開始と区切り位置はPCM受信時の時計とサンプル位置から求める。`closeReason`に無音、長さ上限、終了・停止などの切断理由を残す。Whisperの確定とPLaMoの開始・終了はワーカー側で記録する。

`latency.summary.gapsMs`は`speechToClose`（1→2）、`closeToWhisper`（2→3）、`whisperToEnqueue`（3→4）、`enqueueToContext`（4→5）、`contextToPlamo`（5→6開始）、`plamo`（6開始→終了）、`plamoToDisplay`（6終了→7開始）、`closeToDisplay`（2→7開始）の標本数とp50/p90。句は既存ゲートと同じASR確定時刻が再生開始より後のものだけ集計する。句にならなかった区切りはWhisper確定時刻を使い、`captureTimeSource`で区別する。区切りの全体が閉じる前に一部の句を訳して表示する場合、段差は負になり得る。元の時刻と符号を保持する。

`latency.summary.missing`は`dropped`（翻訳キューで破棄）、`untranslated`（訳なしで確定）、`neverShown`（それ以外の未表示）を別に数える。`closeToDisplay`は区切り終了から表示までを計算できない対象数、`captureTime`は計測区間の判定時刻が欠けた記録数。未表示や時刻欠落を0msの標本にはしない。旧`latency.summary.r1`は`latency.summary.closeToDisplay`へ改名した。この診断値には合否を付けない。

R1の受入指標は`latency.r1Audio`。`refs/tts2-sentence-ends.json`と`refs/tts-sentence-ends.json`に、音声の無音開始位置を文末として保存している。`node bench/refs/regenerate-sentence-ends.mjs`で両方を再生成し、`--check`なら保存値と照合する（`ffmpeg`と`ffprobe`がPATHに必要。不在・検出文数の不一致はエラー）。検出は`silencedetect=noise=-35dB:d=0.25`、文末は0.75秒以上の無音の開始。tts2の0.41秒と0.43秒の休止は文中の読点なので除く。JSONには全無音、実行コマンド、閾値、WAV・台本のSHA-256、ループ長、対応する台本文と照合フレーズを記録する。

集計対象は親の再集計と同じ`observations.captionLogDwell.pages`（ASR確定時刻の計測窓に入り、表示終了を観測したページ）。各ページを`cueId`と`pageId`で表示ログへ結合し、`sourceText`が含む照合フレーズのうち台本順で最後の文を選ぶ。全文一致を要求しないので、部分的なASR句も照合できる。文末をE、ループ長をL、音声開始から表示までをTとすると、n=floor((T-E)/L)、遅延=T-(nL+E)。境界の丸め誤差を避けるため、文末表と同じマイクロ秒精度の整数で計算する。親の計算と同じく再生直後はnが負になる場合もある。標本はページごとで、照合できないページは`unmatchedPages`と理由別`unmatched`に数え、分位点には入れない。未照合があっても合否は照合済みページだけで判定する。未照合率と未表示・破棄の診断は別途確認する。

新規live2は再生要求前に`replayStartedAt`を記録し、`playing`イベント時の絶対時刻と`currentTime`（イベントが取れなければ`play()`完了時）を`mediaPlayback`へ保存する。音声開始は観測時刻-currentTimeとして補正する。これらがない旧結果では`replayStartedAt`を起点とし、再生開始の遅れを含む上限値として`clock.upperBound: true`を明示する。ループ中の停止・再生速度の変更はこの計測の対象外。

`latency.r1Audio`のp50/p90はミリ秒、分位点は整列後のfloor(q*N)番目（0起点）。閾値は`R1_LIMITS_MS`のp50≤3000ms、p90≤5000ms。合否`p50Pass`、`p90Pass`、`pass`はこの音声指標だけに付け、標本なしは`null`。`node bench/recount-gates.mjs <result.json>...`は保存した窓のページから同じ計算を行い、各実行の値と、全ファイルのページ標本を合わせた`TOTAL.r1Audio`を表示する。5回の受入判定にはこのプール値を使い、実行別の中央値を平均しない。必要な音声ページ証拠がないファイルも品質ゲートを表示し、`available: false`として`unavailableFiles`に数える。読込・解析に失敗したファイルは`failedFiles`に数え、終了コードを`1`にする。利用可能な音声標本とそのp50/p90は表示するが、`unavailableFiles`または`failedFiles`が1件でもあれば、`TOTAL.r1Audio.pass`は`null`（判定不能）にする。

`observations.captionLogDwell.pages`には実際に終了した各ページの`shownSeconds`、`characters`（Unicodeコードポイント数）、`charsPerSecond`、`lines`、`maxCharactersPerLine`を保存する。対象は同じASR確定時刻のゲートに入るページ。`openPages`は終了未観測のページ数で、終了を推測して表示時間を補わない。`observations.readingSpeed.above7`と`above4`はそれぞれ厳密に7文字/秒、4文字/秒を超えたページの件数・表示秒数・`pageShare`・`shownTimeShare`。分母は終了を観測できたページだけで、標本なしの割合は`null`。

成立条件（いずれか欠けると無音で失敗するので消さないこと）:

- **PLaMoにはWebGPUとモデル保存領域**が要る。初回は選択したGGUFをダウンロードし、以後は同じプロファイルのOPFSキャッシュを使う。
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
   設定投稿からトグルまで 2 秒以上空け、PLaMo が準備済みであることを確認してから採用する。
4. **モデルが cold のときは fixture を先に再生しない**。トグル後に「字幕ON」へ達するまで動画を
   一時停止し、到達後に `currentTime = 0` へ巻き戻してから再生する。
5. overlay の shadow DOM から `.caption-primary` を 300ms 間隔で重複排除しつつ収集し、
   `recognition.jaClauses` に詰めた result JSON を `bench/results/live2-*.json` として保存する。
