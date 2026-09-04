# Issue #66 設計: 文脈用語の配達と最初の翻訳の競合を閉じる

Status: draft（未レビュー。Sol Max 設計レビュー + Grok 敵対レビュー前）
Date: 2026-09-01
動機: on-device live2 実測で、セッション開始直後の 1 行だけ
「ローマは広大な宇宙の領域を地図化するだろう。」が出る。同一バンドルの別 cue は
"NASA Goddard" を保持し、以後のループパスは "Roman" を保持する。#49 の
placeholder マスクは「用語が届く前に翻訳された節」を守らない。

## 現状の事実（file:line）

1. **順序は構造的に content が先**。background は `content.postMessage(CS_START_TAP)`
   （`background/index.ts:884`）の**後**に `offscreen.postMessage(OFF_START)`
   （`:901`）を投げる。両ポートは事前に揃っている（`:865-872`）ので、この 2 行の
   間隔がそのまま先行量になる。
2. **offscreen 側で PCM は即時・start は直列キュー**。ポートリスナは CS_PCM を
   同期で `handlePcm` へ渡す（`offscreen/index.ts:308-313`）が、OFF_START は
   `enqueueCaptureOperation` に積む（`:359-364`・キュー本体 `:577-595`）。直前の
   stop 処理が残っていれば start は任意に遅れる。
3. **未武装の間に来た chunk は無言で捨てられる**。`handlePcm` の入口ガードは
   `activePcmRequestId` 不一致・`audioCapture.isActive()` 偽で return する
   （`:600-607`）。武装は `activePcmRequestId = requestId`（`:885`）と
   `audioCapture.start()`（`:893`・`audio-capture.ts:126`）で、どちらも
   `handleCaptureStart` の中。**捨てられた chunk に載っていた `contextTerms` も一緒に消える。**
   background 側にも同型の無言 drop がある（`background/index.ts:1511-1541`）。
4. **配達は一発勝負**。用語を運ぶ配線は `CsPcmMessage.contextTerms` の 1 本だけ
   （`shared/messages.ts:310-317`）。content は最初の chunk で抽出して添付し
   （`content/index.ts:1854-1879`）、**offscreen が受理したかを見ずに arm を解除する**
   （`:1883-1887`・`:3050-3062`）。arm を張るのは fresh tap 準備の 1 箇所だけ
   （`:1395-1397`）なので、同一セッション中の再配達経路は**存在しない**。
   再武装は再 tap（grace 復帰 `background/index.ts:1393-1400` → `content/index.ts:1354-1361`）
   まで起きない。
5. **「用語なし」の肯定信号は既に線に乗っている**。抽出が空でも
   `pendingContextTerms` は `[]`（非 null）なので `contextTerms: []` が添付される
   （`content/index.ts:1857-1869`）。受信側も `message.contextTerms !== undefined`
   で配達の有無を判定している（`offscreen/index.ts:611`）。**曖昧なのは受信側の初期値だけ**で、
   `handleCaptureStart` が `activeContextTerms = []` と置く（`:867`）ため
   「未配達」と「用語ゼロ」が同じ形になる。
6. **消費は行ごとの実行時読み**。`getContext()` は毎回 `[...activeContextTerms]` を返し
   （`:918-925`）、`translateWithFallback` が行ごとに `createMaskPlan` する
   （`translate.ts:362-369`）。用語が空なら occurrences 0 で `maskPlan: null`
   （`term-masking.ts:35-45`）。**maskPlan が null だと Translator 系 path は救済へ迂回せず原文を訳す**
   （`translate.ts:438-484`）ので、`Roman will map wide regions of the sky` は
   ローマ になり得る。以後の行は用語到着後なのでマスクされる。
7. **順序の不変条件（好都合な方）**: `:867` の初期化と `:885` の武装は同一同期タスク内
   （間に await なし）。よって**受理された chunk は必ず初期化より後**で、後から
   `[]` に上書きされることはない。ゲートは受信側だけで完結する。
8. **保留の器は既にある**。`runQueue` は `path` 未確定の間キューを流さない
   （`translate.ts:289-321`）。overlay は ja 未着の final を `pendingFinals` に伏せて
   表示しない（`overlay.ts:852-874`）。**翻訳を待たせても英語や空欄は画面に出ない。**
   英語素通しが出るのは path が none に落ちた時だけ（`overlay.ts:442-455`）。
9. **保留の予算は 2 行**。`MAX_PENDING_TRANSLATIONS = 2`（`translate.ts:114`）で、
   超過時は最古を落として警告する（`:206-232`）。文の発火間隔は文末句読点 / 20 語 /
   4,000 ms タイムアウト（`sentence-assembler.ts:5-7, 74-86`）。
