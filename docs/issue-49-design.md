# Issue #49 設計 — 固有名詞の訳語固定と文脈プロンプト強化

Status: rev3・凍結（2 巡目の残 2 件 = 引数検証の明記・基準値 14 件への再固定と正規表現表記の修復を反映。基準値は host が再検証済み）
Date: 2026-08-30
Before 実測（tts2 fixture・prompt-api/base・PR #57）: 誤訳6/欠落4/不自然6（n=35）。
「Roman」は contextTerms 供給下でもほぼ全節で「ローマ」化。Goddard は
ゴッドダード/ゴダード/グラッド/ギャラード と揺れる。judge ノイズはカテゴリ ±2（実測）。

## ゴール / 非ゴール

**ゴール**: リストにある固有名詞が一般語化・音写揺れせず、原綴りのまま訳文に残る。
tts2 の after で誤訳 −3 以上 + 機械カウント条件（下記）を満たす。

**非ゴール**: recentPairs 数の変更（レバー③・本バッチでは触らない。1 レバー 1 計測）/
出力の固有名詞照合→救済（レバー④・①②で不足の場合のみ次バッチ）/ 小文字語の抽出
（post 本文から一般語と区別できない）/ ASR 側の認識改善そのもの。

## 現状の事実（file:line）

1. 抽出は単一トークン regex（`src/content/index.ts:2818-2820`
   `[\p{Lu}][\p{L}\p{M}\p{N}'’._-]{3,}` + @handle）。**複数語名は分割されて届く**
   （NASA Goddard → NASA + Goddard・Kennedy Space Center → 3 分割）。長さ <4 は除外
   （:2829-2838）・stoplist（:2844-2851）。
2. terms は content → background → `OFF_START` → offscreen の
   `activeContextTerms`（プロンプト用）と `segmenter.setProperNounDictionary`（ASR 用）の
   **両方に同一リスト**で流れる。
3. プロンプトの固有名詞ブロックは `[固有名詞（原綴りのまま使う）]` の見出し + 語の列挙のみ
   （`src/offscreen/translate.ts` の `createTranslationPrompt`）。**対訳の明示も
   「一般語として解釈しない」の否定形もない** — before 実測はこの形で Roman→ローマ化。
4. system prompt（`TRANSLATION_SYSTEM_PROMPT`）は役割指示のみ。リスト外の未知固有名詞の
   扱いは未指定。

## 設計

### D1. 抽出の複数語対応（`extractPostContextTerms`）

前提の訂正（レビュー 1 巡目）: ASR 側 `setProperNounDictionary` は**空白を含む語を静かに
破棄し**（`offscreen/index.ts:603` / `segmenter.ts:1777`）、機構も Whisper 事前バイアスで
なく認識後の単語補正（`segmenter.ts:1161`）。したがって複数語 term を足しても ASR には
届かず、単語粒度さえ保てば ASR は無傷になる。

- 単一トークン走査は**現行のまま変更しない**（ASR への入力を凍結）。複数語 term は
  抽出の**末尾に追記**する（先頭に置くと 40 件上限（`content/index.ts:2859`）で構成単語が
  押し出され superset が崩れる。末尾なら溢れ時に落ちるのは複数語のみ = プロンプト側の
  機会損失にとどまる）。
- 複数語の文法（決定）: 空白類の連続を 1 個の ASCII 空白に正規化した上で、
  `\p{Lu}` 始まり・2 文字以上のトークンが空白 1 個で連続する**最長 run の先頭 4 語**を
  1 term とする（5 語以上は先頭 4 語で打ち切り・重複窓の列挙はしない）。小文字接続詞を
  含む名前（Statue of Liberty）は対象外（受容する制限として明記）。ハイフン・アポストロフィは
  現行の単語内文字規則を踏襲。@handle は run に含めない。結合後 4〜128 文字。
  stoplist は連結後キーに適用（構成語単体の stoplist は run を壊さない）。
- **fixture 側の前提修正**: `bench/serve.mjs` は contextTerms を空白連結で描画するため
  （`serve.mjs:70`）、そのままだと `Roman NASA Goddard Kennedy Space Center` という偽の
  跨ぎ run を作る。terms を**句点付き・改行区切り**で描画するよう fixture を直す
  （本番 x.com の post 本文では文として区切られているのが通常形）。

### D2. プロンプトの対訳固定（レバー①）

