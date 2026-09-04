# 設計: 追記型 2 行表示バッファ（YouTube 型の据え置きブロック）

Status: rev1（敵対レビュー APPROVE-WITH-NOTES。実装時に下記 3 点を必ず満たす）
Date: 2026-09-01
Branch: i67-unattended-live2 時点のコードを基準に読解

動機: 実地フィードバックの起点は「YouTube の自動字幕を録画して見比べたら、あちらの方が
はるかに読みやすい」。YouTube のブロックは 2 行のまま位置が動かず、新しいテキストは下段に
足され、溢れた上段だけが上に抜ける。こちらは cue 単位で全面差し替えなので、放出のたびに
読者が先頭から読み直しになる。翻訳精度側（#49 / #50 / #63）が一巡した今、残っている
品質項目のうち体感差が最も大きいのがこれ。

---

## 現状の事実（file:line）

1. 表示の入口は `showCaption(line)`（`overlay.ts:377-391`）。`final` は
   `receiveCommittedClause`、interim は `receiveTentative` に分かれる。
2. final は `ja` 未着なら `pendingFinals` に滞留し、翻訳到着後に `acceptCommittedClause`
   へ渡る（`overlay.ts:852-883`）。`acceptedFinalIds` の最大値より小さい id は捨てられる
   （`:895-905`）。
3. `createCueSegments`（`:928-971`）が `splitCueText(primary, MAX_CUE_UNITS)` で cue に割り、
   各 cue の `formattedPrimary` を `wrapCueText(part, MAX_LINE_UNITS)` で作る。
   `MAX_CUE_UNITS = 28` / `MAX_LINE_UNITS = 14`（`cue-text.ts:1-2`）。
   **`wrapCueText` の戻り値はすでに `"\n"` 連結の行列**（`cue-text.ts:266-274`）。
4. `displayCue` は `cueContainer.replaceChildren(element)`（`:1272`）。
   **これが「毎回まるごと入れ替わる」の実体**。`.caption-primary` は cue ごとに 1 個で、
   同時に存在するのは常に 1 個（`:1300-1329`）。
5. 滞留は通常 1500ms / 加速時 1000ms（`explicit-stop-drain.ts:7-8`）。加速は待ち cue 数 >= 2
   または drop 発生で入る（`overlay.ts:40, 1233-1254`）。
6. 待ち行列は 6 本上限で、`decideCueQueueDiscipline` が隣接併合（合計 <= 28 units）を試み、
   無理なら先頭から drop（`cue-queue.ts:24-108`、`overlay.ts:1081-1202`）。
7. 行列が空になると 5000ms 後に `is-fading`、さらに 350ms 後に `cueContainer` を空にして
   `onCaptionFadeOut` を呼ぶ（`overlay.ts:2185-2299`）。
8. **`--primary-slot` は `fontSize * 1.16 * 2`**（`:2087-2094`）。表示枠はすでに厳密に 2 行分
   の高さで、`.caption-primary` は `white-space: pre-line` / `overflow: hidden`（`:2668-2685`）。
   3 行目は無音で切られる。
9. `inspectCueMutations`（`:1331-1396`）は「表示中の cue のテキストがその場で書き換わった」を
   事故として `console.error` + `host.dataset.cueMutations` を上げる。ただし **snapshot と現在値
   が一致していれば何もしない**（`:1368-1372`）。
10. `hasPendingCaption`（`:556-563`）が false なら content 側は即 drain 完了を通知する
    （`index.ts:2366-2373`）。drain の終端はフェード完了イベント（`index.ts:2427-2449`）。
11. tentative は `.caption-tentative` という独立要素（`:285-297, 1027-1036, 2709-2729`）。
    committed ブロックとは DOM も CSS も分離済み。
12. `showOriginal` は readonly で構築時固定（`:114, 236-237`）。切り替えは overlay 再構築。
13. bench は 300ms ごとに `.caption-primary` を集め、全体連結が前回と違うときだけ push し、
    最後に `"\n"` を除去して `jaClauses` にする（`live2.mjs:339-362, 391-395`）。
    gates も score-ja もこの `jaClauses` が入力（`live2.mjs:407-422`、`score-ja.mjs:68-99`）。

