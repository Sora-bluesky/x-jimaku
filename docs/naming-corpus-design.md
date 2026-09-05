# 設計: 固有名詞の表記コーパス（桶の規則・無人採取・受け入れ）

Status: rev5（設計案。敵対レビュー 5 巡を反映・実装未着手）
Date: 2026-09-05
Branch: `i91-design-rev5`（`8e226e9` = rev4 が main に入った merge を起点。rev2 の HEAD は `bae81f8`・rev3 の HEAD は `87e6617`）。読解の基準は `cfbcf4f`。
`scripts/build-stamp.mjs`（`4731eab`）は `i86-release-prep` にあり、本ブランチには未到達です（§4-4）。
本文が引く file:line に変更はありません。
関連: `docs/issue-49-design.md`（masking 方式の原理・誤義撲滅の裁定）/ `docs/issue-63-design.md`（DEV ログ中継）

rev5 で変えたこと:

- 実効テキスト（§5-0 D）の判定を `isRevision` から「表示する `primary` が実際に切り詰められたか」に変えました。
  改訂でも、翻訳どうしで日本語が前の行の日本語で始まらなければ overlay は**全文を追記します**（`overlay.ts:1087-1104`
  で `primary` は `fullPrimary` のまま）。rev4 はこの行を尾だけにしていたので、画面に再び出た接頭辞の名前が
  分母から消え、尾の出現に接頭辞の形を帰属させるか、新しく表示された誤形を数え漏らして `nameExpectedRate` を
  上げていました。§1-8 の事実も「表示は尾だけ」から直しました。
- A の Y を「表と `terms.txt` の和」から、`expected` を持つ名前に限りました（§5-0 A）。`expected` は表の状態で
  しか定義されておらず、`terms.txt` は英語綴りだけを持つので、rev4 の A-4 は表外の名前（tts2 の `coronagraph`）で
  計算できませんでした。表外の名前に `expected` を与えるのは §2-4 が「変えない」と言うページ由来の機構だけなので、
  `with` モードでページ由来になる `terms.txt` の語に限って原綴りを `expected` にし、それ以外の表外語は A の外
  （観測のみ）にしました。A-2 の `wrongKnown` も同じ Y を走るので、表外の語は `rejected`（表の行）を持たず
  スクリプト混在の 2 類だけで判定する、と書きました。`coronagraph` は小文字始まりで `extractPostContextTerms`
  が拾わず（`index.ts:2975`・`:2998`）、`with` でも守られていない語だったので、§5-3 の例からも外しました。
- `drops[]` に `droppedAt` を足し、`pages` / `lines[]` と同じ `replayStartedAtMs` の切りを検証の前に当てます
  （§4-1-6・§5-2 手順 1）。`cueId` と `sourceIds` しか持たない rev4 の形では、消去に失敗したログの前走行の drop や
  ウォームアップ中の drop が切れず、行 id は走行ごとに振り直されるので切った `lines[]` との突き合わせ（検証②）が
  別の走行の行に当たり得ました。

rev4 で変えたこと:

- 分母と合否の定義を §5-0 の 2 文（**D** と **A**）に 1 か所化し、他の節はそこを引くだけにしました。4 巡のレビューで
  見つかった欠陥はすべて「分母に何が入るか」と「合否が何を見られるか」の 2 点で、節ごとに言い直すたびに
  ずれていました（rev2 は `sources[].text` を改訂の尾に直したのに、rev3 の `lines[].text` は全文のまま）。
- 分母の行テキストを「受理した英語の全文」から「overlay が新規と判定した**実効テキスト**」に変えました（§5-0 D）。
  改訂（`overlay.ts:1079-1083`）の行は尾だけです。rev3 のままだと改訂の接頭辞の名前を 2 度数え、2 度目が
  `missing` に落ちます。`sources[].text` は同じ値の複写になり、集計は改訂を知らなくてよくなります。
- `recordLineAccepted` の位置を順序 guard（`:1056-1066`）の**後**に動かしました（§4-1-6）。rev3 の位置では
  そこで捨てられた行（cue を作らない）が分母に入り `missing` になります。そこから `createCueSegments`
  （`:1124`）までに他の早期 return が無いことを読んで確かめました。
- 合否に「対象以外の各名前の `nameExpectedRate` に後退の証拠が無い」を足しました（§5-0 A-4）。表優先の順序
  （§2-5）や上限 4 の枠の奪い合い（`term-masking.ts:66-79`）でページ由来の名前が守られなくなると、
  `wrongKnown` は 0 のまま `variant` / `missing` に落ち、rev3 の 4 条件はどれも反応しません。比較は §5-3 の
  順位検定で、上限値は作っていません。

rev3 で変えたこと:

- 分母を「表示に届いたページ」から「overlay が受理した行」に移しました（§4-1-6・§5-2）。ページの `sources[]` だけを
  分母にすると、待ち行列の圧力で表示前に落ちた cue（`overlay.ts:1454-1469`）と、翻訳前に offscreen で捨てられた節
  （`translate.ts:331-353`）の中の名前が `missing` にならず計測から消え、`nameExpectedRate` が上がります。
  採れなかった走行が全問題ゼロを報告する #89 と同じ向きの損失です。事実は §1-16 に置きました。
- 「後退なし」の判定を「ベースラインの最大値以下」からやめました（§5-2・§5-3）。tts2 original-on 11 走行の
  `wrongSenseRoma` は 0 / 5 / 6 / 3 / 3 / 2 / 3 / 2 / 9 / 9 / 8（最大 9・平均 4.5・中央値 3）で、新しい 5 走行が
  すべて 9 でも rev2 の規則は通します。`englishPassthrough` は 12 / 0 / 0 / 2 / 0 / 0 / 0 / 0 / 0 / 0 / 0 で、
  上限 2 は 1 本の走行の値を全走行に許します。比較は走行ごとの率の分布に対する順位検定にし、走行数と、
  数が足りないときの結果（合格ではなく判定不能）を書きました。閾値は 1 つも新設していません。
  同じ形（ベースラインの点推定を床にする）だった `nameExpectedRate` の 81% も同じ比較に置き換えました。

rev2 で変えたこと:

- 分類の単位を「ページ」から「cue が束ねる原文行の集合」に変えました（§5-2）。レビューの指摘 3 件
  （merge の複合 `cueId`・改訂は尾だけ表示・merge をまたぐ `rung`）は、どれも「1 ページ = 1 節 = 1 段」という
  同じ前提の破れです。局所の 3 修正ではなく単位の変更 1 つで解き、字幕ログに足すフィールドもそれに合わせて
  行ごとの `sources[]` にしました（§4-1-5）。
- ウォームアップ切りの比較を ms に揃えました（§4-1-2）。`appearedAt` は ISO 文字列で `replayStartedAtMs` は
  数値なので、rev1 の `>=` は NaN になり、1 枚ではなく全ページを落とします。
- `nameTableHash` を「ソースの sha256」から「ビルドが dist に書いた sha256」に変え、bench が読む複写と
  照合してから走るようにしました（§4-4）。bench はビルドしないので、ソースの hash は動いている表を指しません。

rev1 で変えたこと:

- 数字を母集団つきで引き直しました（§1-11・§1-13・§5-3）。rev0 は original-on 11 走行の値と、original-off
  2 走行を足した 13 走行の値を、同じ文の中で混ぜていました。
- 判断を要した 4 点（第三者出典・`rejected`・受け入れの名前単位化・定訳の対象範囲）は選んだ案を本文に書き、
  §9 で sora の裁定を求めます。
- 指摘のうち成立しなかったものが 1 件（走行間隔 5.5 分）。実測を §1-15 に残しました。

動機: 1 本の 95 秒クリップ（`bench/results/live2-tts2-base-original-on-20260904-043759.json`）の
`display.blocks[].lines` で、同じ名前が走行中に何通りにも化けています。Roman（望遠鏡）が
`Roman` / 「ローマ」（都市・誤義）/ 「ローマ宇宙望遠鏡」/ 「ロマン」、Goddard が `Goddard` /
「ゴダード」/ 「ゴッダード」/ 「ゴッドダード」（実在しない綴り）、Kennedy Space Center が
`Kennedy Space Center` と 1 回だけ「ケネディ宇宙センター」（日本語の報道・宇宙機関の文書で普通に使われる
表記。出典 URL は行を書くときに開いて確かめます。本設計では未確認）。
sora の問いは 2 つです。①原綴りで残す名前とカタカナで書く名前の線はどこか、表を積み上げる
ことが答えか、それはディープラーニングなのか。②多数のクリップを回して表記を集める反復作業は
スクリプトにして、人やモデルが転写を読む費用をほぼゼロにできないか。

本文はコードを読める読者向けに、判断の理由を中心に書きます。

---

## 0. 要旨

- 名前の桶は 2 つでは足りません。**原綴り / 定訳 / 表外（観測のみ）** の 3 状態にします。
  割り当ては「**日本語の一次資料でどう書かれているか**」で決め、出典を行に持たせます。原綴り側にも出典が要ります。
- 定訳も原綴りと同じ**占位子で守って決定論的に復元**します。プロンプトで頼む方式は 3 回測って
  効かなかったからです（`docs/issue-49-design.md` rev5・`8db8bb1`・本設計 §1-6）。
- スクリプトが決められるのは「揺れているか」「候補と頻度」まで。「どれが正しいか」は日本語の
  事実で出典が要ります。**多数決は Roman で誤答を選びます**（§3、実測）。
- 採取は `bench/live2.mjs` を 1 走行の単位としてそのまま使い、外側に薄いバッチと集計を足します。
  集計は毎回全結果から再計算する派生物にして、人が merge する状態を持ちません。トークンは使いません。
- 受け入れは**名前単位**で読みます。ベースラインは Roman で既に赤（§1-13）なので、走行全体の
  `nameWrongKnown = 0` を変更ごとの合否にすると何も通りません。名前の指標は占位子の生存率に上限を持ち、
  必ず**英語素通しと対**で読みます（`c196641` が素通し 12→0 と引き換えに誤義 0→5 を買った実測がある）。
  後退の有無はベースラインの最大値でなく走行ごとの率の分布で判定します（§5-3）。分母（何を数えるか）と
  合否（何を見るか）の定義は §5-0 の D と A だけが正本で、他の節はそこを引きます。

---

## 1. 現状の事実（file:line）

1. 表は 2 つ。`KEEP_LATIN_TERMS`（`src/offscreen/glossary.data.ts:41-75`・33 語・`ambiguous` 印 9 語）と
   `GLOSSARY_TERMS`（`:83-109`・25 語・`confidence: verified | conventional`）。ヘッダ（`:1-16`）に
   「Nothing here is a guess」とあり、出典は「主に platform.claude.com/docs/ja」とコメントで一括記載。
   行ごとの出典フィールドはありません。tts2 の 4 語のうち NASA / Goddard / Kennedy Space Center は非曖昧、
   Roman は `ambiguous: true` で表に入っています（`:67-70`）。
2. 一致は大小無視・語境界付き（`glossary.ts:50-58`。`Roman's` と `Romans` は非対象）。非曖昧語は無条件に
   マスク対象（`:12-16`）、曖昧語はページが名指し / 直後に版番号 / 同族語（非曖昧の表の語）が隣、のいずれかで
   初めてマスク（`:60-93`・`:94-153`）。tts2 の台本で Roman の隣にあるのは "Space Telescope" と
   "Goddard,"（コンマで切れる）なので、ページが名指ししない `without` モード（§4-3）では **Roman は一度も
   マスクされません**。
3. マスク計画は**ページ由来の固有名詞を先に**置き、残り枠を KEEP_LATIN で埋めます
   （`translate.ts:804-820` → `term-masking.ts:24-113`）。上限 4（`term-masking.ts:1`）。ページ由来が
   5 個以上なら**節ごとマスクなし**（`:38-46`）。復元は各番号ちょうど 1 回でなければ `null`
   （`:117-183`）、復元される文字列は **`entry.term`、つまり原綴りだけ**です。
4. 復元が `null` のとき救済梯子に入ります（`translate.ts:984-1080` → `:1274-1338`）。順は
   Translator（マスク付き）→ Translator（マスクなし）→ **LanguageModel マスクなし再試行**
   （`:1494-1560`）→ 英語素通し（`fallback: true`）。ベンチのプロファイルでは Translator が
   `downloadable`（結果 JSON `builtinAi.translator`）なので Translator の 2 段は準備に失敗して飛び、
   **実効の救済はマスクなし LanguageModel**です。「ゴッドダード」「ローマ」「ロマン」はここで生まれます。
   マスクなし再試行は、計画にあった語を `unmaskedTerms` として渡し（`:1513-1515`）、プロンプト側はそれを
   `[原綴り]` ブロックに足し（`:2211-2221`）、ページ由来の語を `[固有名詞（原綴りのまま使う）]` に載せます
   （`:2190-2196`）。つまり救済の指示は**常に原綴り**です。