- 固有名詞ブロックを対訳行形式に変更:
  ```
  [固有名詞（訳さず右の表記をそのまま出力に使う）]
  Roman → Roman
  Kennedy Space Center → Kennedy Space Center
  ```
  右辺は常に原綴り（対訳辞書を持たない現状では左右同一。将来 EN→JA 別表記を許す拡張点）。
- ブロック末尾に否定形を 1 行: 「これらは固有名詞。一般語・地名・別の固有名詞として
  解釈しない（例: Roman を都市のローマと解釈しない、のような一般則として書く。
  fixture 固有の例をプロンプトに焼き込まない）」。
- 実装は `createTranslationPrompt` の該当ブロック生成のみ変更。recentPairs・
  [今訳す節] ブロックは不変。

### D3. system prompt の未知固有名詞 1 文（レバー②）

- `TRANSLATION_SYSTEM_PROMPT` に 1 文追加: 「リストに無い語でも、大文字で始まる語・
  見慣れない語は固有名詞として原綴りのまま残す」。
- リスク: 文頭大文字の一般語（The/This 等）への過剰適用 → 否定形は付けず「見慣れない語」
  で限定し、after の unnatural 非悪化（+2 以内）で監視する。悪化したらこの 1 文だけ
  戻す（レバー分離のため D2 と別コミットにする）。
- **復唱ガード（レビュー 1 巡目・注記 3 の回収）**: モデルが対訳行や見出しを復唱すると、
  `removeProperNouns` が両辺を除去して矢印だけが残り Latin 比率検査を通過し得る
  （`translate.ts:1315` 系）。`isBadLanguageModelResponse` に「応答が `→` を含む /
  対訳行・ブロック見出しの復唱に一致する」を不良条件として追加し、既存の行単位救済へ
  回す。単体テストでピンする。

### D4. 計測（受け入れ）

1. 単体テスト: 抽出の複数語ケース（連結・stoplist・superset・上限）/ プロンプトの
   対訳行レンダリング。既存テストスタイルで新規ピン。
2. tts2 after（live2 手順・prompt-api/base・95 秒・同一 judge 手順）:
   - 誤訳 ≤ 3（before 6 から −3。ノイズ ±2 に対し有意）
   - unnatural ≤ 8（+2 = ノイズ帯内）・欠落 ≤ 6（before 4 + ノイズ 2）
   - 機械カウント（judge 非依存の客観条件・**before 実測で再固定**）: 対象 =
     after の live2 JSON の `recognition.jaClauses` を NFKC 正規化して連結した文字列。
     条件 = 正規表現 `ローマ(?!ン)` の一致 **0 件**（before 実測 **14 件**・host 再検証済み）かつ
     正規表現 `\bRoman\b`（大文字小文字区別）の一致 **5 件以上**（before: 0 件）。判定コマンドを
     PR に添付
3. tts の after も 1 回採取し、誤訳が before(10) + 2 を超えないこと（副作用の広域検知。
   なお tts fixture も @BenchAuthor を常時表示するため厳密な「無固有名詞対照」ではない）
4. WER 系（CfT）: `run-bench.mjs` の `loadCase` **と `--case` 引数検証（`run-bench.mjs:137-138` の tts|tibo 限定）の両方**に tts2 を追加し
   （properNouns = 複数語込みリスト・CfT でも ASR 辞書経路と空白語破棄が実走する）、
   tts/base/90s ×2 と tts2/base/90s ×2 を実測。判定 = 小数第 3 位丸めで
   各 run ≤ 0.35 かつ 2 回の最小値 ≤ 0.25（同一コード実測 {0.103, 0.207, 0.241,
   0.310, 0.310} に基づく帯。tts2 は今回が初計測なので帯は記録のみ・判定は tts 側）
5. Grok 敵対レビュー（blocking 3 種限定）→ CI → Codex Bot 着弾確認

## 実装分割

- コミット 1: D1 抽出 + fixture の terms 描画修正 + run-bench の tts2 ケース + 単体テスト
- コミット 2: D2 対訳ブロック + 復唱ガード + 単体テスト
- コミット 3: D3 の 1 文（独立で revert 可能に）
実装は Sol xhigh 委任（read-only・大ファイルは SEARCH/REPLACE 納品・読み取り専用の閲覧は
明示許可）。同一 PR 内 3 コミット。