### 現状の表示契約（1 の答え）

| 問い | 現状 |
|---|---|
| cue はどれだけ残るか | 次の cue が来るまで。最低 1500ms（加速時 1000ms）。次が無ければ 5000ms 表示 → 350ms フェード |
| 何が置き換えるか | 次の cue。`replaceChildren` で `.caption-cue` ごと丸ごと |
| いつ消えるか | フェード完了（`:2289-2297`）／ `clear()`（`:393-430`）／ overlay 破棄 |
| 行予算を超えたら | `splitCueText` が 28 units 単位の cue 列に割り、各 cue が `wrapCueText` で最大 2 行。長文は「2 行の紙芝居」を 1.5 秒ごとにめくる形になる |

読みにくさの原因はここに尽きる。上段も下段も毎回同時に別物へ変わるので、視線の固定点が無い。

---

## 設計

### 方針: 分割規則には触らず、**cue の「見せ方」だけを行単位の追記に変える**

`wrapCueText` が返す `"\n"` 区切りの各行は、#47 の
`findNaturalTextBoundary`（助詞境界のボーナスと拒否、カタカナ連続禁止、URL 保護、最小
セグメント長）を通った境界でしか切れていない（`cue-text.ts:239-264, 371-469, 637-683`）。
つまり **追記の単位を「`formattedPrimary.split("\n")` の 1 要素」に取れば、#47 の不変条件は
定義上そのまま保たれる**。新しい境界判定を一切書かない、というのがこの設計の核心。

#### A. 表示ブロックを永続 2 要素にする

`cueContainer` の中に `.caption-cue` を 1 個だけ常設し、その中に `.caption-primary` を
**2 個**（上段 / 下段）持つ。通常運転で `replaceChildren` は呼ばない。

```
appendLine(text, originalText) {
  this.blockLines[0] = this.blockLines[1];
  this.blockLines[1] = text;
  // 書く前に snapshot を更新する（理由は D）
  this.cueTextSnapshots.set(this.blockElement, expectedText);
  this.topLine.textContent = this.blockLines[0];
  this.bottomLine.textContent = this.blockLines[1];
  this.originalLine.textContent = originalText;
}
```

CSS は `--primary-line-slot`（= `fontSize * PRIMARY_LINE_HEIGHT`）を 1 本足し、
`.caption-primary` の高さをそれに変える。`--primary-slot` の総高（2 行分）は不変なので、
バー高さの計算（`:1989-2006`）も `--original-slot` / `--tentative-slot` も触らない。

#### B. cue の滞留予算を行に分配する（タイマは 1 本のまま）

cue の滞留は変えない。cue が active になった時点で
`pendingLines = cue.formattedPrimary.split("\n")` を持ち、`activeCue.shownAt` を基準に
`shownAt + dwell * k / lineCount`（k = 1..lineCount）を刻み目にする。

- k < lineCount の刻みでは `pendingLines` から 1 行を追記する
- k = lineCount の刻みで初めて次の cue へ進む

結果、**1 cue あたりの総表示時間は現状と 1ms も変わらない**。したがって
`MAX_WAITING_CUES` / `CUE_ACCELERATION_THRESHOLD` / `decideCueQueueDiscipline` の併合・drop・
加速判定・`CAPTION_DRAIN_WAIT_MS`（`explicit-stop-drain.ts:12-17`）はすべて無改修で通る。
一時停止・再開も `shownAt` 補正（`:630-631`）から刻みが導出されるので、そのまま効く。

`lineCount` は導出上 1 か 2 にしかならない（`splitCueText` の各 part <= 28 units、
`wrapCueText` は 1 行目 <= 14 units かつ残り <= 14 units を保証する。
`cue-text.ts:229-264`）。ただしこれは読解による導出なので、E-1 のテストで実測して固定する。

#### C. フェードと可視判定の条件を行に合わせる

`scheduleCaptionFade`（`:2185-2205`）と `tryAdvanceCue`（`:1222-1231`）の
「`waitingCues.length > 0` なら張らない」に **`pendingLines.length > 0`** を足す。
`updateCaptionVisibility`（`:1421-1439`）の `activeCue !== null` は
「ブロックに文字がある」に置き換える。フェード完了（`:2289-2297`）ではブロックを
`["", ""]` に戻す。