5. `GLOSSARY_TERMS` はプロンプトの `[用語] term = ja` 行としてだけモデルに届きます
   （`glossary.ts:329-343`・`translate.ts:2164-2258`）。出力側で照合する機構はありません。
6. プロンプトのレバーは効かないと 3 回測っています。`docs/issue-49-design.md` rev5（対訳行・system 1 文で
   全体訳質が悪化）、`8db8bb1`（マスクなし再試行に原綴り指示を足しても wrongSenseRoma 5→6）、
   `35e8e21` 本文（「prompt instructions were measured twice today to make the output worse」）。
7. ページ由来の名前は `extractPostContextTerms`（`src/content/index.ts:2940-3060`）が `<article>` から
   `[\p{Lu}][\p{L}\p{M}\p{N}'’._-]{3,}` + @handle で拾い、4 文字以上・stoplist・上限 40
   （`src/shared/messages.ts:23`）。fixture は `bench/serve.mjs:69-71` が `contextTerms` を
   `<article data-testid="tweet">` に描画し、`live2.mjs:52-76` の `CASES` が固定リストで渡します
   （tts2 = Roman / NASA Goddard / Kennedy Space Center / coronagraph）。fixture から拡張への経路はこの
   `<article>` だけで（`serve.mjs:70` が `<span>語.</span>` を並べ、content が `innerText` を正規表現で読む）、
   単語は先頭が大文字（`:2975` の `[\p{Lu}]`・`:2998` で再確認）、語列は各語が大文字始まり（`:3066`）でなければ
   拾いません。**`coronagraph` は小文字始まりなので一度も抽出されず**、`with` モード（§4-3）でもページ由来には
   なりません。マスクもされず、モデルの自由です。
8. 字幕ログ（`src/shared/caption-display-log.ts:17-34`）はページごとに `cueId / pageId / line0 / line1 /
   sourceText / translationPath / appearedAt / replacedAt` を持ち、上限 400 ページ（`:11`）。
   `cueId` は `${line.id}:${index}`（`overlay.ts:1223`・index は 1 つの cue を分割したときの番号）で、
   `sourceText` は cue の**全文**（`:1227`）が**ページごとに繰り返し**書かれます（`:1707`）。
   表示用の原文行は `clampTail` で切り詰めた別物（`:1214-1218`）。`translationPath` は overlay が持つ
   **現在の経路**（`:1709`）で、その行を作った救済段ではありません。`fallback` は `CueData` にある
   （`:1228`）がログ入力には入っていません。`CueData` は `sourceIds` も持ちます（`:84`・`:1224` で
   `[line.id]`）が、これもログ入力（`caption-display-log.ts:17-28`）にはありません。
   待ち行列が詰まると隣り合う cue を 1 つに merge し（`overlay.ts:1393-1452`）、`cueId` は `1:0+2:0` の形
   （`:1431-1432`）、`sourceIds` は両方の連結（`:1433-1436`）、`sourceText` も両方の連結（`:1419-1425`）に
   なります。merge の条件は `fallback` が等しいことだけです（`cue-queue.ts:56-59`）。
   認識器が同じ語で始まる長い節を後から確定したとき（改訂・`source.startsWith(lastAcceptedSource)`・
   `overlay.ts:1079-1083`）、表示が増えた尾だけになるのは 2 つの分岐だけです。翻訳どうしで日本語も前の行の
   日本語で始まるとき（`primary.startsWith(lastAcceptedPrimary)`・`:1093-1104`・`overlay.test.ts:783`）と、
   片方が英語素通しで英語の尾を出すとき（`:1105-1112`）。翻訳どうしでも日本語が前の行で始まらなければ
   **全文の翻訳をそのまま追記します**（`:1084` の `primary = fullPrimary` が `:1087-1104` で触られない）。
   どの分岐でも `sourceText` は改訂後の**全文**です（`:1187`・`:1227`）。
   `appearedAt` / `replacedAt` は `Date.now()` を `toISOString()` した**文字列**です
   （`caption-display-log.ts:32`・`:262`・`:296`・`:609-611`）。`live2.mjs:861-905` は終了時に worker からこのログを読み、
   **滞留時間の分位点だけ**残してページを捨てています。
   ログは走行の前に `chrome.storage.local.remove("captionDisplayLog")` で消されますが（`live2.mjs:440`）、
   消すのはウォームアップ再生（`:517-523`）の**前**なので、ウォームアップで出たページが走行に残ります。
   09-04 の 4 走行すべてで `captionLogEntries` が `display.blocks` より **ちょうど 1 多い**
   （theo `040816` 52/51・`041151` 53/52、tts2 `043224` 28/27・`043759` 29/28）。消去の失敗は
   `catch {}` で飲まれ（`:443-446`）、印が残りません。失敗すると前の走行の最大 400 ページがそのまま入ります。
9. ベンチの名前系ゲート: `wrongSenseRoma` = `/ローマ(?!ン)/`（`live2.mjs:1600`）、`romanKept`（`:1602`）、
   `glossaryLatinKept / Lost`（`:1489-1522`。英語側の取り方が表示構成で 3 通りに変わる: original-on は
   切り詰め済み原文行、original-off は台本の節を**走行全体の連結**と照合（`:1505`）、台本が無ければ
   日本語行を英語扱い（`:1508`））、`maskedNameOccurrences`（`:1534-1539`。出力に残った非曖昧語の
   ラテン文字出現数）、`katakanaNameHits*`（`:130-145`。固定リスト。自身のコメントが「下限であって件数
   ではない」と明記）。`loadKeepLatinEntries`（`:79-100`）は TS ソースを正規表現で読んでいます。
   走行 JSON は **commit も表の版も記録していません**（top-level は `schemaVersion / case / model / backend /
   displayConfig / ... / gates / generatedAt`）。
10. 本走行の実測（`...-043759.json`）: Roman → `Roman` 7 / 「ローマ」8 / 「ローマ宇宙望遠鏡」/ 「ロマン」2、
    Goddard → `Goddard` 4 / 「ゴダード」/ 「ゴッダード」/ 「ゴッドダード」、Kennedy Space Center →
    原綴り 3 / 「ケネディ宇宙センター」1。`katakanaNameHits` は 2（「ゴッドダード」「ロマン」を数えて
    いない）。`diagnostics.devLog` は空で `placeholderSurvivalSamples` 0（`35e8e21` 本文どおり、
    background が中継しない kind は落ちる）。
11. 09-03〜09-04 の tts2・**original-on・成功 11 走行**（`051858 053049 055344 061735 063243 064429 082811
    083845`・`002418 043224 043759`）の `display.blocks[].lines` を集計すると、
    Roman = 原綴り 117 / ローマ（ン以外・「ローマ宇宙望遠鏡」を含む）52 / ローマン 9 / ロマン 4、
    Goddard = 原綴り 70 / ゴッダード 7 / ゴッドダード 2 / ゴダード 2、
    Kennedy Space Center = 原綴り 35 / ケネディ宇宙センター 5 / 「ケネディ(の) Space Center」混在 3。
    original-off の 2 走行（`051701`・`002658`）を足した 13 走行では原綴りが 146 / 86 / 41、
    ケネディ宇宙センター 7、ローマ 55。rev0 はこの 2 つの母集団を混ぜていました。以後、本文の数字は
    断りがなければ **original-on 11 走行**です。
12. 09-04 の失敗 3 走行: `043009` と `044207` は `play()` の AbortError（"video-only background media was
    paused to save power"）、`043547` は `backlog did not drain within 60000ms`（`live2.mjs:40,604`）。
    watchdog（`:360-364`）は `process.exit(2)` を直接呼ぶので `finally` が走らず、Chrome と 8123 番が
    残り得ます。
13. 時系列: 英語素通しは 09-03 05:18（`051858`）まで 12/28。05:30 以降の original-on 10 走行では
    **`061735` の 2 を除いて 0**です。同じ境目で wrongSenseRoma が 0 → 5 / 6 / 3 / 3 / 2 / 3 / 2 / 9 / 9 / 8
    （05:30 以降のすべての走行で 2 以上・`c196641` の本文と一致）。名前を守る機構と英語に落とさない機構は、
    いま**同じ資源を奪い合って**います。
14. tts2 の英語側の密度: 台本（`bench/refs/tts2-script.txt`）1 周に Roman 4 / Goddard 2 / Kennedy Space
    Center 1 / coronagraph 1。fixture は `video.loop = true`（`live2.mjs:519`）で 95 秒に 3〜4 周するので、
    1 走行の英語側出現は Roman 12〜17 / Goddard 6〜9 / Kennedy 3〜4 になります。周回数は走行ごとに違うので、
    分母は台本から取れません。表示に届いたページの `sourceText` からでも足りません（§1-16）。分母の定義は
    §5-0 の D です。
15. 走行の所要時間（連続する走行ファイルの `generatedAt` 差・tts2）: 118 / 132 / 134 / 160 / 165 / 166 s。
    採取 95 s + 停止 drain ≈ 103 s（`samples[0]` → `generatedAt`）を含みます。つまり 1 走行は**実測 2.0〜2.8 分**。
    `043224` → `043759` の 5.5 分は、間に失敗走行 `043547`（排出 timeout）を挟んだ 2 本の差で、
    走行間隔ではありません。失敗を挟んだ差を間隔と読まないこと。
16. 表示に届く前に行が落ちる点は 2 つあり、どちらも字幕ログ（`recordPageShown`・`overlay.ts:1701`）より上流です。
    ①offscreen の翻訳待ち行列（`translate.ts:331-353`）: 保留が `MAX_PENDING_TRANSLATIONS`（`:175`・2）に達すると
    最古の確定節を `shift()` して `settleIds` し、content には送りません。DEV ログ `queue-drop` に `lineId` だけが
    載り（`:349-351`）、英語本文は `console.warn` の `textLength` にしかありません。ベンチの `devLogQueueDrop`
    （`live2.mjs:1587`）が数えているのは**この**落下です。②content の待ち行列（`overlay.ts:1454-1469`）:
    `MAX_WAITING_CUES`（`explicit-stop-drain.ts:10`・6）を超えて merge でも収まらない分だけ `waitingCues.shift()`
    します（`cue-queue.ts:94-98`）。記録は `host.dataset.cueDrops` の件数（`:1467`）と `console.warn` だけで、
    サンプラは `cueDrops` を読んでいません（`display.samples[]` の鍵に無い）。id も本文も残りません。
    `recognition.jaClauses` は `appendLedgerEntry(cue.primaryText)`（`:1152`）の台帳で、①の後・②の前に日本語だけを
    cue 単位で積みます。件数が blocks と 1 ずれる走行が 11 本中 6 本あり、うち 5 本は `devLogQueueDrop` 0、残る
    `061735` は①が 2 件（`lineId` 23 / 24）起きて 1 しかずれません。件数の差から落下は取り出せません。
    `061735` の `wrongSenseRoma` は 3・`englishPassthrough` は 2 で、その 2 節の名前は数字のどこにもいません。
    ②は既存走行に観測手段が無く、0 とは言えません。もう 1 つ、翻訳が空で `createCueSegments` が `[]` を返した行
    （`:1197-1199`）も cue を持たず、ページに現れません。

---

## 2. 桶と割り当て規則

### 2.1 いまの 2 桶が答えられない問い

現行の線は「モデル・製品・組織の名前は原綴り、技術用語は日本語」（`glossary.data.ts:4-6`）です。
この線は Kennedy Space Center に答えを出せません。組織名なので原綴り側に置かれ、実際の出力
「Kennedy Space Center のチーム」は誤りではないが、日本語の資料が使う「ケネディ宇宙センター」
ではありません。同じ理由で、Goddard を「ゴダード」と書く出力を**失敗として数えている**
（`live2.mjs:141`）一方、その語が定訳の一部なのかどうかを表は決めていません。

つまり足りないのは 3 つ目の状態、「**日本語表記が定まっている名前**」です。そして 2 桶の外側にもう 1 つ、
表に無い名前がどう扱われるかの**既定**が暗黙になっています。「ゴッドダード」も「オパウス」も
「оパус」（キリル文字混入）も、表外の名前をモデルが自由に音写した結果です。

### 2.2 提案: 名前は 3 状態、用語集は別物のまま

