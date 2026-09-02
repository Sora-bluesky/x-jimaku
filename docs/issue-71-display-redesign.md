# 設計: 字幕表示の作り直しと反復抑制（#71 / #69）

Status: rev8（rev7 への Sol Max + Grok 各 REQUEST-CHANGES を反映。7 巡で未承認 — 続行可否は sora 判断）
レビュー原文: `.references/reviews/i71-rev{1..7}-{solmax,grok}.txt`
Date: 2026-09-01
先行実装: `.references/`（gitignore・7 リポジトリ + ffmpeg `ccaption_dec.c`）。**libcaption と ccextractor は手元に無く**、ロールアップの挙動で手元で検証できたのは ffmpeg
`roll_up()`（`ccaption_dec.c:426`）だけである。以下「3 実装」と書いていた箇所は ffmpeg 1 実装に改める。
rev1 全文と訂正履歴は scratchpad に退避（本文は読みやすさのため書き直した）

## 何が起きたか

追記型2行ブロック（PR #72・現在 draft）を実利用で試したところ「**基本的に全て2回ずつ
出ている**」と報告された。採取した表示状態:

```
['', '新しいモデルの開発状況につい']
['新しいモデルの開発状況につい', 'て、詳細を共有してください。']
```

各行が下段で1 dwell、上段でもう1 dwell の、2つの独立した提示イベントになる。
折返しも語中で割れている（「開発状況につい／て、」）。

## rev1 で誤っていたこと（両レビューが一致）

1. **「行送りなら2回出るのは不可避」→ 半分正しく、結論が誤り。** ロールアップでは行が
   上段へ移ること自体は正常（ffmpeg `roll_up()` は memcpy 1回でシフトし、移動時に表示時間を
   再設定しない。libcaption / ccextractor は未検証）。ただし**2行ロールアップである
   限り、どの行も2つの提示状態に現れる**のは事実。rev1 の「原子的描画で構造的に消える」は偽。
2. **「末尾2行を1回で描く」→ 3行目どころか1行目が消える。** 28 unit の節が3行に折り返る
   実測 fixture がある（`cue-text.test.ts:265`）。末尾2行だけ描けば先頭行は最初から不可視。
   さらに同一 JavaScript タスク内で `L1→L2→L3` を書くと **paint 前に置換されて L1 は
   一度も見えない**。PR #72 が直した無音欠落の再導入。
3. **受け入れゲートが軒並み空振り。** 「同一行が連続状態に出現ゼロ」はロールアップ自体を
   禁止し、しかも状態が1つしか出ない入力なら自明に通る。
4. **圧縮率 1.6 は誤り。** 実測で `Ott Ott Ott`=0.786、`Ott`×5=1.357。短文では zlib
   ヘッダが支配的で、本家の 30 秒窓向け統計を 1.5 秒の節に持ち込んだのが誤り。
5. **較正の母集団違い。** 較正に使ったのは台帳の `primaryText`（=翻訳後の日本語）だが、
   ガードを segmenter に置くなら対象は英語 ASR 原文。
6. **既存関数の読み違い。** `repeatedNgramExcess` は**非連続**の 2/3-gram 頻度超過で、
   提案した**連続**最大連数とは別統計。「低音量条件を外すだけ」では済まない。

## 設計 A: 表示

### A-0. 選択肢と決定

| 案 | 同じ行が2回出るか | 全行が見えるか | 連続性 |
|---|---|---|---|
| 現行（行送り・行ごと dwell） | 出る（報告の症状） | 見える | あり |
| 2行ロールアップ（移動時に dwell を与えない） | **出る**（ロールアップの定義） | 見える | あり |
| **2行ページ送り（採用）** | **出ない** | 見える（drop を除く） | 無し |
| 1行表示 | 出ない | 見える | 無し |

報告された不満は「2回出る」ことなので、ロールアップは採らない。**2行ページ送り**を採る。
連続性は失われるが、それは #50 以前の旧表示と同じであり、旧表示への不満は翻訳粒度
（#50 で解決済み）であって連続性ではなかった。1行表示は情報密度が半減するので採らない。

### A-1. ページ送りの定義

- 表示は固定2スロット。**ページ = 最大2行の組**。
- **ページ化は表示直前に、`CueData` 1 件から行う。** `CueData` は `splitCueText` で
  28 unit 以下に切られており（`cue-text.ts:1`）、`wrapCueText` は残り 28 unit 以下のとき
  「残余が 14 unit 以下になる境界」以上で切るため（`cue-text.ts:230-264`）、1 件は最大 3 行
  = **最大 2 ページ**。実測 fixture は `cue-text.test.ts:265`。確定節そのものには unit 上限が
  無いが、それは `splitCueText` が複数の `CueData` に切るので、ページ上限は `CueData` 単位で
  閉じる。
