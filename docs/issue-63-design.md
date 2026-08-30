# Issue #63 設計: 救済エラー種別の分離と DEV ログ中継

Status: rev2（Sol Max 1 巡の変更必須 4 点を反映して凍結。実装パケットで再検証）
Date: 2026-08-31
動機: 実測（live2 tts2・#49 コメント）で 47 行中 22 行が英語素通し。誤義ゲートは全通過して
おり安全側動作だが頻度が過剰。機構は `rescueLanguageModelLine` の catch が全エラーを
`failPath`（恒久無効化）で扱うこと（`translate.ts:765-777`・loop 頭 `:707` が以後スキップ）。

## 現状の事実（file:line）

1. 救済 catch は error 種別を見ず `failPath(rescuePath)`（`translate.ts:777`）。対象は
   「空結果」「placeholder 検証失敗」「translator 未初期化・翻訳例外」の全て。
2. `failedPaths` に入った path は復活しない（`translate.ts:707`。セッション中恒久）。
3. placeholder 検証失敗は行単位の意味的結果（その行の出力が壊れただけ）で、path の健全性を
   示さない。probe では Translator の placeholder 生存 100%・Nano 8/9。
4. offscreen の warn/info（救済失敗・素通し・キュー drop）は offscreen console にのみ出て、
   live2 収集経路（page console・overlay）から観測不能。#50 の drop ゲートも これで非計測に
   なった。

## 設計

### A. 救済エラーの 2 分類（意味的失敗は path を殺さない）

`rescueLanguageModelLine` の catch を分岐する。**判別は専用 Error クラス
（`PlaceholderVerificationError`）の instanceof のみ**（`name` 一致は上流エラーと衝突し得る
ためレビューで却下）。**専用クラス以外は全てインフラ失敗**（形に依存しない安全側の既定）:

| エラー / 入力形 | 分類 | 動作 |
|---|---|---|
| `restoreMaskedTranslation` が null（検証失敗・専用クラスで送出） | 行単位・意味的 | **failPath しない**。次の救済 path へ（この行のみ。恒久的に意味失敗を繰り返す場合も path は生かし、安全は素通しが担保） |
| 空結果・空白のみ | インフラ | 従来どおり `failPath`（rev1 の「意味的」はレビューで却下: 恒常空返しの Translator を生かし続け、外側が原文成功で即終了するため経路健全性判定に到達しない） |
| `available:false` / 未初期化の `undefined`（現状 "" へ畳まれる） | インフラ | 空結果へ畳む前に区別し、従来どおり `failPath` |
| 準備失敗（`prepare*` false・try の外） | インフラ | 現行どおり skip（変更なし） |
| translate 例外・relay 不可（ポート不在・送信失敗・タイムアウト・切断・停止/取消・非進行中・content 不在・生成/翻訳失敗） | インフラ | 従来どおり `failPath` + active なら `selectBestPath` |

既存の翻訳主経路・fallback 選択のロジックは変えない。

### B. DEV origin 限定のログ中継（観測可能性）

- offscreen → background → content へ、`OFF_DEV_LOG {level, tag, message, data}` を新設。
  発火点は translate の warn/info のうち **救済失敗・素通し確定・キュー drop の 3 種のみ**
  （全 warn の横流しはしない。ノイズと性能の両面）。
- **二重ゲート**（レビュー指摘: 背景の CS_DEV_* 判定は content 受信専用で、無条件転送だと
  x.com の content port まで届く）: ①background は**宛先 port のタブ origin が DEV origin の
  ときだけ**転送する ②content は既存 CS_DEV_* と同じゲート（`content/index.ts:310`）で再度
  止めてから page console に `[x-jimaku-dev]` prefix で出力する。
- イベントは `{kind, requestId, lineId}` を持ち、重複排除キーは (kind, requestId, lineId)。
  **ゲートに使う素通し率は従来どおり collector の実表示ベース**（採取行中の EN 行率）で、
  relay イベントは機構診断（救済決定数・drop 数）に限定する（レビュー指摘の「救済決定 ≠
  実表示」の混同を排除。destroy 等で表示されなかった決定はイベントに出るが率には入らない）。
- これで live2 採取スクリプトが素通し率・drop 数を機械カウントできる（#50 の未計測ゲートも
  次回から計測可能になる）。

### 非ゴール

Nano プロンプトへの placeholder 指示追加（プロンプトレバーは rev5 で計測不採用の前科。
本件のエラー分類で不足が実測されたときだけ、別 Issue で 1 レバー 1 計測）。ladder の順序
変更。キュー深さ。

## 受け入れ

1. 単体テスト: 検証失敗 → failPath されず同一行が次 path へ進む / インフラ失敗 → 従来どおり
   failPath、の両ピン。空結果の非 failPath ピン。
2. live2 tts2 再採取: **EN 素通し率 < 22/47**（機械カウント。B の中継で直接数える）・
   `ローマ(?!ン)`==0 と未解決 `%%`==0 の維持・judge 誤訳 ≤ 4+2。
3. live2 tts 再採取: drop 数を B で初計測して記録（ゲートは置かない。初計測のため）。
4. CfT bench: WER 帯内（ASR 非接触の確認のみ）。
5. Grok 敵対レビュー → CI → Codex Bot。