10. **再翻訳は overlay 側の新規配線が要る**。`acceptedFinalIds` が同一 id の再受理を
    弾く（`overlay.ts:836-842`）。
11. **配達の粒度**: chunk は 4,000 サンプル / 16 kHz = **250 ms**
    （`content/audio-tap.ts:6`・`shared/downsampler.ts:1-2`）。用語は最大 40 件
    （`shared/messages.ts:23`）で、chunk 本体（4,000 float32 の base64 ≒ 21 KB）に対し十分小さい。

### 観測との突き合わせ（未確定を明示する）

台本の `Roman` は 5 回出る（`bench/refs/tts2-script.txt:1`）。用語がセッション全体で
不着なら 1 パスあたり複数の誤義が出るはずで、**実測 1 件は「初回配達が落ち、その後
再 tap 等で届いた」**を示唆する。ただし当該実行でどちらが起きたかは
`offscreen/index.ts:620` の `post context dictionary received` を最初の
`[translate] latency`（`translate.ts:416-425`）と突き合わせるまで**未確認**である。
本設計はどちらの読みでも閉じる形にし、**発火の目視を受け入れ条件に含める**（後述）。

## 設計

配達（送る側）と消費（使う側）を別々に直す。片方だけでは閉じない。

### A. 受信側の三状態ゲート（本体）

`activeContextTerms: string[]` の隣に **`contextTermsState: "pending" | "settled"`** を置く。

- `handleCaptureStart`（`offscreen/index.ts:867`）で `pending` に落とす。
- `handlePcm` が `contextTerms !== undefined` の chunk を**受理**したとき
  （`:611-629`）`settled` にする。空配列でも `settled`。
- `terminateRecognition`（`:1427`）で `pending` に戻さず、セッション終了として初期化する。

`TranslationEngine` にコールバック `isContextSettled(): boolean` を渡し、`runQueue` の
先頭で既存の path 保留（`translate.ts:303-311`）と同型のガードを 1 つ足す。
`settled` になった時点で `runQueue()` を蹴る（offscreen 側から
`activeTranslationEngine?.notifyContextSettled()`）。

**セグメンタ側は追加不要**。`setProperNounDictionary`（`offscreen/index.ts:615-618`）が
既に到着時差し替えを行い、補正は clause 発火時に読む（`segmenter.ts:1186-1196`）。

### B. 配達の粘り（sticky 再送）

content は用語を**1 回投げて忘れる**のをやめ、**確認できるまで各 chunk に載せ続ける**。
`clearPendingContextTerms(requestId)`（`content/index.ts:1883-1887`）の無条件呼び出しを
外し、停止条件を次の**いずれか早い方**にする:

1. `state.requestId === pendingContextTermsRequestId` かつ
   `state.status ∈ {loadingModel, running}` の capture state を受信
   （`content/index.ts:2202` 付近）。offscreen が `loadingModel` を publish するのは
   武装（`:885`）より後（`:905-911`）なので、これは「相手が武装済み」の証拠になる。
2. 送信 6 chunk（= 約 1,500 ms）。
3. 初回添付から 1,500 ms 経過。

2 と 3 は 1 の配線が届かない場合の fail-safe で、**stop 条件は状態放送に依存しない**。
コストは 250 ms ごとに最大 6 回 × 数百バイト〜5 KB で、chunk 本体に対して無視できる。
抽出そのものは今のまま**最初の chunk 内で 1 回だけ**行う（`:1857-1863`）。tap 確立後なので
`getCurrentAudioTapTarget()` が使え、article 特定の品質が落ちない。

### C. 上限（bound）

**時計は「最初に保留した行を enqueue した時刻」から回す。capture start からではない。**
モデルロードだけで数秒かかる（`offscreen/index.ts:1100-1128`）ので、start 起点だと
最初の行が来る頃には期限切れになり、ゲートが一度も効かない。

`CONTEXT_TERMS_WAIT_MS = 1500`。根拠:

- 配達側の再試行が 250 ms 間隔 × 6 回（B-2）で、その全滅を待ってから諦める幅。
- キュー容量は 2 で超過時は最古を捨てる（`translate.ts:114, 206-232`）。文の発火間隔は
  最悪 4,000 ms（`sentence-assembler.ts:6`）、tts2 の実文は 6〜9 語で概ね 3〜5 秒。
  1,500 ms なら**追加で溜まるのは高々 1 行**で drop に届かない。
- 画面上の代償は「最初の字幕が最大 1.5 秒遅れる」だけ。overlay は ja 未着の final を
  既に伏せている（`overlay.ts:852-874`）ので、英語のちらつきも空欄も増えない。