- 3行なら `[L1,L2]` と `[L3]`。1 ページは1回の同期 DOM 書き込みで両スロットに入る。
  **ページ間で行を持ち越さない。** 1 行ページは下段を空にする（`''`）。
- **不変条件: 画面に出た行は、ちょうど1ページにだけ現れる。** drop（A-2）で捨てられた
  `CueData` の行は 0 回になる。これは現行の drop 規律と同じで、「全行が見える」は
  drop が起きない限りにおいて成立する（Grok 指摘 2）。
- ページの最小表示時間は現行の cue dwell（`CUE_MINIMUM_DISPLAY_MS` / 加速時
  `CUE_ACCELERATED_DISPLAY_MS`）を**ページごと**に与える。pacing は残す。消すのは
  「行が移動する」概念であって pacing ではない。
- **2 ページ目は必ず dwell タイマーから書く。同期には書かない。** 現行の描画は同期 DOM
  書き込み + `setTimeout` で次を遅らせる形（`overlay.ts:1385-1388`）で、rAF は配置専用
  （`:1730`）。この規則が保証するのは**描画機会の分離**（2 ページが別タスクに乗り、dwell 以上
  離れる）であって、実 paint の発生ではない。paint そのものは単体テストでも live2 の
  `textContent` 採取（`live2.mjs:373`）でも観測できないので、設計はそれを主張しない。
  同一タスク・同一フレームで 2 ページ書く経路を作らないこと（Sol 指摘 3）。
- ページごとに `shownAt` を更新する。加速状態・dwell タイマーは現行のまま流用する。
- `.caption-original`（英語原文行、要素は `overlay.ts:316`、`originalText` は `:78`）は `CueData` に属する。その `CueData` の
  どのページが可視でも同じ原文を出す（ページごとに分割しない）。

### A-2. cue キュー規律との関係

**待ち行列は現行どおり `CueData` 単位のまま。** merge は `primaryText` を結合して
`wrapCueText` し直す（`overlay.ts:1246-1277`）ので、ページ単位で merge すると結合結果が
3 行になってページ数が増え、隠れた再ページ化状態が生じる（Sol 指摘 1・Grok 指摘 2）。
したがって:

- `MAX_WAITING_CUES = 6` は**そのまま cue 数**。merge / drop / 加速は変更しない。ただし
  **merge は `fallback` の異なる `CueData` を結合しない**。禁止する場所は **`decideCueQueueDiscipline`
  の候補判定**（`CueQueueEntry` に `fallback` を足し、`cue-queue.ts:33` の候補条件に加える）であって、
  `overlay.ts:1246` の適用側で後から拒否してはいけない — シミュレータが merge 済みとして
  `dropCount = 0` を返し、7 件が残る。候補が無ければ `dropCount`（`:85`）で先頭が drop され 6 件に収まる。
  受け入れ: 種別が交互の 7 件で「merge なし・drop 1・残 6」を assert。
- 表示側は「先頭の `CueData` を取り出す → 1〜2 ページに分割 → ページを順に dwell 付きで
  描く → 全ページを描き終えたら次の `CueData`」となる。ページ列は表示中の 1 件分だけが存在し、
  待ち行列には現れない。
- drain 予算 `CAPTION_DRAIN_WAIT_MS`（`explicit-stop-drain.ts:12-17`）は、活動中 1 件 +
  待ち 6 件が各 2 ページになり得るので **`2 × CUE_MINIMUM_DISPLAY_MS + 6 × 2 ×
  CUE_ACCELERATED_DISPLAY_MS + CAPTION_VISIBLE_MS + CAPTION_FADE_MS`** に引き直す
  （= 20,350 ms。現行 12,850 ms）。これは上界であり、実測で縮めない。
- **改訂（直前の確定節を延長した節）**: `lastAcceptedPrimary` 接頭辞除去（`overlay.ts:976-986`）
  はそのまま使い、除いた末尾だけを新しい `CueData` として**末尾に追加**する。待ち中や表示中の
  接頭辞側の `CueData` は差し替えない（差し替えると未表示行が消える。Grok 指摘 2）。

### A-3. `hasPendingCaption` の新定義・確定節の終端・drain 中の一時停止

`pendingLines` は廃止する。新定義:

```
表示中 CueData の未描画ページが残っている
  || waitingCues.length > 0
  || pendingFinals.size > 0              （翻訳の終端が来ていない確定節）
  || 可視中またはフェード中のページが空でない
  || tentativeLine が空でない
  || deferredTentative !== null          （一時停止中に退避した暫定。overlay.ts:187）
  || suspendedCaptionFade / suspendedCaptionRemoval !== null （一時停止で保留中の fade）
```

**確定節の終端プロトコル（Sol 指摘 1–3・Grok 指摘 1–2）。** 原文確定節は翻訳投入前に
`OFF_RECOG` で overlay へ届き（`offscreen/index.ts:1542`）、overlay は `ja === ""` の間
`pendingFinals` に置く（`overlay.ts:913-934`）。現行では終端が来ない経路が 3 つある:
翻訳キューが `MAX_PENDING_TRANSLATIONS = 2`（`translate.ts:114`）を超えて最古を `shift`
しても dev log しか出さない（`:215`）／翻訳 drain の timeout で `destroy()` が queue を無言で
消し（`:246`、`:268`）、in-flight の結果も `destroyed` で捨てる（`:337`）／翻訳 drain が失敗すると
字幕 drain 自体を飛ばす（`offscreen/index.ts:1278`）。

設計は **offscreen 側の request 単位「終端台帳」** で閉じる。overlay に新しい状態機械を足さない。

- **台帳**: request ごとに `Map<lineId, Entry>`、`Entry` は判別共用体
  `{ kind: "pending", text, at, since } | { kind: "translated", text, ja } | { kind: "fallback", text }`。
  先頭が `pending` の間に後続の翻訳が戻ったら `translated` として**翻訳文ごと保持**し、解放時に送る。
  **終端は先着優先**: `fallback` 済み・解放済みの id に届いた遅延翻訳は無視する。`OFF_RECOG`
  を原文で送った時点で `pending` を登録する（`postFinalRecognition` は既に `requestId` を付け
  （`:1615`）、切断時 buffer と background relay（`background/index.ts:1987`）もこの経路にある）。
- **終端イベント**: 翻訳完了 → `translated`。以下は全部 `fallback`: queue drop（`translate.ts:215`）／
  `translateWithFallback` が path 枯渇で `null` を返し `processClause` が結果なしで戻る（`:337-342`、
  `:389-429`）／`setPath("none")` が非 skip エントリを splice する（`:1225-1236`）／engine `destroy`
  時の残 queue と in-flight（`processing` は真偽しか持たない `:319` ので **in-flight エントリの
  参照を engine が保持し、destroy の前に snapshot**）／drain timeout／**id ごとの期限**（下記）。
  engine はこれらの全経路で **`onSettled(ids)` callback** を呼ぶ（新設。engine は `requestId` を
  options で受けている `:81`）。無言で捨てる経路を 1 つも残さない。
- **id ごとの期限（live 中の head-of-line 停止を防ぐ）**: 台帳の `pending` には登録時刻を持ち、
  `LANGUAGE_MODEL_PROMPT_TIMEOUT_MS`（10 s、`translate.ts:117`）+ 2 s を超えたら `fallback` に倒す。
  これで先頭が pending のまま後続が止まる時間は有限。**ただし台帳の期限だけでは engine は
  解けない**: `processing = false` と次の `runQueue()` は `processClause` の `finally`（`translate.ts:356`）
  にあり、`translate()` の await が返らない限り走らない。`Translator.translate`（`:453`）と
  `LanguageModel.clone`（`:649`）には期限が無い。したがって **engine 側で id ごとに 1 本の絶対期限を張り、id の期限を **enqueue 時点から**所有させ、`processClause` 全体（`selectBestPath` `:399`、`clone/create`
  `:638` `:1121`）だけでなく、**初期の経路選択**（`:173` の `selectBestPath()` は `processClause` の外で、
  経路未決定の間はキュー処理が始まらない `:303`）も同じ世代付き処理に含めて race させ、期限で `null` 扱いにして `finally` へ落とす**。
  attempt 単位の race では失敗後の `selectBestPath()` や `create()` が未解決のまま残る。期限後に
  戻った Promise の副作用は**世代番号で遮断する**。遮断対象は結果側だけでなく **`finally` 側も含む**:
  現行の `finally`（`translate.ts:355`）は無条件に `processing = false` → `runQueue()` →
  `resolveDrainWaitersIfIdle()` を行うので、期限切れの id 1 が id 2 の処理中に完了すると id 3 の並行開始や
  drain の早期完了が起きる。`finally` は「自分の世代が現世代のときだけ」これらを行う。同様に stale な
  処理は `failPath` / `selectBestPath`（catch `:399-414`、定義 `:955`）、`setPath("none")`（枯渇時 `:1005` →
  queue splice・`onPathChanged`・`runQueue` `:1213-1248`）、`languageModelClone` の差し替え（`:662`）、
  モデル破棄（`:1195`）のいずれも行わない。**期限世代は、その attempt にとって `destroyed` と同等**とし、
  race の loser が後で resolve / reject しても上の全変異点で no-op にする（offscreen の `onPathChanged` は
  engine 同一性しか見ない `offscreen/index.ts:961-972` ので、engine 側で止めるしかない）。台帳の期限は engine の期限と
  同値にし、二重に持たない（engine の timeout → `onSettled` → 台帳 fallback、の一本道）。期限発火時に engine は
  in-flight を打ち切って `processing = false` に戻し、`runQueue()` で次 id の翻訳を始める（`:289-295`
  は `processing` 中に次を出さない）。打ち切られた await が後で戻っても `destroyed || result === null`
  と同じ扱いで捨てる。期限の無い await は `Translator.translate`（`:454`）、`base.clone()`（`:649`）、
  `LanguageModel.create`（`:1161`）。translated の遅延結果は既に `acceptedFinalIds`
  で無視される（`overlay.ts:950`）ので、fallback 後に翻訳が戻っても表示は変わらない。台帳は
  fallback 後の結果を捨てる。
