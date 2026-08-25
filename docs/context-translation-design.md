# P3-7 文脈付き翻訳（Prompt API）設計

> 2026-08-25 起草。Sol Max 設計レビュー（REQUEST-CHANGES 3 件）を反映済み・実装可。
> 前提事実は code-reader の実測マップ（translate.ts:46 TranslationEngine / 4 段フォールバック
> translate.ts:318-356 / language-model 段 translate.ts:471-538 は文脈なし素 prompt / 固有名詞辞書は
> segmenter のみで翻訳段に未接続 / settings に翻訳バックエンドキーなし）。

## 目的

翻訳段に「直前の確定文脈 + 固有名詞辞書」を渡し、Prompt API（Gemini Nano、将来 Gemma 4）で
文脈整合の高い訳を得る。採否はベンチ（ja 訳質採点 = score-ja）の before/after で判定する。

## 変更点

### 1. settings に翻訳バックエンド選択を追加

- `Settings.translationBackend: "auto" | "translator" | "prompt-api"`（既定 "auto"）
- "auto" = 現行 4 段フォールバック順そのまま
- "translator" = language-model 段をスキップ（Translator 2 段 + none）
- "prompt-api" = language-model 段を最優先に並べ替え（不可なら従来順に降格）
- options UI にセレクタ 1 個追加（表示名: 翻訳エンジン）。ベンチはこの設定を
  chrome.storage.sync 経由で切り替えて A/B する

### 2. TranslationEngine に文脈を供給

- `TranslationEngineOptions` に `getContext(): TranslationContext` を追加
  - `TranslationContext = { recentPairs: {en: string, ja: string}[], properNouns: string[] }`
  - recentPairs は直近の確定 (en, ja) 最大 2 組。ja は翻訳完了時に engine 自身が記録する
    （翻訳失敗行は push しない）。**skip-marked（日本語のためそのまま表示）の行も
    `{en: text, ja: text}` として履歴に push する** — EN A → ja B → EN C の並びで C の直前文脈が
    A に飛ぶのを防ぐ（Sol 指摘 1）
  - properNouns は **getContext() 呼び出し時点の activeContextTerms を毎回取得**する
    （関数経由の遅延評価。辞書は最初の CS_PCM で後着するため、参照の固定・生成時スナップは禁止）
- 履歴保持は TranslationEngine 内部（`recentHistory: {en, ja}[]`、上限 2、destroy でクリア）。
  segmenter・overlay には触らない

### 3. language-model 段のプロンプト構成

- system prompt（base セッション生成時に固定）は**役割指示のみ**:
  「あなたは英語動画の日本語字幕翻訳者。与えられた英語の節を、直前の文脈と固有名詞リストに
  整合する自然な日本語に訳す。出力は当該節の訳だけ。説明・引用符・前後の節の再訳は出力しない」
- **固有名詞リストは system に入れず、毎回の per-line prompt に含める**（辞書は最初の CS_PCM で
  後着するため。Sol 指摘 1 — base 再生成より単純で、後着・更新の両方に自動追従する）
- 毎回の prompt(text):
  ```
  [固有名詞（原綴りのまま使う）]
  <properNouns join ", ">          ← 空なら本ブロック省略
  [直前の文脈]
  EN: <recentPairs[0].en>
  JA: <recentPairs[0].ja>
  EN: <recentPairs[1].en>
  JA: <recentPairs[1].ja>          ← 文脈が無ければ本ブロック省略
  [今訳す節]
  <text>
  ```

### 4. 応答の後処理（LLM 出力の防御）

- 前後の引用符・コードフェンス・「訳:」等の前置きを剥がす（正規表現 1 パス）
- 不良応答の判定: 空、または Latin 文字率 > 50%（**判定前に properNouns の各語と ASCII 連続語
  （辞書照合可能な固有名詞）を除去してから計算** — 「OpenAI APIでGPT-5を使う」の誤棄却防止。
  Sol 指摘 2）、または応答長が入力の 4 倍超
- 不良応答時の行単位救済（Sol 指摘 2 準拠）: **再キュー禁止**。同一行の処理内で
  ①Translator（offscreen → content の順に、生成済みか生成可能なもの）を 1 回だけ試す
  ②全滅なら**原文（英語）をそのまま結果として返す**。FIFO の順序は崩れない

### 5. 性能ガード

- prompt() 1 回ごとに **AbortSignal.timeout(10_000)** を渡し、単発ハングを打ち切る
  （打ち切りは不良応答扱い → §4 の行単位救済へ）
- prompt() の所要が 3 秒を超えた行が直近 5 行中 3 行に達したら、language-model 段を
  failPath して Translator へ恒久降格（字幕はレイテンシ優先）。
  **降格時は failPath の直後・同一の処理単位内で selectBestPath を完了させてから次の
  キュー項目に進む**（path=null のまま次行処理に入ると停止する。translate.ts:540-554。Sol 指摘 3）
  ※ 3 秒 / 3/5 の閾値は暫定値（根拠未計測）。ベンチで translationMs を記録し、実測後に確定する
- キュー規律（MAX_PENDING_TRANSLATIONS=2、最古 drop）は現行のまま

## ベンチ A/B 手順

1. `--backend translator|prompt-api` を run-bench.mjs に追加（settings 書き込みだけ）
2. 同一ケースで両バックエンド × 2 run、score-ja で ja 訳質（誤訳/欠落/不自然の件数）を比較
3. 採用条件: prompt-api が誤訳+欠落の合計で悪化せず、不自然が減ること。かつ体感レイテンシ
   （translationMs の中央値をベンチ結果に記録）が 1.5 秒以内

## 非目標

- P3-6（Translator への文脈連結方式）は本設計に含めない（Prompt API 比較の結果を見て判断）
- Gemma 4（Canary Dev Trial）対応の専用コードは書かない — Prompt API 実装がそのまま使われる

## リスク

- 環境により LanguageModel.availability() = "unavailable"（CfT 149 で実測）。
  その場合 "prompt-api" 設定でも従来順へ無音降格ではなく、options に実効パスを表示している
  現行 UI（activeTranslationPath）で判別可能
- Gemini Nano のセッションはトークン上限あり。session.prompt() の連続呼び出しは会話として
  累積し quota を食い潰すので、**base セッション（system prompt 済み）を保持し、行ごとに
  `base.clone()` して 1 発 prompt → clone を destroy** の stateless 運用とする（API 上正しいことは
  Sol が公式ドキュメントで照合済み）。clone 不可・quota エラー時は base を作り直し、それも
  失敗したら failPath。**engine.destroy() は base と処理中の clone の両方を destroy する**
  （Sol 指摘 3）。`src/types/builtin-ai.d.ts` に clone / AbortSignal 付き prompt の型を追加する