| 状態 | 出力 | 機構 | 例 |
|---|---|---|---|
| **原綴り**（latin） | 英語のまま | 占位子で隠し原綴りを復元（現行） | Claude, OpenAI, GitHub, NASA |
| **定訳**（ja） | 決まった日本語 | 占位子で隠し**日本語文字列を復元**（新規） | Kennedy Space Center → ケネディ宇宙センター（候補・出典未取得） |
| **表外**（観測のみ） | モデルの自由 | 何もしない。ただし採取で必ず記録する | 初めて出た名前 |

`ambiguous` 印は状態と**独立**に付きます（Roman が定訳になっても、一般語の「ローマ帝国の」が出る素材では
条件付きのまま）。

`GLOSSARY_TERMS`（技術用語）は名前の表に**統合しません**。理由は、用語は普通名詞で活用・文脈依存があり
（"training" を常に「学習」に固定すると「トレーニング動画」が壊れる）、決定論的に置換すると新しい誤りを
作るからです。用語集はプロンプトの示唆のまま、名前だけを決定論の側に置きます。

定訳を占位子で扱うのは、プロンプトに書いても従わないことを測り切っているからです（§1-6）。
占位子機構は復元する文字列が何かを気にしません（`restoreMaskedTranslation` は `entry.term` を返すだけ・
`term-masking.ts:117-183`）。計画の要素に「復元する文字列」を 1 つ足せば、原綴りと定訳は同じ経路に乗ります。

### 2.3 割り当て規則（新しい名前に、方針を再決定せずに当てる手順）

順に当て、最初に当たった行で決めます。**どの行でも `source` が要ります。** 出典なしで表に入る行はありません。

| 順 | 問い | 結果 |
|---|---|---|
| 1 | その名前の**持ち主**（組織・製品・作品の公式）の日本語資料を開けたか。開けて、そこで日本語表記を使っていたか | **定訳**（`verified`）。表記をそのまま `ja` に書き、開いた URL を `source` に書く |
| 2 | 持ち主の日本語資料を開けて、原綴りのまま書いていたか（多くの AI ベンダの日本語ドキュメントがこれ） | **原綴り**（`verified`）。`source` を書く |
| 3 | 持ち主の日本語資料が無い・開けない。ただし**第三者の権威ある日本語資料**（国立機関・学会・辞典・大手出版社の公式）が一方の表記を使っているか | その表記で入れる（`conventional`）。**カタカナなら定訳、原綴りなら原綴り**。開いた URL を `source` に書く |
| 4 | どれにも当たらない | **表に入れない**（表外）。採取で観測し、次の候補票に載せる |

rev0 の順 3 は「慣用が一方に寄っていれば原綴り（出典なし）」でした。これだと、持ち主が日本語ページを
持たず、日本語の用法がカタカナに定まっている名前（Goddard を「ゴダード」と書く資料があるなら Goddard、
Roman を「ローマン」と書く資料があるなら Roman）が、出典なしの判断で原綴りに固定されます。原綴りは
「決めない」ではなく「英語のまま出す」という決定なので、定訳と同じ重さの出典が要ります。
この変更は sora の裁定が要ります（§9）。

Kennedy Space Center はこの規則でこう通ります。NASA が日本語ページを持つかは未確認です（rev0 は
「NASA の日本語資料」と書きましたが URL を開いていません）。持たなければ順 1・2 は空振りで、順 3 に落ちます。
JAXA など日本の宇宙機関・国立機関の文書が「ケネディ宇宙センター」を使っていれば、その URL を `source` に
書いて `conventional` の定訳で入ります。行を書く人が URL を開くまで、表には入りません（§5-3 の例は
その手順を踏んだ後の話です）。

補則:

- **一般語の意味がこの素材（AI・技術系の動画）で出るか**を別に問い、出るなら `ambiguous: true`。
  これは状態でなく「マスクに証拠を要求するか」の印です（現行の判断基準をそのまま使う・
  `glossary.data.ts:19-38`）。
- **出力の頻度で表を書かない。** モデルが 10 回そう書いたことは、その表記が正しいことの証拠ではありません
  （§3）。
- 順 1〜3 が同じ「日本語資料を開く」作業で決まるので、「原綴りかカタカナか」の線は**日本語資料の表記**という
  1 本になります。これが問い①への答えです。現行ヘッダの「組織名は原綴り」はこの規則の**帰結の 1 つ**
  （ベンダの日本語資料が原綴りを使うから）であって、規則そのものではなくなります。日本語表記を持つ
  組織・施設は定訳側に来ます。
- 既存の `KEEP_LATIN_TERMS` 33 行は `source` を持たないので、移行時に出典を付けるか、付けられない行は
  表外に落とします（落ちた名前はページ由来の機構で原綴りのまま守られるので、表示は変わりません・§2-4）。

### 2.4 表外の名前の既定と、その理由

表外の名前の扱いは、いま 2 段です。ページが名指ししていれば**原綴り**（ページ由来はマスクされ、原綴りで
復元される・§1-3）、名指しがなければ**モデルの自由**。この既定は**変えません**。理由:

- 拡張が知っている綴りは英語だけです。見たことのない名前に日本語表記を与える手段は「音写を推測する」
  しかなく、それが「ゴッドダード」の出どころです。決定論的に選べるのは原綴りか自由かの 2 つで、
  「未知の大文字語はすべて原綴り」を機械で当てるには固有名詞判定が要りますが、ASR は大文字を返しません
  （`3bcdc3b` 本文: opus が 5 回出て 1 度も大文字でなかった）。判定器を作れば一般語まで英語で残ります。
- **自由に任せた結果は、表を育てる信号そのものです。** 表外の名前が 3 通りに揺れたことをスクリプトが
  拾い（§3）、人が出典を付けて表に移す。既定は「表記の方針」ではなく「**必ず記録される**」という
  観測の方針に変わります。

ただし、表**内**の名前が自由に化ける経路は残ります。占位子を失って救済梯子がマスクなし再試行に落ちた
ときです（§1-4）。ここは表を増やしても止まらず、レバーは占位子の生存（`35e8e21` の方向）です。
本設計はこの経路を**分類して数える**（§5-2）ところまでを持ち、生存率の改善は別件に切ります。
Roman のベースラインが赤い（§1-13）のもこの経路で、Kennedy の変更とは別の項目です。

### 2.5 データ形と触る範囲

名前の表は 1 つにし、状態を持たせます。

```ts
export interface RejectedForm {
  readonly form: string;              // 出力に現れたら誤りと決めた表記（「ローマ」）
  readonly reason: string;            // 「誤義: 都市のローマ」「実在しない綴り」など
}

export interface NameTerm {
  readonly term: string;              // ASR が書く英語（大小無視で一致）
  readonly render: "latin" | "ja";    // 原綴り / 定訳
  readonly ja?: string;               // render: "ja" のとき必須
  readonly ambiguous?: true;          // 一般語の意味がこの素材で出る
  readonly confidence: "verified" | "conventional";  // 持ち主の資料 / 第三者の権威ある資料
  readonly source: string;            // 開いた URL。全行必須
  readonly rejected?: readonly RejectedForm[];       // 決めた誤り。回帰の検出に使う（§5-2）
}
```

- `render: "ja"` は `ja` を必須にし、`source` は全行必須で、**単体テストで欠落を落とします**。
  「Nothing here is a guess」をコメントから検査に移すためです。
- `rejected` は「知っている崩れ方の列挙」ではなく「**決めた誤りの記録**」です。用途は回帰の検出だけで
  （§5-2 の `wrongKnown`）、件数の計測には使いません。件数は補集合の `variant` が持つので、列挙の下限問題
  （`live2.mjs:123-129`）は起きません。§7 が退けるのは「ベンチ側のリストで壊れ方を**数える**」ことで、
  表の行に「この表記は誤りと決めた」と書くことではありません。この区別は sora の裁定が要ります（§9）。
  `wrongSenseRoma` の `(?!ン)` 先読み（`live2.mjs:1600`）が埋め込んでいる「ローマは誤義、ローマンは
  許容」の判断は、Roman の行の `rejected: [{ form: "ローマ", reason: "誤義: 都市" }]` と（出典が取れれば）
  `ja` に移ります。
- マスク計画の要素に `render` 文字列を足し、復元はそれを返します。`remaskPlannedTerms`
  （`term-masking.ts:241`）は履歴の JA 側も再マスクするので、`ja` の語は JA 側で日本語文字列を探す必要が
  あります。復元直後に、日本語文字と隣り合う占位子の前後の ASCII 空白を落とします
  （「ケネディ宇宙センター のチーム」を避ける。原綴りは空白があるほうが自然なので触らない）。
- **表の語とページ由来の語が重なったら表が勝つ**ようにマスク計画の順を変えます（現行はページ先・§1-3）。
  理由は、表には出典があり、ページには綴りしかないからです。tts2 の fixture では「Kennedy Space Center」が
  ページにもあるので、この順を変えないと定訳は一度も適用されません。
- **マスクなし再試行のプロンプト**（§1-4）は、計画の語を `[原綴り]` に、ページ由来の語を
  `[固有名詞（原綴りのまま使う）]` に載せます。`render: "ja"` の語がここに来ると、表と**逆の指示**を出す
  ことになります。`ja` の語は両ブロックから外し、`[定訳]` ブロック（`term = ja` の行）に載せます。
  プロンプトの指示は効かない前提（§1-6）なので、これは「逆を言わない」ための修正であって、救済段で定訳を
  保証する機構ではありません。効いたかどうかは §5-2 の `keptLatin` を**段別**（§4-1-5 の `rung`）に読んで
  決めます。rev0 は `keptLatin` を「悪くはない」と書きましたが、撤回します。`expected` に入らないので率を
  下げる分類です。
- `bench/live2.mjs` の `loadKeepLatinEntries` は TS ソースを正規表現で読んでいます（§1-9）。形を変えると
  無音で古くなり、`render: "ja"` の行を読み落とせば Kennedy が latin に見えて `nameExpectedRate` が
  80% で通ります。正規表現は消し、bench は `src/offscreen/glossary.data.ts` を `bench/work/name-table.mts`
  に**そのまま複写して `import()`** します。Node 24 の型除去は `.mts` を package の `type` に関係なく ESM
  として読み、この file は import を持たないので依存ゼロで動きます（本日実測: 33 / 25 行が読め、
  `KEEP_LATIN_TERMS[28]` が Kennedy Space Center）。型除去が扱えない構文（enum・namespace）を書けば
  import 時に SyntaxError で止まるので、fail-closed です。rev0 の `bench/glossary-source.mjs` +
  vitest 照合の案は取り下げます（同じ解析を 2 か所に持たないどころか、解析そのものを持たない）。
  この複写の sha256 を、ビルドが dist に書いた表の sha256 と照合してから走ります（§4-4）。
- 拡張のバンドルに依存は増えません。変わるのはデータの形・復元の文字列・計画の順序・救済プロンプトの
  ブロック分け・字幕ログと DEV ログの記録（§4-1-5〜7・表示は変えない）だけです。

---

## 3. スクリプトが決められること・決められないこと

**決められること**（すべて正規表現と共起の数え上げ・トークン不要）:

- 英語の節と表示された日本語の対応（字幕ログの `sourceText` ↔ `line0/line1`・§1-8・単位は §5-2）。
- 各名前の出現ごとに、出力側の表記を **原綴りのまま / 表の定訳どおり / それ以外** に分けること。
- 「それ以外」の中身の候補: その名前を含む節の出力に現れ、含まない節の出力には現れないカタカナ連
  （カタカナ + 続く漢字を 1 塊として拾う。「ローマ宇宙望遠鏡」は 1 候補）。共起なので偽陽性はあります
  （台本が "Roman Space Telescope" なら「宇宙望遠鏡」も Roman と共起する）。
- 同じ名前に 2 通り以上の表記が出た＝**揺れている**、の検出と、候補ごとの頻度・出た走行・経路。
- **確実に誤り**の機械判定が可能な 2 類。**語内の混在**: 1 つのカタカナ語の中に別スクリプトが入る
  （「оパус」のキリル文字）。**名前内の混在**: 複数語の名前で、語の一部だけが原綴りで残り、残りが
  仮名・漢字になっている（「ケネディ Space Center」「ケネディの Space Center」）。どちらも Unicode の
  スクリプトと、その名前の英語綴り（表の `term`、表外なら `terms.txt` の行）の語列から定義で判定できます。
  表の行を持たない名前に機械で言える誤りはこの 2 類だけです（`rejected` は表の行にしかない・§5-2）。「Roman 宇宙望遠鏡」は混在ではありません
  （"宇宙望遠鏡" は `term` の外）。rev0 は名前内の混在を `variant` に数えていましたが、1 つの名前が
  2 つのスクリプトで出ているので誤りです。ベースラインに 3 走行 3 件あります（§1-11）。