- **順序解放**: 台帳は **id 昇順の先頭から** だけ overlay へ解放する。`translated` は現行どおり
  `OFF_RECOG` + `ja`、`fallback` は **同じ `OFF_RECOG` に `ja: text` と `fallback: true`** を
  載せて送る（新メッセージ型を増やさない）。ただし background の中継は `id/text/final/at/ja` しか
  写さない（`SW_RECOG` `background/index.ts:3317-3326`、`SW_CAPTION` `:3350-3359`）ので、
  **`RecognitionPayload`（`messages.ts:353-359`）と `CaptionLine`（`overlay.ts:94-100`）に
  `fallback?: boolean` を足し、両中継で写す**。runtime guard `isRecognitionPayload`（`messages.ts:1065`）で `undefined | boolean` を検証する。受け入れは
  中継テストだけでなく **guard の単体テスト**（`fallback: "yes"` を拒否・`true`/`undefined` を通す）を持つ。
  現行 guard は `fallback` を見ないので中継テストだけでは通る。`CaptionLine` は `RecognitionPayload` と別型なので両方に足す。
  overlay は `line.fallback` で改訂の分岐（下記）を行う。中継で落ちたら (b) が死に、待ち日本語
  `CueData` と英語全文が merge（`overlay.ts:1246`）で 1 件に結合される。先頭が `pending` の間は後続を **translated / fallback を問わず** 送らない（後続 translated を先に
  送ると先頭が `highestAccepted` 以下で捨てられる `:956`）。待ち時間の上限は id ごとの期限。これで `id=2` の drop が
  `id=1` の翻訳より先に overlay に着いて `id=1` が `highestAccepted` 以下で捨てられる
  （`overlay.ts:956`）事故を防ぐ。
- **明示停止**: offscreen は翻訳 drain の成否にかかわらず、台帳の `pending` 全件を `fallback`
  に倒して順に送ってから `waitForCaptionDrain` に入る（`:1278` の「失敗なら字幕 drain を
  飛ばす」を廃止）。これで overlay の `pendingFinals.size > 0` は有限時間で偽になる。
- **overlay 側**: `ja` が非空なので `resolvePrimaryText`（`:1026`）はそのまま原文を返し、
  通常の `acceptCommittedClause` で `CueData` 化・台帳（ledger）記録される。overlay 側の
  `setTranslationPath("none")` は現行どおり `pendingFinals` を全件原文で確定する（`overlay.ts:502`）が、
  offscreen の `setPath("none")` は **splice の前に**台帳の `pending` を全件 `fallback` で送り、
  その後に `onPathChanged`（`SW_TRANSLATION_STATE`）を出す順に固定する（現行 `translate.ts:1223-1239` は
  splice → `onPathChanged` で、同一ポートなら state が先に着く）。overlay 側の none flush も
  **`fallback: true` 相当**（`lastAcceptedKind = "fallback"`・`originalText` 空）で accept する。
  到着順は port の post 順しか保証されないので、**両順を同じ終端に正規化する**: none が先なら overlay
  の flush が fallback 相当で accept し、後着の標識付き fallback は `acceptedFinalIds`（`:897`、`:949`）で
  無視。fallback が先なら通常 accept し、後の none flush は `pendingFinals` が空なので何もしない。
  どちらでも kind は `fallback`。id は capture ごとに 1 から振り直される（`segmenter.ts:233`）が、`requestId` が
  既に付いているが、overlay 自体は `requestId` を持たず idle で `destroyOverlay` される。台帳は offscreen 側で
  request ごとに破棄するので、overlay は「現 request の id 空間」だけを見ればよい。