期限到達時: `settled`（辞書は空のまま）へ遷移してキューを流す。**セッション中に二度保留しない。**
`#63` の `OFF_DEV_LOG` に `{kind: "context-terms-timeout", requestId, heldMs, lineId}` を出し、
live2 から機械カウントできるようにする。期限後に用語が届いた場合は**採用する**
（`:611` の既存経路で以後の行とセグメンタ辞書に効く）。既出行は訳し直さない。

### 検討して採らなかった案

| 案 | 却下理由（file:line） |
|---|---|
| 用語到着まで無条件に最初の翻訳を止める | 用語ゼロの投稿で永久停止する。`[]` は肯定信号として線に乗っている（`content/index.ts:1857-1869`）が、**受信側の初期値と同形**（`offscreen/index.ts:867`）なので、状態を分けずに待つと区別できない。三状態 + 上限を入れた時点で本案は A/C に一致する |
| 影響行を後から再翻訳する | overlay が `acceptedFinalIds` で同一 id の再受理を弾く（`overlay.ts:836-842`）。差し替えには表示済み cue を書き換える新規配線が要り、生字幕としての体験も悪い。競合を**閉じず**、外から見えなくするだけ |
| capture 発行前に用語を抽出して同梱 | `extractPostContextTerms` は `getCurrentAudioTapTarget()` の `closest("article")` に依存する（`content/index.ts:2844-2853`・`audio-tap.ts:36-40`）。tap 確立前は null で、status ページの `main article` fallback（`:2855-2868`）しか効かず、タイムライン上の投稿で**無言に用語が減る**。競合は閉じるが品質を犠牲にする。A/B が入った後の**追加**としてなら両立するので、別 Issue に回す |

## 決定表

「用語ゼロの投稿」と「まだ届いていない」は `[]` として同形になる。**空配列で判定せず、
配達イベントの有無で判定する。**

| # | 受信側の状態 | 判定条件 | 翻訳キュー | マスク | 備考 |
|---|---|---|---|---|---|
| 1 | pending | capture start 後、`contextTerms !== undefined` の chunk を未受理、保留開始から < 1,500 ms | **保留** | — | overlay は既に非表示保持（`overlay.ts:852-874`）。画面変化なし |
| 2 | settled(terms) | 受理した `contextTerms.length > 0` | 即流す | 有効 | 正常系。到着はセグメンタ辞書にも反映（`offscreen/index.ts:615-618`） |
| 3 | settled(empty) | 受理した `contextTerms.length === 0` | **即流す** | 不要 | 用語ゼロの投稿。**遅延ゼロ**。`[]` は content の肯定回答であって沈黙ではない |
| 4 | settled(timeout) | 保留開始から 1,500 ms 到達、未受理 | 流す | なし | 劣化動作。`context-terms-timeout` を DEV ログへ。**二度目の保留はしない** |
| 5 | settled(timeout) → 遅延到着 | 期限後に `contextTerms !== undefined` を受理 | 影響なし | 以後の行のみ有効 | 既出行は訳し直さない（再翻訳を採らないため） |
| 6 | pending のまま stop | セッション終了 | drain で流す | なし | `handleCaptureStop`（`:1229`）の drain を妨げない。保留がある状態で stop したら即 settled 扱いにして drain へ渡す |
| 7 | 翻訳 path が none | `path === "none"` | 保留しない | — | 翻訳しないので用語は無関係。`enqueue` の既存 early return（`translate.ts:194-204`）と衝突させない |
| 8 | `skipTranslation`（日本語行） | `isMostlyJapanese`（`offscreen/index.ts:1524`） | 保留しない | — | 翻訳を通らない行を待たせる理由がない |

**表の読み方**: 行 3 と行 1 を分ける唯一の情報は「content からの配達イベントを受理したか」で、
配列の中身ではない。行 4 が存在することで、配達経路がどう壊れても字幕は止まらない。

## 受け入れ

1. **単体テスト（機構の証明）**
   - `pending` の間 `runQueue` が流れず、`settled` の通知で同じ行が流れる。
   - `contextTerms: []` の受理で**即座に**流れる（行 3。用語ゼロ投稿の非停止ピン）。
   - 1,500 ms 到達で流れ、`context-terms-timeout` が 1 回だけ出る（行 4）。
   - 期限後の遅延到着が以後の行に効き、既出行は再送されない（行 5）。
   - content 側: ack 相当の状態受信 / 6 chunk / 1,500 ms のいずれでも再送が止まる（B-1..3）。