- 表の定訳と最頻出力がずれた（ドリフト）、の検出。

**決められないこと**:

- **どの候補が正しいか。** 「ケネディ宇宙センター」が正しいのは日本語の用法の事実で、出典を
  開いた人だけが知っています。頻度は正しさの代わりになりません。実測で、Roman の出力は
  ローマ（ン以外）52 / ローマン 9 / ロマン 4（§1-11）で、**多数決は都市のローマを選びます**。
- **`ambiguous` を付けるか。** 「この素材で一般語の意味が出るか」は動画群についての判断で、走行の数字からは出ません。
- **原綴りか定訳か。** 日本語資料を読む作業です。

**人（またはモデル）が座る場所と、その最小化**:

- ループの末端に 1 枚の**候補票**（`bench/results/naming-candidates.md`）を置きます。載るのは
  「揺れている名前」「表の定訳と違う表記が出た名前」「スクリプト混在の表記」だけ。1 行に
  名前・候補表記と件数・出た走行と経路・そのまま貼れる `NameTerm` の雛形（`ja` と `source` は空欄）。
- 人がやるのは **`source` を埋めるか、行を消すか**の二択です。転写は読みません。
- モデルを使うなら、候補 1 行に対して「持ち主または権威ある第三者の日本語資料の URL を探す」だけを頼みます
  （grok / agy の Web 探索）。**それでも表に入れるのは人が URL を開いた後**です。費用は**新しく揺れた名前の数**に
  比例し、クリップの本数にも走行の本数にも比例しません。1 バッチで新顔は数語です。
- 「ゴダード」は候補票の良い例です。`live2.mjs:141` はこれを失敗として数えていますが、Goddard の
  日本語名（センター名）に同じ音写が使われているなら定訳の一部かもしれません。**スクリプトはこの判断を
  しません**。票に「ゴダード 2 / ゴッダード 7 / ゴッドダード 2 / 原綴り 70」と並べ、人が出典を付けます。

---

## 4. 採取ハーネス

### 4.1 再利用するもの / 足すもの

**再利用（変えない）**: `bench/live2.mjs` の 1 走行の全部。Chrome 起動・`Extensions.loadUnpacked`・設定投入・
ウォームアップ→一時停止→滞留排出→巻き戻し再生（`:519-619`）・300ms サンプラ・停止 drain・
`bench/results/live2-*.json` の出力・既存ゲート。すでに子プロセス 2 本（表示構成）を `spawnSync` で
回す構造（`:243-268`）と `parseChildReport`（`live2-config.mjs`）があるので、バッチはこれを外から使います。

**足すもの（4 点・拡張側は 3 点。拡張側はいずれも記録を足すだけで表示を変えません）**:

1. **ケース定義をファイルに出す。** `CASES`（`:52-76`）と `run-bench.mjs` の `loadCase`（`:378-420`）が
   同じ内容を 2 か所に持っています。`bench/refs/<case>/` に `speech.wav` / `script.txt` / `terms.txt` を
   置く規約にし、`live2.mjs` は `--case` でディレクトリを解決します。クリップを足す＝ファイルを置く、に
   なります（verify skill も「terms を渡す CLI フラグは無い」と書いている現状の解消）。
2. **字幕ログのページを結果 JSON に残す。** `live2.mjs:861-905` は worker から `captionDisplayLog` を
   読んで分位点だけ残しています。`pages`（上限 400・`caption-display-log.ts:11`）を
   **`Date.parse(appearedAt) >= replayStartedAtMs` で切って** `result.display.pages` に書きます。
   `replayStartedAtMs` は巻き戻し再生の直前にページ側の `Date.now()` で取った**数値**（`:610-618`）、
   `appearedAt` は content script が `Date.now()` を `toISOString()` した**文字列**です
   （`caption-display-log.ts:262`・`:609-611`）。時計は同じですが型が違うので、rev1 の
   `appearedAt >= replayStartedAt` は文字列と数値の比較になり、`appearedAt` が NaN に化けて全ページで false、
   つまりウォームアップの 1 枚ではなく**`display.pages` が空**になります。ms 側に寄せる理由は 2 つ。
   `toISOString()` は ms を落とさず `Date.parse` が正確に戻すこと、bench の滞留計算が既に
   `Date.parse(page.appearedAt)` を使っていること（`live2.mjs:882`）。`Date.parse` が NaN を返したページは残さず
   `pagesUnparsed` に数えて JSON に書きます（無音で落とさない）。`replayStartedAt` は JSON には ISO 文字列で
   書き、比較は ms で行います。これでウォームアップのページ（§1-8・毎走行 1 枚）と、消去に失敗した
   ときに残る前走行のページが落ちます。消去の成否は `captionLogCleared: true | false` として JSON に書き、
   `catch {}`（`:443-446`）を印のある失敗に変えます。切ったので数字は汚れませんが、消せなかった事実は残します。
   英語全文と表示行の対応はこれで取れ、`clampTail` の切り詰め問題（HANDOFF「49 行中 4 件しか照合できない」）が
   消えます。
3. **薄いバッチ `bench/live2-batch.mjs`。** ケース × 反復 × 語モード（§4-3）を直列に回し、1 走行ごとに
   `live2.mjs` を子プロセスで起こし、終了コードとエラー署名を記録して次へ進みます。
4. **集計 `bench/naming-corpus.mjs`。** `bench/results/live2-*.json` を**全部**読んで
   `naming-corpus.json` と `naming-candidates.md` を書きます（§4-5）。表は §2-5 の複写 import で読みます。
5. **拡張側の 1 点目**: 字幕ログの入力（`caption-display-log.ts:17-28`）に **`sources`** と `fallback`
   （`CueData` にはある・`overlay.ts:1228`）を足します。`sources` は、そのページを出した cue が束ねる
   **原文行の配列**で、要素は `{ id, text, rung }` です。
   - `id`: `CueData.sourceIds` の要素（`overlay.ts:84`）。merge した cue（`:1433-1436`）では 2 つ以上になります。
   - `text`: その行の**実効テキスト**（§5-0 D。表示する `primary` を切り詰めた行なら英語の尾、それ以外は全文）。
     `acceptCommittedClause` が `lines[]` に書くのと**同じ 1 つの値**で、`createCueSegments`（`:1182`）に渡す
     引数を 1 つ足して cue に複写します。ページ側で別に計算しません（2 か所で計算すると rev3 のようにずれる）。既存の `sourceText`
     （全文・merge では連結）は消しません（`run-bench.mjs:554` が読みます）。
   - `rung`: その行を作った段。値は梯子の順（§1-4）で `masked`（占位子復元）/ `translator-masked` /
     `translator-unmasked` / `lm-unmasked` / `passthrough`。`27e8290` が `fallback: true` を中継した前例に沿い、
     `RecognitionPayload` に 1 値を足す形です。**行ごとに持ち、ページや cue には持たせません。** merge は
     `fallback` の一致しか見ない（`cue-queue.ts:56-59`）ので、`masked` の行と `lm-unmasked` の行が 1 つの
     cue・1 ページに乗ります。ページに 1 つの `rung` を書くと、どちらかの行の出現が別の段に付き、§5-2 の
     段別内訳が壊れます。
   `parseCaptionDisplayLogPages`（`caption-display-log.ts:217`）は field の型を見てから受けるので、`sources` の
   形もそこに足します。`translationPath` は現在の経路であって作った段ではない（§1-8）ので、`rung` が無いと
   「表が間違っている」と「占位子を失った」を分けられません。
6. **拡張側の 2 点目: 受理した行と落とした cue を字幕ログに残す。** `acceptCommittedClause` の中で、
   **最後の早期 return を通過した直後**に `recordLineAccepted({ id, text, rung })` を呼びます。早期 return は 2 つ
   あり、重複と clear watermark（`overlay.ts:1049-1054`）の後に**順序 guard**（`:1056-1066`・`line.id` が受理済みの
   最大 id より小さければ捨てる）が続きます。rev3 は 1 つ目の直後に置いていたので、2 つ目で捨てられた行
   （cue を作らず表示にも出ない）が分母に入り `missing` に化けます。呼ぶ位置は表示する `primary` の切り詰め分岐
   （`:1087-1113`）を抜けた直後・`lastAcceptedPrimary` / `lastAcceptedSource` を上書きする（`:1115-1122`）前で、
   `text` はそこで計算する実効テキスト（§5-0 D）です。切り詰めたかは分岐の中で立てる 1 つの真偽値で持ち、
   `isRevision` からは作りません（rev4 の穴・§5-0 D）。この位置から `createCueSegments`（`:1124`）と
   `enforceQueueDiscipline`（`:1154`）までに他の早期 return はありません（`:1114-1123` は代入だけ）。`createCueSegments` が `[]` を返して cue を
   作らない行（`:1131-1144`・`:1197-1199`）は記録の後なので入り、これは意図どおりです（翻訳が空で表示に出ない
   行は脱落）。呼び出し側の `receiveCommittedClause` にも同じ 2 条件の guard（`:990-996`）と、`ja` が空の行を
   `pendingFinals` に**保留**する分岐（`:1007-1029`）がありますが、どちらも記録の前です。保留は捨てるのでは
   なく、翻訳が届くか経路が `none` に落ちたとき（`:555-570`）に `acceptCommittedClause` へ来て、そのときに
   記録されます。`clear()`（`:517`）と破棄（`:744`）で消える保留は一度も受理されないので D の外です
   （利用者の操作か終了であって、待ち行列の損失ではない）。ログは `lines[]`（`{ id, text, rung, acceptedAt }`）
   に積みます。
   `enforceQueueDiscipline` が `waitingCues.shift()` した cue（`:1458`）は
   `recordCueDropped({ cueId, sourceIds, droppedAt })` で `drops[]` に残します。`droppedAt` は `acceptedAt` /
   `appearedAt` と同じ作り（ログ側の `isoNow()`・`caption-display-log.ts:296` と同じ時計を ISO 文字列で）で、
   bench が `pages` / `lines[]` と同じ `replayStartedAtMs` で切るためにあります（§5-2 手順 1）。これが無いと、
   消去に失敗したログ（`captionLogCleared: false`）に残る前走行の drop とウォームアップ中の drop が切れず、
   行 id は走行ごとに振り直されるので、切った `lines[]` と `sourceIds` で突き合わせると別の走行の行に当たります。
   `drops[]` は分母ではなく `missing` の内訳（表示前に落ちた / 表示されたが表記が無い）に使います。`lines[]` の
   上限は `pages` と同じ 400 にし、超えた分は `linesTruncated` に数えて JSON に書きます（無音で落とさない）。
   `acceptedAt` / `droppedAt` が `Date.parse` で NaN になった要素も残さず、`linesUnparsed` / `dropsUnparsed` に
   数えます（`pagesUnparsed` と同じ）。サンプラは `host.dataset.cueDrops` も読み、`drops[]` のうち `droppedAt` が **Chrome の起動時刻以降**の件数と
   突き合わせます。`cueDrops` は overlay の生成（`overlay.ts:303`）から数えるので、`replayStartedAtMs` で切った後の件数とは
   合わず（ウォームアップ中の落下が入る）、切る前の全件とも合いません（消去に失敗したログに残る前走行の drop は
   この走行の overlay が数えていない）。前走行の `droppedAt` は起動より前、この走行の落下は起動より後なので、
   起動時刻で分ければ両方を外さずに済みます。それでも合わないときは `cueDropsMismatch` に両方の値を書き、
   rate の算出は続けます（この検査は記録の欠落を見つけるためのもので、分母の条件ではない）。
7. **拡張側の 3 点目: offscreen の `queue-drop` に本文を足す。** `translate.ts:349-351` の data に `text: dropped.text`
   を 1 つ足します（`console.warn` は既に `textLength` を持っている）。中継の検査（`messages.ts:779-797`）は
   `kind` / `requestId` / `lineId` を見るだけで未知の鍵を拒む節は読んだ範囲に無いので、`text` の受理は実装時に
   1 度確かめます。bench はこの節を `rung: "dropped-before-translation"` の行として**分母に足し**（§5-0 D の
   第 2 項）、id が `lines[]` と重ならないことを検査します（落とした節は content に届かないので、重なれば bug）。
   この節は overlay に届かないので切り詰めの判定（§5-0 D）を受けられず、`text` は全文です。後続の行が同じ
   接頭辞を表示していた場合は接頭辞の名前を 2 度数える方向（`missing` の過大）の誤りが残りますが、捨てた事実を
   消す側には倒しません。この経路の記録が
   中継の欠落で消えた場合、落下そのものが見えなくなります。§1-10 と同じ穴で、中継の修正は前提作業です。