**改訂検出の watermark（Sol 指摘 2）。** 現行は `lastAcceptedPrimary`（表示文字列）の接頭辞比較
（`overlay.ts:976-986`）。翻訳文と原文 fallback が交互になると比較が成立せず、延長改訂を全文で
二重表示する。**watermark を原文 `text` 側にも持ち、直前の表示種別も持つ**: `lastAcceptedSource` と
`lastAcceptedKind: "translated" | "fallback"`。改訂判定は `line.text.startsWith(lastAcceptedSource)`。
表示する末尾は (a) 直前も今回も翻訳文なら `primary` の接頭辞除去（現行 `:976-986`）、(b) 直前か今回が
fallback なら **原文の差分 `text.slice(len)`** を primary として `splitCueText` へ渡す（翻訳文を原文の
長さで切らない）。**主文が原文差分なら `originalText` を空にする**（「現在が fallback なら」ではない。3 発目は translated
だが主文は差分 `E F` なので、原文欄に `S3` 全文を置くと併記になる）。`createCueSegments`（`:1032`、`:1054`）
は現行 `line.text` を原文行に載せるので、差分表示のときは空を渡す。
受け入れは次の改訂列 fixture で、ページ列と隠し台帳が期待列に**完全一致**すること:

| # | 原文 `text` | 種別 | primary | 期待ページ・原文欄 |
|---|---|---|---|---|
| 1 | `A B` | translated `ja1` | `ja1` | `[ja1, '']`、原文欄 `A B` |
| 2 | `A B C D` | fallback | 原文差分 `C D` | `[C D, '']`、原文欄 空 |
| 3 | `A B C D E F` | translated `ja3` | 直前が fallback → 規則 (b) → 原文差分 `E F`（`ja3` は出さない） | `[E F, '']`、原文欄 空 |

台帳も `[ja1, C D, E F]`。3 発目で `ja3` 全文を出す実装、2 発目で `A B C D` 全文を出す実装、
2 と 3 を merge して 1 件にする実装は落ちる。

fade の予約と期限判定（`overlay.ts:2360`、`:2409`、`:2458`）に `pendingFinals.size > 0` を加え、
`onCaptionFadeOut`（`index.ts:2427`）は `hasPendingCaption()` が偽のときだけ
`CS_DRAIN_COMPLETE` を送る。offscreen の固定 timeout `CAPTION_DRAIN_WAIT_MS`（`:1783`）は
最後の安全網として残す。

**drain 中の一時停止（Sol 指摘 2・Grok 指摘 2）。** 現行は一時停止で cue 進行と fade が止まり
（`:671`、`:1328`）、`syncOverlayPlaybackGate`（`content/index.ts:546-561`）は遅延到着の
`ensureOverlay` のたびに再び止める。明示停止で overlay は **`drainMode = true`** に入り、
以後 `setPlaybackPaused(true)` を無視して表示時計を進める（`:680-703` の再開を 1 回呼ぶ
だけでは足りない）。`drainMode` の解除は 3 つ: `CS_DRAIN_COMPLETE` 送信・新規キャプチャ・destroy、**および安全網
`CAPTION_DRAIN_WAIT_MS` の timeout が overlay に伝わったとき**。**新メッセージは要らない**: 安全網 timeout で `waitForCaptionDrain` が解決すると停止処理は
`OFF_STATE idle` を publish し（`offscreen/index.ts:1287`）、content は idle で drain 状態を消して
overlay を destroy する（`content/index.ts:2279`）。destroy が `drainMode` を消す。専用通知を足す
判断になった場合の方向は `OFF_DRAIN_ABORTED`（offscreen → content）で、`OFF_DRAIN_READY` と同じ
4 点（型 + `isM1Message` / `isCapturePortMessage` / `isContentPortMessage` / background 中継）が要る。
Grok 指摘 3: 無いと idle 後も一時停止を無視し続ける。解除後は `setPlaybackPaused(true)` が
再び効く。

