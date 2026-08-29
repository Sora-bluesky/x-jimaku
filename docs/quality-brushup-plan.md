# 翻訳精度・字幕可読性ブラッシュアップ計画（x-jimaku）

## Context

2026-08-29 の実機確認で、コア機能（字幕・翻訳・SW 停止耐性）は合格した一方、sora から 2 点の品質要望が出た: ①翻訳が不自然（実例:「またロマンは泣くでしょう」— Roman 望遠鏡の固有名詞が一般語として訳された）②字幕の読みやすさをさらに上げたい。調査の結果、精度側は P3-7 文脈付き翻訳・固有名詞注入・score-ja 訳質採点が実装済みで **before/after の実測が未記録**、可読性側は**根本原因確定済みの既知バグが 3 件**（折返しクランプ欠如 / 助詞誤判定 / 片側かぎ括弧剥がし）と単体テスト不在が残っている。運用は sora 指示どおり **GitHub Issue を先に立て、Issue ごとに PR** で進める。

前提: v0.4.5（ログノイズ回収 + stop 時翻訳 drain・別バッチ・Sol Max 設計レビュー中）が**先行**する。本計画はその後続。

## Issue 分割（5 本）

| # | 種別 | タイトル案 | 中身 |
|---|---|---|---|
| A | 計測 | bench: record JA translation-quality baseline via score-ja | v0.4.5 マージ後に tts/base・tts/small × prompt-api/translator の jaClauses を採取し、score-ja（LLM-judge・誤訳/欠落/不自然）の before を `bench/results/` に記録。同一結果を 2 回採点して判定ノイズ幅も記録。コード変更は手順 doc 化のみ |
| B | 可読性 | overlay: clamp wrapped cue lines and fix particle boundary false positives | (a) `wrapCueText` 2 行目の絶対長クランプ（[overlay.ts:2454-2476](src/content/overlay.ts:2454)・分割不能ユニットは強制切り）(b) 助詞境界の語中誤マッチ排除（[overlay.ts:26-41, 2715-2739](src/content/overlay.ts:2715)）。**手法: 禁止形テーブル（「です」「ですが」「ながら」「だが」「でも」「まで」等）を主、前接文字クラス（ひらがな連続ならボーナス 1→0）を副**。形態素解析器の同梱はバンドル増のため不採用。wrap/split の単体テスト新設（ランダム長 + URL のプロパティ的テスト 1 本含む） |
| C | 可読性 | translate: make bracket stripping balance-aware | `normalizeLanguageModelResponse`（[translate.ts:1100-1110](src/offscreen/translate.ts:1100)）を 3 関数に分離（code fence / ラベル / 括弧）。括弧は**全体が単一の対応ペアで囲まれている場合のみ 1 段剥がす**。片側のみ・交差は無変換。export して単体テスト新設 |
| D | 精度 | translate: pin proper-noun renderings and strengthen context prompt | 優先度順に: ①properNouns を対訳形式（`Roman → Roman`）+ 「一般語として解釈しない」の否定形明示 ②リスト外の大文字始まり語の固有名詞フォールバック指示 ③recentPairs 2→3 の A/B（降格発生率を同時記録・悪化なら戻す）④（①〜③で不足時のみ）出力の固有名詞照合→行単位救済。1 レバーごとに score-ja 採点 |
| E | 精度 | segmenter: merge ultra-short clauses before translation (P1-1) | n 語以下の節を次節へ併合してから翻訳投入。cue 数減で表示遅延が悪化しないことを bench で確認 |

精度（A/D/E）と可読性（B/C）は Issue も PR も混ぜない。D と E も別 PR（score-ja 差分の寄与を分離するため、1 レバー 1 計測）。

## 順序

```
v0.4.5（先行・別バッチ）
   ├─► A ベースライン記録 ─► D プロンプト/固有名詞 ─► E 極短節連結
   └─(A と並行可)─► B wrap/助詞 ─► C 括弧バランス
```