### 4.2 クリップの出どころ

3 系統を使い分けます。いずれも拡張バンドルには入りません。

| 系統 | 作り方 | 名前の密度 | 現実らしさ |
|---|---|---|---|
| **合成音声**（現行 tts / tts2） | `script.txt` → Windows SAPI で wav（`bench/refs/tts*.wav` は SAPI 自前生成・HANDOFF:502）。生成器 `bench/make-tts-case.mjs` は PowerShell の `System.Speech` を呼ぶだけで npm 依存を足さない | 台本で制御できる | 低（ASR が楽） |
| **公有の英文** | NASA のプレスリリース等（米政府著作物はパブリックドメイン）を台本にして合成。**定訳を持つ名前が自然に高密度**で、日本語資料も存在する | 高 | 低〜中 |
| **実クリップ** | `yt-dlp` で `bench/work/` に落とす（tibo の前例・`run-bench.mjs:443-447`・コミット禁止・`localOnly`） | 素材次第 | 高（認識の繰り返し等、合成では出ない挙動。1 節が複数ページに割れる） |

台本の名前は `terms.txt` に書きます。書くのは英語綴りだけで、日本語表記は書きません（表記を決めるのは
表であって fixture ではない）。`terms.txt` は「ページが名指しする名前」の一覧で、`with` モード（§4-3）でページ由来
（§1-3・§2-4）になる語だけを置きます。つまり `extractPostContextTerms` が拾う綴り（単語は先頭大文字・4 字以上・
stoplist 外・語列は各語が大文字始まり・`index.ts:2975`・`:3066`）でなければ置けません。拾われない語は
ページに描いても守られず、`with` と `without` の差が出ないからです。この規約は bench に抽出規則を複製せずに
検査します: `src/content/index.test.ts:300` の DOM ハーネスで各ケースの `<article>` 本文（`serve.mjs:41` の
`casePageHtml` と同じ並び）を組み、**実物の `extractPostContextTerms` を呼んで** `terms.txt` の全行が返ることを
単体テストで見ます（§2-5 の複写 import と同じ規律・解析器を 2 つ持たない）。いまの tts2 では `coronagraph` が
これに落ちるので（§1-7・小文字始まり）、`terms.txt` から外して `script.txt` にだけ残します。用語（普通名詞）で
あって名前ではなく、本設計の対象外です（§2-2）。台本を作る段でモデルを使う場合、費用は**クリップ 1 本につき
1 回**で、走行や集計には乗りません。

### 4.3 無人バッチ

- **直列**です。デバイス上のモデルは 1 つ、GPU も 1 つ、プロファイルも 1 つ（同時起動でロックが衝突）。
- 1 走行は**実測 2.0〜2.8 分**（§1-15）。3〜4 分は timeout 込みの予算（ready ≤120 s + 採取 95 s +
  排出 ≤60 s + 停止 drain ≤45 s + 片付け）。8 時間で **120〜190 走行**（予算で下限、実測ペースで上限。
  再試行と cold start が入るぶん下限側に寄る）。表示構成は名前の表記に無関係なので、**original-on だけ**回します
  （sora の設定に合わせる。`display.samples[].original` が第 2 の照合経路にもなる）。
- **語モードを 2 つ**回します。`terms.txt` をページに描く `with`（マスクの効きを測る）/ 描かない `without`
  （表外の既定を測る・x.com の投稿本文が名前を含まない場合の再現）。1 レバー 1 計測の原則です。
  `without` で測れるものは名前の種類で違います。非曖昧の表の語は `without` でもマスクされる（§1-2）ので
  表の効きが出ます。曖昧語（Roman）はページの名指し以外の証拠が無ければマスクされず（§1-2）、`without` の
  Roman は**モデルの素の挙動**です。曖昧語の `without` は候補票と表外の基準線に使い、ゲートには使いません。
- 反復回数は**先に固定**します（1 クリップ × 1 モードあたり 5 走行から。judge のノイズ ±2 が既知で、
  件数系の指標も 1 走行の差は読まない）。バッチの途中で増やしません。5 は §5-3 の判定に要る下限で、検出力から
  決めた数ではありません。
- 起動は手動でも Windows のタスクスケジューラでもよく、設計は決めません。ただし §4-7 の occlusion 問題が
  あるので、**画面を使っていない時間帯**に回すのが現実解です。

### 4.4 走行ごとに書くもの

既存の `bench/results/live2-<case>-<model>-<display>-<stamp>.json` に足すだけです。

- `batchId` / `termsMode`（`with` | `without`）/ `caseId`。
- `build` と `nameTableHash`: **ビルドが dist に書いた値を読みます。** vite の `closeBundle`
  （`vite.config.ts:93`・manifest の書き出しは `:143-160`）は `getGitBuildState()`（`:176-205`）で commit と dirty を取り、`stampManifest`
  （`src/build/manifest.ts`）で `dist/manifest.json` の `version_name` に刻んでいます。同じ hook に 1 つ足し、
  `src/offscreen/glossary.data.ts` の sha256 を同じ stamp と一緒に **`dist/build-info.json`**
  （`{ revision, dirty, builtAt, nameTableHash }`）へ書きます。bench はこの file だけを読みます。
  理由: bench は `dist/` を `Extensions.loadUnpacked` するだけでビルドしません（`live2.mjs:368`）。走行の前に
  表を編集すると、拡張は古い表で動き、ソースの sha256 と §2-5 の複写 import は新しい表を指し、走行時の分類と
  before/after の帰属が**印なしに**ずれます。stamp の `dirty` はツリー全体の `git status --porcelain`
  （`vite.config.ts:193-196`）なので、表が bundle と一致するかは言えません。いまの dist は
  `0.7.0 dad9fca-dirty`（`.claude/skills` の編集だけで dirty になる）で、stamp だけでは判定できない例です。
  release 側が `scripts/build-stamp.mjs`（`i86-release-prep`・`4731eab`）で解いている形、「ビルド時に dist へ
  書いた記録を、消費側がツリーと突き合わせる」を表に当てます。
  照合: bench は §2-5 の複写（`bench/work/name-table.mts`）の sha256 を取り、`build-info.json` の
  `nameTableHash` と**一致しなければ走りません**（fail-closed。「表を編集した後にビルドしていない。
  `npm run build`」と出す）。`build-info.json` が無い dist も走りません。走行 JSON の `nameTableHash` には
  build-info の値を書き、その走行の `naming`（§4-5 の H_run）はその表で付きます。バッチ（§4-3）は開始時に
  `npm run build` を 1 回回して dist を揃え、各走行の照合はそのまま残します（途中の編集を捕まえる）。
  `build-info.json` は release の zip（`scripts/build-zip.mjs` は `dist/` をそのまま詰める）にも入りますが、
  manifest が参照しない file を Chrome は読まないので害はありません。
  いまの JSON はどちらも持ちません（§1-9）。
- `replayStartedAt` / `captionLogCleared` / `pagesUnparsed`（§4-1-2）。
- `display.pages[]`（§4-1-2。`cueId, pageId, line0, line1, sourceText, sources[{ id, text, rung }],
  translationPath, fallback, appearedAt, replacedAt`）。
- `lines[]`（`{ id, text, rung, acceptedAt }`）/ `drops[]`（`{ cueId, sourceIds, droppedAt }`）/ `linesTruncated` /
  `linesUnparsed` / `dropsUnparsed`（§4-1-6）。`pages` と同じ切り（§4-1-2）を当てた後の形です。
- `naming`（走行単体の自己記述）: 表の語と `terms.txt` の語ごとに、英語側の出現数（§5-0 D）・出力側の
  **生の表記と件数**・分類（§5-2）・`missing` の内訳（表示前に落ちた /
  翻訳前に捨てた / 表示されたが無い）。分類はその走行が使った表（`nameTableHash`）に対するもので、`expected` を
  持たない語（§5-0 A の Y の外。`without` の表外語など）は生の表記と件数だけを持ち、分類を持ちません。1 走行を
  開けば、その走行の名前の状態が読める形にします。

### 4.5 蓄積（人が merge しない）

`naming-corpus.json` は**状態ではなく派生物**です。集計は毎回 `bench/results/live2-*.json` を全部読んで
ゼロから作り直します。理由:

- 走行ファイルは追記専用で、消しも書き換えもしません。真実は走行ファイルにあり、コーパスはその索引です。
  merge の規則も重複排除の状態も要りません。
- 250 KB × 100 走行 = 25 MB 程度で、全読みは数秒です。増分にする理由がありません。
- 集計コードのバグを直したら再実行するだけで過去分も直ります。増分だと直りません。

**表の版と、どちらの分類が勝つか。** 走行は 2 つの分類を持ち得ます。走行時の `naming`（その走行が使った表・
H_run）と、集計が現在の表（H_now）で付け直したもの。決めごと:

- **受け入れ（§5-3）は走行時の `naming` を読む。** 変更前の走行は変更前の表で分類されたまま残り、
  Kennedy が `ja` になっても before 側が `keptLatin` に化けません。
- **候補票は現在の表で付け直したものを読む。** 「いまの表ならこの走行はどう見えるか」が候補票の問いだからです。
  コーパスは両方を `atRun` / `atCurrent` として並記し、H_run ≠ H_now の走行に印を付けます。
- **表の版をまたぐ比較は、ラベルでなく生の表記件数で行う**（原綴り n / 定訳形 n / 混在 n / その他の形）。
  生の件数は表に依存しないので、§1-11 の 35 / 5 / 3 は表を変えても消えません。
- 本設計より前の走行（hash 無し）は `nameTableHash: null` の印を持ち、`atCurrent` だけを持ちます。

取り込む走行の規則: `recognition.jaClauses` が 1 行以上あり（rev3 以降は `lines[]` が 1 行以上）、`error` が無いか `display gate ...` で始まる
もの。表示ゲートの失敗は名前の表記に無関係で、行は本物です。採取が壊れた走行（`capture produced no
caption lines` / play 失敗 / drain 失敗）は入れません。`stopDrainTimedOut` は行を入れて印を付けます。
`display.pages` を持たない走行（既存分）は `display.blocks` と original-on の `samples[].original` で
集計し、単位が節でなくブロックであることを印に残します。

`bench/results/` は gitignore 済みなので、コーパスは**この機械の中だけ**に育ちます。モデル入りの
プロファイルもこの機械にしかないので、それで足ります。共有したいのは表（`glossary.data.ts`）で、
コーパスではありません。

### 4.6 トークン費用

ループの中に LLM はいません。走行は node、集計は正規表現と数え上げ、候補票は Markdown 生成です。
score-ja の judge（agy）は**このループの外**に置きます（名前の分類に判定者は要らず、全体訳質は別の問い）。
費用が発生するのは候補票の行に `source` を付ける瞬間だけで、モデルに URL 探索を頼んでも
**行数 × 1 回**です。sora の問い②への答えは「はい、走行と集計はゼロ。人の仕事は候補票の行数」です。

### 4.7 `live2.mjs` に見える失敗モードと、バッチの生き残り方

| 署名 | どこで | 意味 | バッチの扱い |
|---|---|---|---|
| `play() ... video-only background media was paused to save power` | 再生開始（`:519-522` / `:614-618`） | ウィンドウが他の窓に隠れたか背面化した（README「fixture は 1 タブだけで前面」）。09-04 に 2 回 | 環境要因。**同署名は 1 回だけ再試行**。連続 2 回で「画面が隠れている」と判定してバッチを止める（以降の走行は全部空になるため）。恒久策（fixture の `muted` を外す等）は別スパイクで**測ってから** |
| `backlog did not drain within 60000ms` | 滞留排出（`:604`） | ウォームアップ中の音声が 60 s で捌けない（cold model / 負荷） | 1 回再試行。連続 2 回で停止（bench README の「同署名 2 連続は本物の FAIL」を踏襲） |
| `capture never reached the running state within 120000ms` | ready 待ち | cold model | 1 回再試行 |
| watchdog `process.exit(2)`（`:360-364`） | どこでも | `finally` が走らない。**Chrome とプロファイルロック・8123 番が残る** | バッチは**走行の前に必ず**: 8123 が LISTEN なら止める、プロファイルを掴む chrome.exe を PID で止める。verify skill の Doctor と同じ検査を機械に |
| `Execution context is not available in detached frame or worker` | worker 評価 | MV3 SW の再起動（README 既知） | 1 回再試行 |
| `no translation API available` | 起動直後 | プロファイルからモデルが消えた（`downloadable` / `unavailable`） | **再試行しない**。バッチ停止。数 GB の再 DL は人の判断 |
| `capture produced no caption lines` | 終了時 | 例外なしの空採取 | 失敗として記録・コーパスに入れない・再試行 1 回 |
| `display gate failed: ...` | 終了時 | 表示の不変条件違反 | **成功として取り込む**（行は本物）。印だけ残す |