### A-4. 暫定結果は同じブロックに入れない（rev1 の A-2 を撤回）

Grok 指摘のとおり、暫定は**翻訳前の英語 ASR** であり（暫定のスキップは
`offscreen/index.ts:1524-1538`）、`emitTentative` は仮説列の差し替え（`segmenter.ts:1212-1248`）で
トークン追記ではない。確定日本語のブロックに英語を混ぜると (a) 同内容が英→日で2回出る
(b) 混在スクリプトで折返し規則が未定義 (c) 暫定改訂のたびに確定側の折返しが再計算されて
行が跳ぶ。**暫定は現行どおり独立要素に置く。** 流れを作る施策は本設計の非ゴールとし、
別 Issue で LiveCaptions 式の確定凍結（`line-gen.c:280-292`）と併せて設計する。

### A-5. 決定表

| 入力 | 動作 |
|---|---|
| 確定節が到着 | `splitCueText` → `CueData` 列 → 待ち行列へ（現行）。表示中でなければ先頭 `CueData` の第 1 ページを同期描画 |
| 直前の確定節を延長した改訂 | 接頭辞を除いた末尾だけを新しい `CueData` として末尾に追加。既存 `CueData` は差し替えない |
| ページの dwell が経過 | 同じ `CueData` に次ページがあればそれを、無ければ次の `CueData` の第 1 ページを描く。**タイマー経由でのみ** |
| 待ち `CueData` が上限超過 | 現行の merge / drop（cue 単位）。ページには触れない |
| 待ちが尽きた | `pendingFinals` が空なら fade 期限を張る。空でなければ張らず、翻訳か fallback を待つ（明示停止なら台帳が有限時間で全件倒す） |
| `OFF_RECOG` に `fallback: true`（`ja: text`） | 通常の `acceptCommittedClause`。改訂判定は原文 watermark で |
| 一時停止 | 現行どおり dwell / fade を保留。暫定は `deferredTentative` へ。**`drainMode` 中は無視** |
| 明示停止 | `drainMode` に入る。A-3 の定義が偽になるまで drain 完了を通知しない。偽になった最初の fade 完了で **ちょうど 1 回**通知 |
| 新規キャプチャ・destroy | ページ列と表示を破棄 |

### A-6. 受け入れ（各ゲートに「どう落ちるか」を明記）