2. **発火の目視（存在確認では足りない）**
   `handlePcm` の入口ガードを DEV フラグで強制的に n 回 drop させる注入を用意し、
   ①保留が実際に立つ ②sticky 再送で `post context dictionary received`
   （`offscreen/index.ts:620`）が届く ③drop を全期間続けた場合に timeout ログが 1 回出る、
   を実行ログで確認する。**この 3 本の証跡を見るまで「閉じた」と書かない。**
3. **live2 の測定窓を修正してから採取する（ゲートの前提条件）**
   現在の live2 は warm-up 再生 → 一時停止 → drain の後に窓を開き、`seedState` より前を
   捨てる（`bench/live2.mjs:290-335`）。**セッション開始直後の翻訳は窓の外**なので、
   今のゲートでは開始時競合を原理的に検出できない。`__caps` サンプラをトグル直後
   （`:268-274` の後）から回し、窓開始インデックスを記録して、
   `gates` を「全区間」と「測定窓」の 2 系統で出す。
4. **ゲート（`--case tts2 --model base --backend prompt-api`）**
   - `gates.wrongSenseRoma == 0` を**全区間**（最初のループパス・warm-up 由来行を含む）で満たす。
     これが #66 の合否そのもの。
   - `gates.unresolvedPlaceholders == 0` を維持。
   - `context-terms-timeout` 件数 == 0（用語のある投稿で期限切れが起きないこと）。
   - `gates.englishPassthrough` が #63 の到達水準から悪化しない（保留が path 選択に
     干渉していないことの確認。改善は #66 の責任範囲外）。
   - 同一設定で 3 回連続。開始時競合は確率事象なので単発の緑を根拠にしない。
5. **`--case tts`（`contextTerms: []`・`bench/live2.mjs:38`）**
   最初の字幕までの時間が現行から悪化しないこと、`context-terms-timeout == 0` であること
   （行 3 が効いている証拠）。用語ゼロ投稿に 1.5 秒を課していないことをここで示す。
6. Grok 敵対レビュー → CI → Codex Bot。

## 非ゴール

- 再翻訳・cue 差し替え（overlay の受理配線に手を入れる。決定表の却下欄参照）。
- capture 発行前抽出（品質劣化とのトレードオフ。A/B 着地後に別 Issue）。
- 英語素通し率の改善（#63 の続きで、原因も対策も別系統）。
- 用語抽出そのものの精度・stoplist（`content/index.ts:2844-3048`）。
- ladder の順序、キュー深さ、Nano プロンプト（#63 非ゴールを踏襲）。

## 未確定（実装前に確定させる）

- **当該観測がどちらの経路だったか**。初回配達の drop か、drop 後の再 tap による遅延配達かは、
  `post context dictionary received`（`offscreen/index.ts:620`）と最初の
  `[translate] latency`（`translate.ts:416-425`）の時刻差でしか決まらない。#63 の
  `OFF_DEV_LOG` に前者を載せ、**受け入れ 2 の前に 1 回採取する**。本設計はどちらでも閉じるが、
  記録に「推定」を確定として残さない。
- **`OFF_STATE` の `loadingModel` が content まで届くか**（B-1 の ack 信号）。届かない場合でも
  B-2 / B-3 で停止するので設計は成立するが、実装時に実測して、届かないなら B-1 を落として
  条件を 2 本にする。


---

## 受け入れの訂正（敵対レビュー反映・2026-09-01）

1. **`englishPassthrough` を受け入れ条件に使わない。** 同一コードの反復で 5/37・13/36・9/39・
   21/42 とばらつき、単発ランの閾値として機能しない（[#69](https://github.com/Sora-bluesky/x-jimaku/issues/69)）。
   記録指標に降格する。判定は `wrongSenseRoma == 0` と未解決 `%%` == 0 のみで行う。
2. **現行 `bench/live2.mjs` ではこの修正を証明できない。** 計測窓は warm-up 再生 →
   一時停止 → バックログ消化の**後**に開く（`bench/live2.mjs:290-335`）ため、
   本件が起きるセッション開始直後が窓の外に落ちる。窓の外で起きた誤義は 0 と数えられるので、
   直さずにゲートを通すと fail-open になる。
   → 実装と同じ PR で live2 に**セッション開始から測るモード**を足し、そのモードで
   `wrongSenseRoma == 0` を 3 回連続で確認する。既定モードの数値は本件の証明に使わない。
3. 台本中の `Roman` 出現回数は設計本文の記述と実カウントが食い違うとの指摘があるため、
   出現回数に依存した主張は本設計から外す（`bench/refs/tts2-script.txt` を都度数える）。