再試行は署名ごとに 1 回、バッチ全体で「連続失敗 2 回で停止」を上限にします。理由は、失敗の多くが
環境要因で、3 回目の変種を試しても情報が増えないからです。バッチは走行ごとに `batch-<stamp>.json` へ
署名・再試行・所要時間を追記し、止まったときに何が起きたかを人が読めるようにします。

---

## 5. 受け入れ

### 5.0 分母と合否の定義（正本はここだけ）

4 巡のレビューで見つかった欠陥は、すべて「分母に何が入るか」と「合否が何を見られるか」の 2 点でした。
どちらも節ごとに言い直すたびにずれたので、ここに 1 度だけ書き、他の節は **D** / **A** を引きます。
ここと食い違う記述が他の節にあれば、ここが勝ちます。

**D（分母）: 走行の名前 X の英語側出現数 = 次の 2 つに含まれる X の出現数の和。**

1. overlay が受理した各行の**実効テキスト**。`acceptCommittedClause` が受理の瞬間（最後の早期 return
   `:1056-1066` の後・表示する `primary` の切り詰め分岐 `:1087-1113` を抜けた直後・`lastAcceptedPrimary` /
   `lastAcceptedSource` の更新 `:1115-1122` の前）に 1 回だけ計算する値で、**その行の `primary` が実際に
   切り詰められたなら** `source.slice(lastAcceptedSource.length).trimStart()` の尾、**切り詰められなかったなら**
   `source` の全文。切り詰めが起きる分岐は 2 つだけです。改訂（`source.startsWith(lastAcceptedSource)`・
   `:1079-1083`）で翻訳どうし（`:1088-1092`）かつ日本語も前の行の日本語で始まる（`primary.startsWith(lastAcceptedPrimary)`・
   `:1093-1104`）ときと、改訂で片方が英語素通しのとき（`:1105-1112`・英語の尾を表示）。改訂でも 1 つ目の日本語側の
   条件が外れた行は `primary` が `fullPrimary` のまま（`:1084`）で、overlay は**全文の翻訳を追記します**。
   その行の実効テキストは全文です。利用者は接頭辞の名前をもう 1 度見ているので、その出現は数えます。
   `isRevision` だけで尾にする（rev4）と、この行の接頭辞に出た名前が分母から落ち、尾の出現に接頭辞の形を
   帰属させるか、新しく表示された誤形を数え漏らして `nameExpectedRate` を上げます。
   overlay はこれを `lines[].text` に書き、同じ値をページの `sources[].text` に複写します（§4-1-5・§4-1-6）。
   集計は切り詰めを判定しません（overlay が立てた真偽値の結果を読むだけ）。
2. offscreen が翻訳前に捨てた節（`queue-drop`・§4-1-7）の全文。overlay に届かないので改訂の判定はありません。

**入らないもの**: 台本（周回数が走行で違う・§1-14）、ページの `sourceText`（全文の繰り返し・§1-8）、
`display.blocks` / `jaClauses`（表示に届いた後・§1-16）、順序 guard・watermark・重複で overlay が捨てた行
（表示に出ないと overlay が決めた行・§4-1-6）、`pendingFinals` のまま `clear()` / 破棄で消えた行（同）。
表示に届かず落ちた cue（`drops[]`）の行は**入ります**（受理はしたが表示できなかった行で、D の第 1 項）。

**A（合否）: 変更の対象名を X、その走行群で `expected` を持つ X 以外の各名前を Y として、次の 5 つ。**
比較と書いたものはすべて §5-3 の 1 つの形（走行ごとの率・一側 exact Wilcoxon・三値）で、上限値はどこにも
ありません。

**Y の範囲と `expected`。** `expected` は「決定論的な機構がその名前に与える形」で、機構は 2 つしかありません。
①その走行の表（H_run・§4-5）の行: `render` どおり（原綴りか `ja`）。②表に無いが `terms.txt` にあり、`with`
モードでページ由来になる語（§4-2 の規約でページ由来になる綴りだけが `terms.txt` にある）: **原綴り**。表が
与える形ではなく、ページ由来のマスクが原綴りで復元する（§1-3）という、§2-4 が「変えない」と言う既定そのものです。
これ以外の名前は「モデルの自由」で `expected` を持たず、**A の外**です: `without` モードの表外語（ページに無い）、
`without` モードの曖昧語（ページの名指し以外の証拠が無ければマスクされない・§1-2・§4-3）、`terms.txt` に置けない
綴りの語（§1-7 の `coronagraph`）。これらは生の表記件数・`nameVariants`・候補票（§3）で観測するだけです。
表外の名前に日本語表記の方針を作らない（§2-4）ので、A がそれらに何かを要求することはありません。
②の名前は `ja` を持たないので `keptLatin` になれず、`rejected` を持たないので `wrongKnown` はスクリプト混在の
2 類（§3）だけです。A-2 と A-4 はこの Y を同じ範囲で走ります（rev4 は Y を「表と `terms.txt` の和」と書き、
`expected` の無い名前で A-4 が計算できませんでした）。

1. `nameWrongKnown(X) = 0`（after の全走行）。0 は必要条件であって証明ではありません。5 走行で X の出現が
   15〜20 なら、0/20 が言えるのは真の率が 2 割に満たないことまでです。
2. 各 Y の `nameWrongKnown` 率: 後退の証拠なし。ゼロでなく後退なしなのは、Roman の赤が別件（§2-4）だからです。
3. `nameExpectedRate(X)`: after が before を**下回る**証拠なし（分母 D を必ず併記。分母を出さない率は読まない）。
4. 各 Y の `nameExpectedRate`: 後退の証拠なし。2 だけでは、Y が `expected` から `variant` / `missing` に落ちても
   `wrongKnown` が 0 のままなら見えません。表優先の順序（§2-5）や上限 4 の枠（`term-masking.ts:38-46`・`:66-79`）
   の奪い合いでページ由来の Y（上の②）が守られなくなる後退は、この項でしか捕まりません。②の `expected` が
   原綴りなのはそのためで、枠を失った語がカタカナに化ければ `variant`、消えれば `missing` に落ちて率が下がります。
5. `englishPassthrough` 率: 後退の証拠なし（名前を守って英語に落ちたら名前の改善ではない・§1-13）。

**結果**: 1 が破れるか 2〜5 のどれかが「後退」なら不合格。どれかが「判定不能」（走行数不足・分母を持たない走行・
§5-2 の検査に落ちた走行）で後退が無ければ判定不能。すべて「後退の証拠なし」で初めて合格。「後退の証拠なし」は
「後退なし」ではありません（§5-3 の試算）。Y は名前ごとに独立に比べ、Y の分母が 0 の走行はその Y の比較から
外します（before + after の全走行で 0 の Y は、そのクリップに無い名前なので対象外）。Y の範囲は走行群の
`termsMode` で変わる（`with` だけが②を持つ）ので、before と after は同じ `termsMode` の走行どうしで比べます。名前の数だけ検定が
並ぶので偽の「後退」は増えますが、その費用は走行のやり直しで、見逃しの費用は利用者に見える後退です。
向きはこれで固定します。

### 5.1 既存ゲートの評価

| ゲート | 測っているもの | 判定 |
|---|---|---|
| `wrongSenseRoma` | 既知の誤義 1 語（fixture 固有・正規表現に「ローマン許容」の判断を埋め込み） | **方向は正しい**（誤義ゼロは sora の裁定）。判断は Roman の行の `rejected` に移し、ゲートは表駆動の `nameWrongKnown` に吸収。「ロマン」を見逃している |
| `glossaryLatinKept / Lost` | 節単位の二値。英語側の取り方が構成で 3 通り（§1-9）。定訳どおりの「ケネディ宇宙センター」を**失敗に数える** | **測っているものが違う**。出現単位の分類（§5-2）に置き換える |
| `katakanaNameHits*` | 既知の音写リストとの一致 | 自身のコメントどおり下限。本走行で 2 と数えたが実物は 5 以上。**廃止**し、揺れ検出（§3）に置き換える。`ambiguous / plain` の内訳は新ゲートに引き継ぐ（マスク穴か証拠不足かの診断に有用） |
| `maskedNameOccurrences` | 出力に残った非曖昧語のラテン文字数 | 名前が違う。マスクで復元したか、モデルが自力で残したかを区別できない。**廃止**（新ゲートの `keptLatin` + `rung` が置き換える） |
| `romanKept` | fixture 固有の正の数 | 出現単位の `expected` に吸収 |
| `keepLatinSourceHits` | 英語側に名前があった回数 | 分母として**残す**。ただし取り方を §5-0 の D に変える。表示に届いた行から取ると、落ちた行の名前が分母から消える（§1-16） |
| `englishPassthrough` / `devLogPassthrough` | 英語のまま出た行 | **残し、名前の指標と必ず対で出す**（§1-13・§5-0 A-5）。後退の判定は §5-3 の順位検定で、最大値ではない |
| `devLogQueueDrop` | offscreen で翻訳前に捨てた節の数（`translate.ts:349`・`lineId` のみ） | **残す**。分母の補正に使う（§4-1-7）。content 側の cue 落下（`overlay.ts:1454-1469`）は数えていないので `drops[]` を別に持つ |
| `placeholderSurvivalRate` | 占位子の生存 | 導入以来 `null`（中継欠落・§1-10）。名前の指標の**上限を決める値**なので中継修正は前提作業。ただし本設計の分類は結果側から取るので、修正を待たずに動く |

### 5.2 新しいゲート: 出現単位の表記分類

**単位は「cue が束ねる原文行の集合」で、ページでも `cueId` の接頭辞でもありません。** `display.pages` の
各ページは cue の全文を `sourceText` に持ち（`overlay.ts:1707`）、`cueId` は `${line.id}:${index}`（`:1223`）
なので、1 つの英語節が分割（index）・ページ（pageId）にまたがって何度も現れます。ページごとに分類すると
`missing` と分母が膨らみます。tts2 はたまたま 1 節 1 ブロック（`043759`: 28 line id / 28 blocks）ですが、
theo には既に blocks ≠ line id の走行があり（`023448`: 43/42・`025920`: 52/51）、実クリップ（§4-2）では
常態です。

rev1 は「`cueId` の `:` より前で `line.id` に束ねる」でした。パイプラインは 1 ページ = 1 節 = 1 段を
保証していないので（§1-8）、これは 3 か所で壊れます:

- merge した cue の `cueId` は `1:0+2:0`（`overlay.ts:1431-1432`）。`:` で切ると連結した全文が行 1 に付き、
  行 2 は丸ごと消えて、後半の名前の出現数と `missing` が両方ずれます。
- 切り詰めが効いた改訂の cue は尾だけ表示して `sourceText` は全文（`:1068-1113`・`:1227`・§1-8）。ページの
  `sourceText` を分母にすると、前の節で既に表示した名前をもう 1 度数えて `missing` にします。
- merge は `fallback` しか見ない（`cue-queue.ts:56-59`）ので、ページに 1 つの `rung` を持たせると段別の
  内訳が壊れます。

3 つは同じ前提の破れです。局所の 3 修正ではなく単位を 1 つ変えます。ログ側は `sources[]`（§4-1-5）で
「行ごとの英語（表示に対応する部分）と段」を持ち、集計側は次の手順で単位を作ります。

手順:

1. `Date.parse(appearedAt) >= replayStartedAtMs` のページ、`Date.parse(acceptedAt) >= replayStartedAtMs` の
   `lines[]`、`Date.parse(droppedAt) >= replayStartedAtMs` の `drops[]` だけ残す（§4-1-2・§4-1-6）。3 つとも
   同じ切りで、検証（下）はすべて切った後の集合に対して行います。切っていない `drops[]` を切った `lines[]` に
   突き合わせると、前走行の drop（消去失敗）やウォームアップの drop の `sourceIds` が、振り直された同じ id の
   行に当たります。
2. `cueId` を**不透明な鍵**としてページを cue に束ねる（`:` でも `+` でも切らない）。cue の `sources[]` は
   そのどのページでも同じです。