- A は **v0.4.5 マージ後**に取る（drain 変更が jaClauses 採取件数に影響するため、先に取ると before が無効化される）
- B/C は訳文を変えないので A と並行可能

## 表示スタイルの参照（YouTube 自動字幕・2026-08-29 sora 提供の画面録画から観察）

sora が「非常にわかりやすく読みやすい」と評価した YouTube 自動字幕（日本語自動翻訳）の
実フレーム観察。注目点は、**YouTube も語中改行をする**（実測:「見てみまし／ょう」）のに
読みやすいこと。可読性の差は改行位置ではなく次の 3 点から来ている:

1. **文単位のまとまり**: 複数の短文を 1 キューに連結し 2 行をフルに使う。書き換え頻度が低い
2. **中央揃え + テキスト幅ぴったりの半透明黒帯**（行ごとに帯幅が変わる）
3. **句点の後にスペース**を入れて文の切れ目を視覚化

**動的挙動（同録画 t=31〜41 秒を 2fps・20 フレームで連続観察・2026-08-29 追記）**:

1. **追記型 2 行バッファ**: 表示中の文の後ろに次の文が**同じキューへ追記**され、必要に応じて
   2 行目へ折り返す（in-place 伸長。実測: 「ここで…起動しましょう。」→ 約 1 秒後に
   「〜ましょう。　見てみましょう」へ伸長）。2 行が埋まったら次の文で丸ごと置換
2. 文と文の連結は**句点 + 全角スペース**
3. 埋まったキューは **2.5〜3 秒以上保持**。**無音区間では字幕を完全に消す**（古い字幕を残さない）
4. 折返しは語中でも切る（改行品質より追記の安定性と塊の大きさが可読性を作っている）

→ Issue E（極短節連結）はこの方向の第一歩。E の実測後、後続の表示スタイル Issue
（split-on-display 設計と同時期）で次を検討する: 「追記型 2 行バッファ表示（cue 置換を
やめ、確定 clause を表示中キューへ追記して 2 行まで伸ばす）」「句点 + 全角スペース連結」
「無音時のクリア」「中央揃え + テキスト幅の可変帯」。追記型は overlay の cue キュー規律
（連結・加速・破棄）の再設計を伴うため、v0.4.5 の drain 実装が安定してから着手する。

## 翻訳品質の参照（YouTube 自動翻訳の機構調査・2026-08-29 Grok Web 調査・一次情報つき）

YouTube の自動翻訳字幕は音声を直接訳さず、**完成した字幕トラックをサーバ側 MT
（公式表記 "machine translation, such as Google Translate"）に通す**
（https://developers.google.com/youtube/v3/guides/implementation/captions）。
VOD の自動字幕は全文先読みのオフライン ASR（USM 論文 https://arxiv.org/abs/2303.01037 ）。
**ライブの自動翻訳字幕は公式製品として存在しない**（ライブ自動字幕は英語のみ・通常遅延限定・
https://support.google.com/youtube/answer/6373554 ）。表示後の再翻訳もしない（VOD はトラック
確定行）。

判定:

- **構造的に取れない差**: オフライン全文 ASR / サーバ側 Google Translate 規模の MT /
  通常遅延バッファ。比較対象（VOD 自動翻訳）はリアルタイム・オンデバイスと土俵が違う
- **持ち込める技法**: ①ASR と翻訳を分離し完成テキストを訳す（採用済み）②10 語断片でなく
  **句点までの文・節を翻訳単位にする**（Issue #50 の直接の裏付け。文単位 NMT に断片を入れる
  と品質が落ちる学術観測 https://dl.acm.org/doi/pdf/10.1145/3234695.3241023 とも一致）
  ③**翻訳前の句読点復元**（新レバー候補: Whisper 出力の句読点を translation 前に整える。
  #50 の後の検討）④文完成まで表示を遅らせる安定表示（表示スタイル Issue の方向）
  ⑤表示済み確定行を再翻訳しない（採用済み）