| ゲート | 落ちる条件（これが無ければ空振り） |
|---|---|
| A-6-1 出た行はちょうど1ページに現れる | fixture は 2 種: **1行節を2つ連続**（`CueData` 間）と、**同一 `CueData` が 2 行に折り返る入力**。それぞれ**期待ページ列を明記**して assert: 前者 `[[A,''],[B,'']]`、後者 `[[L1,L2]]`（遷移数 2 と 1）。加えて入力の各行がページ列全体にちょうど 1 回現れることを assert。無描画・持ち越し・二重のどれでも落ちる |
| A-6-2 3行 `CueData` の全行が可視 | `overlay.test.ts:581` の 3 行入力（元は `cue-text.test.ts:265`）を使い、描画が **2 回**・各行が 1 回ずつ現れることを assert。末尾2行だけ描く実装なら落ちる |
| A-6-3 2 ページ目は dwell 経過後にだけ出る | fake timers で `displayCue` 直後と **`CUE_MINIMUM_DISPLAY_MS − 1` ms 時点**の DOM が第 1 ページのみ、**`+1` ms** で第 2 ページ、を assert。加速時は `CUE_ACCELERATED_DISPLAY_MS` で同じ 2 点。`setTimeout(0)` や同期書き込みの実装なら落ちる。paint は主張しない（A-1） |
| A-6-4 drain が早期・欠落しない | 各ケースを**負方向→正方向の 2 段**で書く。(a) ページが残る状態で停止: 残ページ消化前は通知なし → 消化後に 1 回。(b) overlay 単体: `pendingFinals` に未終端の id が残る状態で停止 → fallback `OFF_RECOG` 前は通知なし → 受信後に原文が表示され fade を経て 1 回。(b') **offscreen 単体**: engine を drop・destroy・timeout させ、台帳が **id 昇順で** `fallback: true` の `OFF_RECOG` を `postFinalRecognition` に渡すことを assert（順序違反・欠落・現行の無通知で落ちる）。(b'') **順序**: `id=1` in-flight・`id=2` drop の状態で `id=2` が先に送られないこと、および `id=2` が
**translated** でも先に送られないことを assert。(b''') **path 枯渇**: `translateWithFallback` を `null`
にして fallback が出ること、`setPath("none")` の splice で fallback が出ること。(b'''-2) **期限**: 先頭 id の Promise を
永遠に pending にした状態で期限を進め、fallback が出る **かつ `processing === false` に戻り、第 2 id が
翻訳されて終端する**こと（台帳だけ倒して engine を放置する実装は後半で落ちる）。`translate()` だけでなく
`selectBestPath` / `create` を永遠 pending にした変種でも同じ。(b'''-3) **期限後の遅延完了**: id 1 を期限切れにし、
id 2 の処理開始後に id 1 を成功・失敗の**両方**で遅延完了させ（失敗側は `failPath` → `selectBestPath` →
`setPath("none")` の枯渇経路まで進める）、history・通知・モデル・clone・経路・キュー・`processing`・
drain 待ち・overlay の `pendingFinals` のいずれも変化しないこと（無条件 `finally` の実装は id 3 の並行開始か drain 早期完了で落ちる）。
(b'''') **中継**: background の `SW_RECOG` / `SW_CAPTION` 変換テストで `fallback: true` が残ること（現行は落ちる）。
(b'''''') **先着優先の両向き**: fallback 解放後に同 id の翻訳が戻っても、translated 解放後に同 id の
fallback（期限・destroy）が来ても、台帳が捨て overlay の表示も台帳も変わらない。
(b''''') **改訂 + fallback**: 上の 3 段 fixture をそのまま使う。加えて待ち日本語 `CueData` の後に英語
fallback 末尾が来続けても merge で 1 件に結合されず、**`waitingCues.length ≤ 6` が保たれる**こと（適用側だけで
拒否する実装は模擬側の `dropCount = 0` で行列が伸びて落ちる）。(c) 一時停止: **drain 前**に `setPlaybackPaused(true)` で時計が止まることを先に assert し、その後明示停止 → 再度 `setPlaybackPaused(true)` でも時計が進み、全ページと fade を経て 1 回 → complete 後は `setPlaybackPaused(true)` が再び効く。(c') **timeout 経路**: fade が来ないまま安全網が切れて `OFF_STATE idle` を受けたら overlay が destroy され、次の capture の overlay で `setPlaybackPaused(true)` が効く（idle で destroy しない実装は落ちる）。常時 unpaused・再開しない・`drainMode` 残留のいずれも落ちる |
| A-6-5 live2 の表示ゲート | sampler はスロット数が 2 以外なら**失敗**として記録し（`live2.mjs:387` の skip を廃止）、1 行ページの `''` を保持する。`cue.dataset.cueId` / `pageId` を採取に加える。`cueId` は非空の opaque 文字列（正規形は `"1:0"`、merge 後は `"1:0+2:0"`、`overlay.ts:1064`、`:1262` — 数値要求は正常実装を落とす）。`pageId` の正しさは live2 ではなく **A-6-2 の決定的 fixture で DOM とともに `dataset.pageId` が `0 → 1` と変わることを同時に assert** する（定数 `"0"` の実装はそこで落ちる）。live2 は現行 `pageId` を採取していない（`live2.mjs:390`）ので採取を足し、畳みの鍵に使い、同一 `cueId` 内の `0 → 1` 遷移件数は**観測値として記録するだけ**でゲートにしない（既定入力が 2 ページ節を生む保証が無い）。判定: 300 ms サンプルを **`(cueId, pageId, 2行)` が同一の連続ブロック**へ畳む → 空行を除く → **連続する 2 ページの非空行の積集合が空**。空振り防止: **異なる `cueId` 間の非空ページ遷移 ≥ 1**。同一 `cueId` の page 0/1 両観測は live 音声では保証できない（`live2.mjs:37` の既定入力が 2 ページ節を生む保証が無い）ので、**観測値として記録し、ゲートにしない**。2 ページ経路の検証は A-6-2/A-6-3 の決定的 fixture が担う。停止期限は `STOP_DRAIN_TIMEOUT_MS = 30000`（`live2.mjs:30`）を翻訳 8 s + 字幕 20.35 s に対して **45 s に上げ、期限到達は失敗**にする。`blockScrollViolations` は廃止 |

## 設計 B: 反復抑制（**提案段階・本 PR に含めない**）

以下は別 PR。実装前に B-2 の未解決項目を埋める。反復ガードの候補位置では `RecognitionLine`
がトークン列を持たない（`text`/`id`/`final`/`at` のみ、`segmenter.ts:167`）ため、トークン化の方法も未設計である。

### B-1. 生成側

`no_repeat_ngram_size: 3` を Whisper 呼び出しに加える。transformers.js 4.2.0 は非
timestamp 経路から `super.generate` へ kwargs を通し、`NoRepeatNGramLogitsProcessor` を
適用する（`automatic-speech-recognition.js:202,269`、`modeling_whisper.js:167`、
`modeling_utils.js:424-425`）。ライブラリ改変不要。`repetition_penalty` は入れない（別レバー）。

### B-2. 検出側

指標は**連続 n-gram の最大連数**（n=1..4、トークン列）。長さ非依存。
実採取 1006 節での分布は 1 が 985 件・2 が 21 件・**3 以上ゼロ**。退化例は
`Ott Ott Ott`=3、`Ott`×5=5、`オットオットオット`=3、`Thank you.`×3=3。**閾値 3。**

**未解決（実装前に必ず埋める）:**

- この 1006 節は**翻訳後の日本語＋英語素通し**の混在で、英語 ASR 原文の分布ではない。
  ガードを置く場所と同じ母集団で較正し直す。置き場所の候補は SentenceAssembler の後・
  翻訳 enqueue の前（=ASR 原文）。**そのための英語原文の採取経路が今は無い**ので、
  live2 に原文を記録する経路を先に足す。
- 既存 `repeatedNgramExcess`（`segmenter.ts:1753`）は非連続の頻度超過であり別統計。
  置換か併存かを、英語原文で較正した後に決める。
- 正当な 3 連は単一トークンに限らない: `you know`×3、`come on`×3、「はいはいはい」、講演末尾の
  `Thank you.`×3。閾値 3 はこれらを落とす。較正データで判断するまで閾値を確定しない。
- `no_repeat_ngram_size: 3` は**非連続**の 3-gram 禁止で、B-2 の連続最大連数とは別統計。
- 単一トークンの3連（「ーーー」等）は正当な場合がある。単位長2以上、または単一トークンなら
  4連以上、という追加条件の要否を較正データで判断する。

### B-3. 受け入れ（各ゲートに「どう落ちるか」を明記）

| ゲート | 落ちる条件 |
|---|---|
| B-3-1 退化節を落とす | 較正に使った文字列**ではない**退化例を fixture にする。閾値を外した実装で落ちる。**本番経路（segmenter → 翻訳 enqueue）を通し、検出関数の単体呼び出しにしない** |
| B-3-2 正常節を落とさない | 実採取から取った非空の固定母集団。閾値を下げ過ぎた実装で落ちる |
| B-3-3 `no_repeat_ngram_size` が実際に届いている | worker の呼び出し引数を assert。未配線なら落ちる（WER 帯内では検出できない） |
| B-3-4 CfT WER が帯内 | 反復抑制が正常認識を壊していないこと |

**主張しないこと**: 反復は3条件（実音声2区間400秒＋無音35秒挿入）で再現していない。
再現クリップが無い以上、「修正が効いた」とは主張しない。主張できるのは
「機構が配線され、退化入力を落とし、正常入力とWERを壊さない」までである。
再現クリップが手に入った時点で初めて効果を測る。

## 非ゴール

暫定結果のブロック統合（A-4 で撤回・別 Issue）。翻訳モデルの変更。温度フォールバック
再デコード。`repetition_penalty`。3行以上の同時表示。

## BudouX（設計 C・本 PR とは分ける）

実測で現行の改行の 24%（74箇所中18箇所）が BudouX の句内に落ちている。ただし採用には
未設計の論点があり（Sol 指摘4）、表示の作り直しと同時にやると切り分け不能になるため
**別 PR に分離する**:

- `findNaturalTextBoundary` は候補生成・veto・スコア・距離選択・強制分割を一体化しており
  （`cue-text.ts:371`）、`FORBIDDEN_SUFFIXES` は幅規則ではなく候補 veto（使用箇所 `:583`）。
  責務分割の設計が要る。
- **BudouX は UTF-16 index、現行は `Array.from` の code-point index**（`parser.ts:68` /
  `cue-text.ts:115`）。変換を挟まないと位置がずれる。
- 予算内に BudouX 境界が無い入力（`カ`×40、保護 URL）では強制分割が要る。したがって
  「境界外 0%」は一般には成立しない。ゲートは「**強制分割を要した回数を記録し、
  それ以外で境界外に落ちた回数 == 0**」に変える。
- #47 の lossless・14/28 unit・終了性の property は維持する。