3. 原文行 `id` を共有する cue を 1 つに繋ぐ（union-find）。できた連結成分が**単位**です。ほとんどは 1 行 1 cue、
   長い節を割った cue（`${id}:0` / `:1`）は 1 行 n cue、merge した cue は n 行 1 cue で、両方が混ざることも
   あります。`lines[]` にあってどの cue にも現れない id（落ちた cue・空の翻訳）は 1 行だけの単位になります。
4. 英語側 = **D**（§5-0）。`lines[]` の各 id の `text`（実効テキスト。表示を切り詰めた行なら尾、それ以外は全文）を
   1 回採り、offscreen で捨てた節（§4-1-7）を足す。ページの `sources[].text` は同じ値の複写で、検証①で
   `lines[].text` と一致することを見ます。集計は切り詰めを判定しません（overlay が判定した結果を読むだけ）。ページを 1 つも持たない単位は出力側が空なので、
   全出現が `missing` に落ちます。
   出力側 = 単位の全ページの `line0` / `line1` を `appearedAt` 順に連結した 1 文字列。
5. 表の語ごとに、英語側の出現数 n を行別に数え（同じ行に 2 回なら 2）、出力側で見つけた各形の件数を n を
   上限に割り当てる。優先順位は `wrongKnown` → `expected` → `keptLatin` → `variant`、余りが `missing`。
   `missing` は、その行の id が `drops[]` の `sourceIds` にあれば `droppedBeforeDisplay`、offscreen の節なら
   `droppedBeforeTranslation`、それ以外は `onScreen` に分けて報告します（合計は 1 つ）。
6. 段の帰属: 出現は**それを含む行の `rung`** に付きます。単位の行がすべて同じ段ならそのままです。段が 2 つ
   以上あり、かつ同じ名前が複数の行に出る単位だけは、出力側の形をどの行に返すか決められないので、その名前の
   件数を段別内訳では `mixed` に置きます（合計には入れる）。`mixed` の件数は報告に出します。多ければ merge の
   頻度そのものが問題です（§9-1）。

rev1 の手順 3（同じ `line.id` の `:0` / `pageId 0` への戻りを改訂の境目にする）は消します。`acceptedFinalIds`
（`overlay.ts:1050`）が同じ id を 2 度受けないので、この境目はありません。改訂は**別の id** で来て
（`overlay.test.ts:783` は id 1 → id 2）、`sources[].text` が「その行で表示に出た分」（切り詰めたなら尾、
全文を追記したなら全文・§5-0 D）を持つので、単位を分けるだけで正しく数えられます。表示のリセット（`:532`）の後に id が振り直されるかは実装時に `pages` で確かめ、同じ id が
離れた時刻に別の `text` で現れたら別の単位にします。

検証は集合で行い、件数の一致では行いません（件数は落下と無関係に 1 ずれる・§1-16）。集合はすべて手順 1 で
切った後のものです。①ページの `sources[].id` はすべて `lines[]` にあり、同じ id の `text` が一致する ②`drops[]` の
`sourceIds` はすべて `lines[]` にある（切りの前に受理され後に落ちた cue はここで破れます。巻き戻し前の排出
（`live2.mjs:604`）が待ち行列を空にしている前提なので、破れたら排出の失敗であって、drop を黙って残す側には
倒しません）③offscreen `queue-drop` の `lineId` は `lines[]` に**無い** ④`lines[]` の id 数 ≥ 単位に現れた id 数。
1 つでも破れたら走行に印を付け、率を出しません。

| 分類 | 条件 |
|---|---|
| `expected` | 表の状態どおり（原綴りなら原綴り、定訳なら `ja` の文字列） |
| `keptLatin` | 表は定訳だが原綴りのまま出た。**`expected` ではない**。`rung` 別に内訳を出す（救済段で起きたのか、占位子が復元されたのに原綴りだったのかを分ける） |
| `wrongKnown` | 次のいずれか。①表の `rejected` に載る表記（`ja` と原綴りの出現を除いた残りに対して照合する。「ローマン」の中の「ローマ」を拾わないため）②語内のスクリプト混在 ③名前内のスクリプト混在（§3） |
| `variant` | 上のどれでもないカタカナ表記（候補票へ） |
| `missing` | 出力側に対応する表記が見つからない（脱落） |

分類が付くのは `expected` を持つ名前（§5-0 A の Y と X）だけです。表に無くページ由来の `terms.txt` の語
（`with` モード）は `expected` = 原綴りで、`keptLatin` は起きず、`wrongKnown` は②③だけです。`expected` を持たない
語（`without` の表外語・曖昧語、`terms.txt` に置けない綴り）には分類を付けず、生の表記と件数だけを持ちます
（§4-4）。

**ゲートは名前単位で読みます。** 走行全体の `nameWrongKnown = 0` は issue-49 rev5 の到達目標として毎バッチ
報告しますが、変更ごとの合否にはしません。Roman のベースラインが 05:30 以降のすべての走行で赤（§1-13）なので、
全体ゼロを合否にすると Kennedy の変更は Roman の赤で永遠に落ち、Roman を直すまで何も受け入れられません。
変更ごとの合否は **§5-0 の A**（5 項）で、ここでは繰り返しません。率はすべて `件数 / D` で、分母を出さない率は
読みません（README の `phraseBoundarySamples` と同じ規律）。

観測は 1 つ: **`nameVariants`**。バッチ内の名前ごとの異なる表記数。バッチをまたいで増えないこと。
これは合否でなく、候補票の入力です。

`without` モードの曖昧語はゲートに入れません（§4-3・§5-0 A の Y の外）。マスクされないので、表を測っておらず
モデルを測っています。この分は候補票と表外の基準線に使います。

### 5.3 「効いた」と言える計測

**比較の形（全ゲート共通）。** rev2 は「ベースラインの最大値以下」を後退なしにしていました。11 走行の
`wrongSenseRoma` は最大 9 / 平均 4.5 / 中央値 3 なので、新しい 5 走行がすべて 9 でも通り、率が倍になっても
検出しません。`englishPassthrough` の上限 2 は 1 本の走行の値を全走行に許します。極値ではなく分布を比べます。

- **単位は走行、統計量は率。** 走行 i の率 r_i = 件数 / その走行の分母（名前の指標は §5-0 の D。
  `englishPassthrough` は行数 / `lines[]` の行数）。件数のまま比べると、`video.loop` の周回数（3〜4・§1-14）の差が
  そのまま差に見えます。名前ごとに別の検定で、ある名前の分母が 0 の走行はその名前の比較から外します（A の結果の項）。
- **報告するもの**: before / after それぞれの pooled 率（Σ件数 / Σ分母。**和を 2 つとも併記**）と、走行ごとの率の
  最小 / 中央値 / 最大。pooled 率は大きさを読むためで、合否には使いません（走行間の分散を無視するため）。
- **合否は、走行ごとの率の分布を before と after で比べる一側の exact Wilcoxon 順位和検定**（Mann–Whitney。
  同順位は中位順位。`naming-corpus.mjs` が組合せを数え上げて計算。5 vs 10 で C(15,5) = 3003 通り・依存無し）。
  悪化の向きで p < 0.05 なら「後退」。**0.05 は慣例であって、この計測で測って決めた値ではありません。**
- **結果は三値**: 後退 / 後退の証拠なし / 判定不能。「後退の証拠なし」は「後退なし」ではありません（下の試算）。
- **走行数**: after が 5 未満、before が 5 未満、または分母を持たない走行（`lines[]` が無い・§5-2 の検査に落ちた）が
  混ざれば**判定不能**で、合格ではありません。5 vs 5 で到達できる最小の一側 p は 1/252 ≈ 0.004、5 vs 10 で
  1/3003 なので、判定は原理的に可能です。§4-3 の「5 走行から」はこの下限で、検出力から決めた数ではありません。
- **before の母集団**: 変更前の build（`build-info.json` の `revision` が一致・§4-4）で、rev3 の記録（`lines[]`）を
  持つ走行 5 本以上。**変更後の走行と同じ日に、間を空けずに回します**（バッチは build を 1 回揃えて回すので、
  before 5 本 → 変更・ビルド → after 5 本）。既存の 11 走行は build を記録しておらず（§1-9）、少なくとも `051858`
  は別の build です（§1-13）。分母も持ちません。参照値としては引きますが、どの判定の before にもしません。
- **見える大きさは未測です。** 既存 11 走行の**件数**（率でなく件数。分母が無い）で順位検定を試算すると:
  Roman の 5 走行がすべて 9 → p ≈ 0.007（後退。11 走行相手なら ≈ 0.005）。5 走行が 5 / 6 / 6 / 8 / 8（平均 6.6・
  before の 05:30 以降 10 走行は平均 5.0）→ p ≈ 0.18（証拠なし）。素通しの 5 走行がすべて 2 → p ≈ 0.002（後退）。
  0 / 0 / 2 / 2 / 2 → p ≈ 0.077（証拠なし）。つまり 5 走行で見えるのは「全走行が before の上端に並ぶ」級の後退で、
  before の範囲の内側に収まる悪化は見えません。最小検出効果を数字にするには、before 走行からの並べ替えで
  検出力を計算する（率に δ を足して 5 本を引き直し、80% で検出できる δ を求める）作業が要り、rev3 は
  その数字を書きません。

**Kennedy Space Center を定訳に移す変更を例にすると**（§2-3 の順 3 で `source` が取れた後の話です）:

- 対象: tts2 相当のクリップ・original-on・prompt-api/base・`with` 語モード・before 5 走行 + after 5 走行。
- 効いたか（A-3）: after の `nameExpectedRate(Kennedy)`（`expected` = ケネディ宇宙センター）の走行分布が、before の
  `nameExpectedRate(Kennedy)`（変更前の表では原綴りが `expected`・§4-5 の H_run）の分布を**下回らない**こと
  （順位検定・向きは after が低い側）。占位子の生存が両方の上限なので、定訳が原綴りと同じ率で復元されるのが
  期待値です。`keptLatin` は `expected` に入りません。rev2 は既存走行の出力側 43 件から 81% を床にしていましたが、
  分母が出力側（脱落を数えられない）で、build も混ざり、点推定を床にすると真の率が同じでもおおむね半分の
  確率で落ちる形でした。取り下げます。0 → 生存率の級の変化は 5 走行で見えます（上の試算）。80 → 90 は
  見えません。細かい差を主張するなら走行を増やす前に**出現密度の高い台本**（§4-2 公有英文）を足します。
- `nameWrongKnown(Kennedy Space Center) = 0`（A-1・after 全走行）。既存走行の混在 3/43（§1-11）は変更前の表でも
  `wrongKnown` です（§3）。
- Y = Roman / NASA / Goddard（表・`expected` は原綴り）と NASA Goddard（表外・ページ由来・`expected` は原綴り・
  §5-0 A の②）の `nameWrongKnown` 率（A-2）と `nameExpectedRate`（A-4）、`englishPassthrough` 率（A-5）に後退の
  証拠が無いこと（同じ検定）。`coronagraph` は Y に入りません。小文字始まりで一度も抽出されず（§1-7）、before でも
  after でも守られていない語なので、比べるものがありません（§4-2 で `terms.txt` から外します）。この変更は
  表優先の順序（§2-5）を含むので、A-4 が見るのはまさに「Kennedy が枠を取って NASA Goddard が守られなくなった」
  型の後退です。
- 「ケネディの Space Center」型の混在は `wrongKnown` に落ちるので（§3）、A-1 で読みます。
  `nameVariants(Kennedy)` は観測として、after で増えていないこと。
- 標本の限界: 95 秒クリップに Kennedy は 1 走行 3〜4 出現（台本 1 周に 1・§1-14）、5 走行で 15〜20。

---

## 6. ディープラーニングか

**違います。** 作るのは「1 行に出典が付いた対応表」と「数えるスクリプト」です。重みは学習しません。
モデルは 1 バイトも変わりません（Chrome の Translator / Gemini Nano は拡張から微調整できませんし、
必要もありません）。

sora が動ける言い方にすると:

- ここでの「学習」＝**表の行が増えること**。スペルチェッカのユーザー辞書と同じ種類のものです。
- ディープラーニングになるのは「（英, 日）の対を数千〜数万集めて翻訳モデルを再学習する」ときで、
  この拡張ではできず、しなくてよい。壊れているのは分布ではなく数十個の名前だからです。
- 見分けの目安: **直し方が「行を足す」なら表、「例を 1 万件見せる」なら学習**。今回は前者です。
- モデルが役に立つ場所は 1 つだけ、候補票の行に出典 URL を探すこと。費用は月に数十行ぶんです。