## スコープ外（明示）

- **split-on-display**（cue 分割を表示直前に遅延・遅延の根本削減）: 今回入れない。cue キュー・表示規律・grace episode に波及が大きく、v0.4.5 の drain 直後にキュー投入タイミングを変えると障害切り分けが困難。B の wrap 修正は将来の split-on-display にそのまま再利用される。**B/C 完了後に単独の設計 Issue（Sol Max 設計レビュー付き）として起票**
- Whisper initial prompt（P2-5）: transformers.js 4.2.0 に API が無く upstream 待ち（確定済み）
- 形態素解析器（kuromoji 等）の同梱: バンドル数 MB 増・overlay 同期処理に不適合

## 受け入れ条件（実測ゲート）

- A: 同一ケース 2 回採点で 3 分類が各 ±1 以内に再現。WER は既知値 ±0.01
- B: 全入力で各行 ≤ MAX_LINE_UNITS(14) をテストで保証。助詞誤判定の回帰 10 例以上でボーナス 0。bench 回帰でドロップ率・遅延の悪化なし
- C: 「「A」とB」型で内側が破壊されない。fence/ラベル剥がしの既存挙動をテストで固定
- D: score-ja で mistranslation が before 比 −30% 以上（閾値は A の判定ノイズ幅を見て再設定可）かつ unnatural 非悪化。WER 不変
- E: omission/unnatural 改善・mistranslation 非悪化・cue latency 非悪化
- D/E の PR 本文には SCORE 行 + 採点日時 + backend + case を必ず添付。数値未添付はマージ不可

## 実装体制（既定どおり）

各 Issue → ブランチ → **Sol xhigh 実装**（read-only・FILE 全文出力を host 適用）→ typecheck/test/build → bench 回帰 → **Grok 敵対レビュー**（blocking 3 種限定）→ CI → Codex Bot 着弾確認 → マージ。D のプロンプト変更は挙動設計を伴うため、実装前に Sol Max 設計レビューを 1 回通す。

## 変更対象ファイル

- [src/content/overlay.ts](src/content/overlay.ts)（B: wrapCueText / JAPANESE_PARTICLES / findNaturalTextBoundary）
- [src/offscreen/translate.ts](src/offscreen/translate.ts)（C: normalizeLanguageModelResponse 分離、D: createTranslationPrompt / TRANSLATION_SYSTEM_PROMPT）
- [src/offscreen/segmenter.ts](src/offscreen/segmenter.ts)（E: 節併合。単体テスト新設）
- [src/content/overlay.test.ts](src/content/overlay.test.ts) + 新規テストファイル（B/C）
- [bench/score-ja.mjs](bench/score-ja.mjs) / [bench/README.md](bench/README.md)（A: 手順固定）

## 検証（end-to-end）

1. 各 PR: `npm run typecheck` / `npm test` / `npm run build` + `node bench/run-bench.mjs --case tts --model base --duration 90`（WER 0.241 近傍）
2. 精度 PR: `--backend prompt-api` で採取 → `score-ja prepare` → agy 採点 → `score-ja parse` の before/after 比較
3. 可読性 PR: 実機（x.com 動画）で長文・URL 入り・かぎ括弧入りの字幕表示を目視 + スクリーンショット証跡
4. 完了判定: 5 Issue クローズ + sora の実機体感確認（「またロマンは泣くでしょう」級の誤訳が同素材で再発しないこと）

## 承認後の最初のアクション

1. GitHub に Issue A〜E を起票（本計画の該当節を英語要約して本文に。humanizer-en 通し）
2. 本計画書を `docs/quality-brushup-plan.md` にコピー（リポ内永続化・sora 運用ルール）
3. v0.4.5 の進行と並行して B から着手（A は v0.4.5 マージ待ち）