#### D. 変異ウォッチドッグを「意図しない書き込み検出器」に読み替える

`inspectCueMutations`（`:1331-1396`）にとって追記は定義上「表示中テキストのその場書き換え」
であり、放置すれば追記のたびに `console.error` が出て `cueMutations` が発火する
（bench / verify skill の観測値でもある）。かといって外すのは、実在するガードを目隠しにする。

`inspectCueMutations` は snapshot と現在値が一致すれば何もしない（`:1368-1372`）。
MutationObserver のコールバックは microtask で後から走るので、**A の書き込みの直前に
snapshot を更新すれば、意図した追記は一致して素通りし、overlay が意図していない書き込み
だけが従来どおり事故として計上される**。ガードの意味は弱まらず、むしろ狭く正確になる。
変更は `appendLine` 内の 1 行だけ。

#### E. 品質測定を DOM 描画から切り離す（台帳）

shadow root に `display: none` の `.caption-ledger` を常設し、`acceptCommittedClause` が
cue を受理した時点で `primaryText`（**折り返し前・分割後**の文字列、現行の DOM スクレイプが
復元しようとしていたものそのもの）を 1 要素ずつ append する。上限 400 件のリングにして
長時間セッションで DOM が膨らまないようにする。

これは追記表示のためではなく、測定のため。現行の 300ms サンプラ + 全体一致 dedup
（`live2.mjs:339-362`）は、(a) 1 tick 内に出て消えた cue を落とす、(b) 同一テキストの再出現を
状態変化として二重に拾う、という 2 つの経路で母数が揺れる。実測の
englishPassthrough が同一条件で 5/37 と 13/36、**分母まで動いている**のは、翻訳側だけでなく
サンプラ由来の可能性がある（確信度: 中。E-3 で切り分ける）。台帳なら母数は決定的になる。

---

## 決定表

| 状況 | 動作 | 根拠 |
|---|---|---|
| ブロックが半分埋まっている（`["", "A"]`）ときに新しい文が来る | リセットしない。新しい行を下段に追記し、A が上段へ上がる。文の切れ目で空行やクリアを挟まない | 据え置きが読みやすさの本体。文ごとに空けると YouTube と同じ「視線の固定点」が消える |
| ブロックが埋まっている（`["A", "B"]`）ときに新しい文が来る | B が上段へ、新しい行が下段へ。A は消える | 追記型の定義そのもの |
| ブロックより長い文 | 既に `splitCueText` が 28 units の cue 列に割っている。各 cue が 1〜2 行を追記するので、連続した上方向スクロールになる。文全体の表示時間は現状と同じ | `overlay.ts:944-947`、設計 B |
| 無音（放出が止まる） | ブロックは最後の 2 行を保持。`pendingLines` と `waitingCues` の両方が空になってから 5000ms → 350ms フェード → 両行を空に | `:2185-2299`、設計 C |
| 停止クリック（v0.4.5 drain） | `hasPendingCaption()` に `pendingLines.length > 0` を加える。加えないと最後の 1 行が残ったまま drain 完了を返し、content 側が即通知して末尾が切れる（`index.ts:2366-2373`）。行を吐き切ってから通常のフェード → `onCaptionFadeOut` → `postExplicitStopDrainComplete` | `:556-563`、`index.ts:2427-2449`。**この設計で最も壊れやすい 1 点** |
| 新しい capture | `clear()`（`:393-430`）で `blockLines = ["", ""]` にし、両要素を空文字にする。`pendingLines` も捨てる。前 capture の 2 行を持ち越すと、読者に stale と live の区別が付かない | `index.ts:755, 2554` の既存 clear 経路に相乗り |
| interim（tentative）行 | 現状のまま。`.caption-tentative` は独立要素で、committed ブロックには一切書かない。final（id >= tentativeId）到着時に `clearTentativeThrough`（`:850, 1038`）が消え、同じ final の行が上のブロックへ積まれる | `:285-297, 2709-2729`。tentative をブロックに昇格させると、interim 更新のたびに下段をその場で書き換えることになり、消そうとしているちらつきが行単位で復活する |
| showOriginal のトグル | 変更なし。`showOriginal` は readonly で overlay 再構築（`:114, 236-237`）＝ clear 相当なので、ブロックは空から始まる。`.caption-original` はブロックに 1 個だけ持ち、行を追記した cue の `originalText` で更新する（1 cue の 2 行は同じ原文を共有するので、変化は cue ごとに高々 1 回） | `:1315-1321`、`:2095-2104` |
| 順序逆転・重複 id | 変更なし。`acceptedFinalIds` と単調ゲート（`:895-905`）と watermark（`:1398-1405`）が現状どおり先に弾く。追記層は受理済み cue しか見ない | 既存不変条件を追記で緩めない |
| 行列あふれで cue が drop される | 変更なし。drop された cue の行は現れず、スクロールが飛ぶだけ。drop カウンタ（`:1170-1172`）も従来どおり | `cue-queue.ts:88-96` |
| 再生の一時停止 / 再開 | 変更なし。刻みは `activeCue.shownAt` から導出され、再開時の `shownAt` 補正（`:630-631`）がそのまま効く。片方の行だけ出た状態で凍る場合があるが、それは現状の「cue 途中で凍る」と同性質 | `:610-644` |