---

## 7. 作らないもの

- **プロンプト側の対策。** 3 回測って効かず、全体訳質を下げました（§1-6）。§2-5 の救済プロンプトの
  ブロック分けは「逆を言わない」修正で、効果を当てにしていません。
- **カタカナ音写の列挙リストで壊れ方を数えること。** 知っている崩れ方しか見つけられません（`live2.mjs:123-129` の
  コメントが自ら言っている）。§3 の揺れ検出で置き換えます。表の行の `rejected`（§2-5）は数える道具ではなく
  決めた誤りの記録で、回帰の検出にだけ使います。件数は補集合の `variant` が持ちます。
- **最頻表記の自動昇格。** Roman で都市のローマを選びます（§3）。表への追加は常に出典付きで人が行います。
- **拡張内で育つ実行時の表**（`chrome.storage` に表記を貯める等）。モデルの誤りを学び、利用者ごとに
  表示が変わり、再現性が消えます。表はビルド時の成果物です。
- **英語の固有名詞検出器（NER）**をバンドルに入れること。依存が増え、ASR が大文字を返さないので
  信号が無い（`3bcdc3b`）。
- **第 2 のドライバ。** `live2.mjs` を使います。
- **実行時に日本語資料を取りに行くこと。** 拡張はデバイス上で完結させます。出典確認は表を書く時の作業です。
- **judge（agy）を名前のループに入れること。** 分類は機械で足り、全体訳質の採点とは別の問いです。
- **`GLOSSARY_TERMS` の決定論化。** 普通名詞は文脈が要ります（§2-2）。
- **表を読むための第 2 の解析器。** 正規表現も vitest の照合もやめ、TS を複写して import します（§2-5）。

---

## 8. 実装の順番（最小・各段が独立に検証できる）

1. **字幕ログのページを結果 JSON に残す**（`live2.mjs` と `vite.config.ts` の hook）。
   `Date.parse(appearedAt) >= replayStartedAtMs` で切り、`captionLogCleared` / `pagesUnparsed` / `build` /
   `nameTableHash` を書く（§4-1-2・§4-4）。`nameTableHash` は hook が `dist/build-info.json` に書く値で、
   複写との照合に失敗したら走らない。既存 11 走行では取れませんが、以後の走行は英語全文と対応が取れます。
   検証: 1 走行で `display.pages.length` が `display.blocks.length` と一致し（ウォームアップの 1 枚が落ちて
   いて、全ページが落ちてはいない）、`sourceText` が `original` 行より長い。表を 1 字変えてビルドせずに
   走らせ、bench が止まること（存在の確認と作動の確認は別）。ログに `lines[]` / `drops[]` があれば（6 の後）
   同じ切り方（`lines[]` は `acceptedAt`・`drops[]` は `droppedAt`・§5-2 手順 1）で `result.display.lines` /
   `drops` に書き、NaN は `linesUnparsed` / `dropsUnparsed` に数える。
2. **集計 `naming-corpus.mjs` と候補票。** 表は §2-5 の複写 import で読み、`loadKeepLatinEntries` の
   正規表現はここで消します。既存の結果ファイル（`display.blocks` と original-on の `samples[].original`）
   だけでも §1-11 の集計は出るので、1 を待たずに書けます。検証: §1-11 の **original-on 11 走行**（stamp 列挙）
   の生の表記件数を再現する（Roman 117 / 52 / 9 / 4、Goddard 70 / 7 / 2 / 2、Kennedy 35 / 5 / 3）。
   `sources[]` を持たないページ（6 の前の走行）は `cueId` を鍵にした cue 単位で数え、`unit: "cue"` の印を
   残します（改訂と merge の二重計上を含む下限）。6 が入った走行から §5-2 の単位に切り替わります。
   率と順位検定（§5-3）もここに入れます。分母を持たない既存走行は `rate: null` の印で件数だけ出します。
3. **表の形（`NameTerm`）とテスト**（全行 `source` 必須・`ja` 必須・`rejected` の形）。既存 33 行の出典
   付け。データだけの変更。
4. **定訳の復元と表優先の順序、救済プロンプトのブロック分け**（`term-masking.ts` / `translate.ts` /
   `glossary.ts`）。検証: 単体テスト＋ §5-3 の 5 走行。
5. **ケース定義のファイル化とバッチ**（`live2-batch.mjs`）。検証: 失敗署名を 1 つ人為的に起こして再試行と
   停止を目視する（存在の確認と作動の確認は別）。`terms.txt` の全行を実物の `extractPostContextTerms` が返す
   単体テスト（§4-2）をここで足し、tts2 の `coronagraph` を `terms.txt` に残したまま走らせて落ちることを先に
   見せる（fail-before）。
6. **字幕ログに `sources[]`（`id` / `text` / `rung`）と `fallback`、`lines[]` と `drops[]` を足し、offscreen の
   `queue-drop` に `text` を足す**（拡張側の 3 点・§4-1-5〜7）。
   検証: 単体テストで ①merge した cue のページが 2 行の `sources` を持つ（`overlay.test.ts:1444` の状況）
   ②改訂の cue の `text` が尾だけ（`:783` の状況）③段の違う 2 行を merge したページが行ごとの `rung` を持つ
   ④待ち行列の圧力で落ちた cue の行が `lines[]` にあり、`drops[]` に id と `droppedAt` があり、ページに**無い**。
   rev2 の形ではこの行が分母から消えることを先に見せる（fail-before）⑤offscreen で捨てた節の `text` が
   `__devLog` に届く ⑥改訂の行（`:783` の状況）の `lines[].text` が尾だけで、ページの `sources[].text` と一致する。
   rev3 の形（全文）では接頭辞の名前が 2 度数えられることを先に見せる ⑦順序 guard（`overlay.ts:1056-1066`）で
   捨てた行が `lines[]` に**無い**。rev3 の位置では入ることを先に見せる ⑧改訂だが翻訳どうしで日本語が前の行の
   日本語で始まらない行（`:1093-1098` の条件が外れる状況）の `lines[].text` が**全文**で、その cue のページに接頭辞の
   訳が再び出ている。rev4 の形（`isRevision` で尾）では接頭辞の名前が分母から消えることを先に見せる
   ⑨`droppedAt` が切りより前の drop が、bench の切り（1 の後）で `result.display.drops` に**無い**。
   走行では、マスクなし再試行の行がその印を持つ。

1〜2 は今夜から回せます。6 は小さく、2 の単位が本来の形で動くのに要るので、2 と同じ日に入れます。
分母（§5-3）も 6 が無いと出ないので、受け入れの判定は 6 の後の走行からです。
3〜4 が sora の問い①への実装、5 が問い②の仕上げです。

---

## 9. 確信度の低い点と、sora の裁定が要る点

### 9.0 裁定済み

**1 番は 2026-09-04 に sora が「定訳にする」と裁定しました。**
施設名・組織名は、日本語に定訳があるならそちらを使います。
`glossary.data.ts` ヘッダの「組織名は原綴り」はこの裁定で置き換わります。
実装時にあのコメントを書き換えます。

**この裁定は 2 番を選択ではなくさせます。**
下の 3 行はすべて JAXA が出典で、NASA 自身の日本語資料ではありません。
持ち主の資料だけを認める代案を取ると、1 番の裁定を実行する手段がなくなります。

### 9.0.1 最初の 3 行（出典確認済み・2026-09-04）

| 英語 | 日本語 | 出典 |
|---|---|---|
| Nancy Grace Roman Space Telescope | ナンシー・グレイス・ローマン宇宙望遠鏡（短縮形「ローマン宇宙望遠鏡」） | JAXA 宇宙科学研究所 `isas.jaxa.jp/topics/003741.html` |
| Kennedy Space Center | ケネディ宇宙センター（正式「ジョン F.ケネディ宇宙センター」） | JAXA 宇宙情報センター `spaceinfo.jaxa.jp/ja/ksc.html` |
| Goddard Space Flight Center | ゴダード宇宙飛行センター | JAXA GPM-DPR `satnavi.jaxa.jp/gpmdpr_special/column/2013/post1118.html` |

実測で出ていた「ローマ」はこれで誰の意見でもなく誤りと言えます。
短縮形が「ローマン宇宙望遠鏡」であることも同じページにあります。
あわせて「グレース」ではなく**「グレイス」**です。推測で書くと間違えます。

**権威側も一貫していない点を 1 つ見つけました。**
JAXA には「ゴダードスペースフライトセンター」と書いているページもあります
（`satnavi.jaxa.jp/gpmdpr_special/column/2014/post0225.html`）。
出典が 1 つあれば決まるという規則はここで破綻します。
同一の権威が 2 通り書いているときの決め方を規則に追記する必要があります（未着手）。

### 9.1 残りの裁定待ち

裁定が要る 4 点（本文は選んだ案で書いてあります。**1 番は裁定済み・2 番は 1 番に従属**）:

1. **§2-3 の順 1 を「組織名は原綴り」より上に置いたこと**（確信度: 中）。日本語資料に従えば
   Goddard も日本語表記に来る可能性があり、現行ヘッダの方針と衝突します。これは方針の変更です。
   裁定が「組織は原綴り、施設名だけ定訳」なら、順 1 に「施設・作品・地名に限る」を足すだけで
   規則の形は保てます。
2. **第三者の権威ある日本語資料を出典として認め、原綴り側にも出典を必須にすること**（§2-3 順 3・確信度: 中）。
   rev0 は持ち主の資料が無いとき出典なしで原綴りに倒していました。選んだ案は「JAXA・国立機関・学会・辞典級の
   資料なら `conventional` として、カタカナでも原綴りでも、その表記で入れる。出典が無ければ表外」。
   代案は「持ち主の資料だけを認める」で、その場合 NASA 系の名前は（NASA が日本語ページを持たなければ）
   すべて表外に落ち、Kennedy の定訳は実現しません。
3. **表の行に `rejected`（決めた誤り）を持つこと**（§2-5・確信度: 中）。§7 の「列挙で数えない」と
   両立させる線引きは本文に書きましたが、「結局リストではないか」という読みはあり得ます。代案は
   `wrongKnown` をスクリプト混在の 2 類だけにすることで、その場合「ローマ」（誤義）は `variant` に落ち、
   誤義撲滅の合否が機械から消えます。
4. **受け入れの名前単位化**（§5-0 A・確信度: 中）。走行全体の `nameWrongKnown = 0` を到達目標に格下げし、
   変更ごとの合否を A の 5 項（対象の名前ゼロ + 他の名前は `wrongKnown` と `expected` の両方で後退の証拠なし +
   素通し対。比較は §5-3）にしました。issue-49 rev5 の
   誤義撲滅をゆるめる読みができるので、裁定が要ります。代案は全体ゼロを合否に残すことで、その場合
   Roman の赤（§1-13）を先に直すまで表の変更は 1 つも受け入れられません。

確信度の低い点:

- **表優先の順序変更**（§2-5・確信度: 中）。ページ由来を先に置いた現行順に依存する単体テストがある
  可能性があり、`ambiguous` の証拠判定（ページが名指し）との相互作用は実装時に一度測ります。
- **§5-2 の `mixed`（段が混ざった単位）の頻度**（確信度: 低）。merge は待ち行列が詰まったときだけ起きる
  （`overlay.ts:1393`）ので tts2 では稀のはずですが、実クリップでは分かりません。多ければ「段をまたぐ merge を
  禁じる」（`cue-queue.ts:56-59` に `rung` の一致を足す）を別件で測ります。表示の都合を計測の都合で変えることに
  なるので、本設計では選びません。
- **表示リセット後の id の振り直し**（`overlay.ts:532`・確信度: 中）。同じ id が離れた時刻に現れる経路が
  あるかは実装時に `pages` で確かめます（§5-2）。
- **共起による候補抽出の偽陽性率**（§3・確信度: 低）。台本 1 本だと「宇宙望遠鏡」が Roman の候補に
  混ざります。台本が増えれば消える種類の誤りですが、増えるまでは候補票を人が読む前提です。
- **occlusion の恒久策**（§4-7）は未測です。`muted` を外すと機械で音が鳴る。別スパイクにします。
- **順位検定が 5 走行で見える大きさ**（§5-3・未測）。件数での試算は「全走行が before の上端に並ぶ」級しか
  見えないと言っています。率での検出力は before 走行が揃ってから並べ替えで測り、それまで数字を書きません。
- **offscreen `queue-drop` の中継**（§4-1-7・確信度: 中）。`061735` では 2 件届いていますが、届かなかった走行と
  起きなかった走行を区別する手段がありません。