---

## 受け入れ

### E-1. 単体（vitest + jsdom。`overlay.test.ts` に既存ハーネスあり）

`overlay.test.ts:1-46` の `createOverlay()` と fake timer をそのまま使う。

| # | 判定 |
|---|---|
| E-1-1 | `cue-text.test.ts` の既存コーパス全件で `wrapCueText(part, 14).split("\n").length <= 2`。設計 B の `lineCount ∈ {1,2}` を導出でなく実測で固定する |
| E-1-2 | 追記のみ不変条件: 台本化した `showCaption` 列をタイマ送りし、各ステップで `[top.textContent, bottom.textContent]` を採る。ブロックが変化したすべての遷移で `newTop === oldBottom` |
| E-1-3 | 文間で空にならない: 最初の追記からフェード開始までの全ステップで `["", ""]` が現れない |
| E-1-4 | `pendingLines` が残っている間 `hasPendingCaption()` が true（drain ガード） |
| E-1-5 | 追記系列を通して `host.dataset.cueMutations === "0"`。かつテストが行要素へ直接書き込むと `"1"` になる（ガードが生きている証拠を両側で取る） |
| E-1-6 | `clear()` 後にブロックが `["", ""]` |
| E-1-7 | 1 cue の総表示時間が変更前と一致（`CUE_MINIMUM_DISPLAY_MS` 単位で、次 cue が出るまでの経過を assert） |

### E-2. bench（`live2.mjs` の 300ms ループをそのまま使う）

サンプラを `.caption-primary` の羅列ではなく順序付きの組 `[top, bottom]` として
`window.__blocks` に記録する。gates に 2 本足す。

- `blockScrollViolations`: ブロックが変化した遷移のうち `oldBottom !== ""` かつ
  `newTop !== oldBottom` の件数。**目標 0**
- `blockBlankGaps`: 最初の非空 tick と最後の非空 tick の間で空になった tick 数。**目標 0**

### E-3. score-ja と既存 gates の移行

- `jaClauses` の供給元を `.caption-primary` サンプラから `.caption-ledger` の子要素の
  一括読み出しに変える（終了時に 1 回。dedup 不要、順序保証あり）。
- `live2.mjs:393` の `.replace(/\n/g, "")` は不要になるので落とす。台帳は折り返し前の
  文字列なので改行を含まない。
- 既存 4 gates（`live2.mjs:416-422`）は式を変えず、決定的な母数の上で計算する。
- **score-ja の judge プロンプトと SCORE 形式は変更しない**（`score-ja.mjs:89-116`）。
  台帳は「1 行 1 節」を保つので、プロンプト側の契約は動かない。表示の変更で訳質のベース
  ラインを動かさない、が移行の目的。
- 移行の検証: 台帳と旧サンプラを **1 リリースだけ並走**させ、同一 run で件数と内容を突き
  合わせる。差分が出たら、それが (a) サンプラの取りこぼし (b) 二重計上 のどちらかで説明
  できることを確認してから旧経路を落とす。説明できない差分が残る間は移行しない。
- 前後比較は 1 run では判定不能。englishPassthrough が同一条件で 5/37..13/36 と揺れている
  以上、**各 3 run 以上**を取って範囲で比べる。

### E-4. 実機（verify skill `live-subtitle-overlay.md` のレシピに追記）

speech を 20 秒流し、上段が静止したまま下段だけが進むこと、文の切れ目でブロックが白く
ならないことを目視で確認する。フルスクリーン切り替えとスクロール中も同じであること。

---

## 非ゴール（やらないこと）

- **`wrapCueText` / `splitCueText` / 助詞テーブルの書き換え**。追記する行は #47 がすでに
  出している行そのもの。ストリーミング用に境界を引き直すと、助詞の拒否条件・カタカナ連続・
  URL 保護（`cue-text.ts:371-469, 637-683`）が丸ごと再検討対象に戻る。得られる見た目の差は
  ない。
- **実測ピクセル幅での折り返し**。`displayUnits`（`cue-text.ts:810-830`）は決定的な幅モデル。
  描画箱に依存させると折り返しが動画サイズの関数になり、単体テストと bench の再現性が消える。
- **スクロールのアニメーション**（transform / transition）。YouTube のブロックも目に見えて
  滑ってはいない。追記ごとにレイアウトが動くのは、まさに今回消そうとしている現象。加えて
  同じ要素の `is-fading` の opacity トランジション（`:2627-2633`）と競合する。
- **3 行以上への拡張**。`--primary-slot` は 2 行分に固定（`:2087-2094`）、バー高さも上限付き
  （`:1989-2006`）。3 行目は `overflow: hidden` に無音で食われる。増やすなら別 issue。
- **tentative のブロック統合**（決定表参照）。
- **語・トークン単位の追記**。放出は #50 以降は文粒度
  （`sentence-assembler.ts:5-6, 66-85`）で、語単位のストリームは存在しない。作れば
  ちらつきが細かい粒度で戻る。
- **変異ウォッチドッグの削除・無効化**。
- **`.caption-primary` を訳質採点コーパスとして使い続けること**。

### なぜ最小版で足りるか

読みにくさの原因は 1 行に集約できる。`replaceChildren`（`:1272`）で上段も下段も同時に
別物になり、視線の固定点が消えることだった。表示枠はもう 2 行分ある。行の切れ目はもう
#47 が natural boundary で出している。cue の滞留予算も併合も drop も加速も、そのまま
再利用できる。足りないのは「行を配列で持って、2 要素に書き分ける」ことだけで、
実質的な追加は `blockLines` と `pendingLines` の 2 本と、刻みの分配、条件式 3 箇所、
snapshot の 1 行。これ以上を同じ変更に載せると、drain と変異ガードという既存の 2 つの
安全機構に同時に触れることになり、壊れたときの切り分けができなくなる。


---

## 実装時に必ず満たす（敵対レビュー指摘・2026-09-01）

1. **変異ガードの snapshot は cue コンテナ内の全テキストノードを覆う**（上段・下段・原文の 3 つ）。
   `inspectCueMutations` は `.caption-cue` 単位で snapshot を取るため、追記の直後に 2 行だけ
   更新すると原文行の差分を事故として計上する（`src/content/overlay.ts:1331-1396`）。
2. **`hasPendingCaption` に新しい保留状態を必ず加える**（`overlay.ts:556-563`）。
   落とすと停止時に content 側が即 drain 完了を通知し（`src/content/index.ts:2366-2373`）、
   最後の 1 行が無音で欠ける。
3. **`bench/live2.mjs` の収集と `score-ja` の入力を同じ PR で追随させる**。追記型では
   「1 行」の意味が変わるため、直さないと前後比較が成立しない。あわせて収集側のコメント
   「A cue occupies two .caption-primary elements」は誤り（cue ごとに 1 個・
   `overlay.ts:1300-1329`）なので訂正する。
