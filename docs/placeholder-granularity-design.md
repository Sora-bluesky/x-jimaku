# 占位子の粒度（#91 / #69 のレバー）

> 2026-09-06。#91 実装順 3+4（PR #104）の後に測った事実と、そこから決める 1 つの規則。
> 正本は `docs/naming-corpus-design.md` §2-4（「レバーは占位子の生存」）。この文書はその 1 項目の設計。

## 1. 事実

tts2・original-on・60 秒・各ビルド 3〜5 走行。占位子の「戻った / 送った」と、文
「The Roman Space Telescope is ready for launch.」が `masked` 段で着地した本数。

| ビルド | 表 | Roman の文 masked / 本数 | 占位子 戻り / 送り |
|---|---|---|---|
| `ad43f93` | 旧表（`Roman` 1 語のみ） | 14 / 30 | 60 / 101 |
| `160e19e`〜`1e96e58` | 新表（`Roman Space Telescope` を 1 語に） | 6 / 30 → 2 / 30 | 62 / 100 → 50 / 98 |
| `621f509` + 行 1 つ除去 | 新表から `Roman Space Telescope` だけ外す | **14 / 18** | **57 / 67** |

同じ文を `The %%1%% Space Telescope is ready for launch.` と隠すと 7 割が戻り、
`The %%1%% is ready for launch.` と隠すと 1 割も戻らない。他の行は両ビルドで 6 割前後で変わらない。
deep-reasoner の形状別集計（新表 5 走行）: `The @ is ready for launch.` 4/32、
`The team at @ finished the final checks.` 17/18、`@ will map wide regions of the sky.` 9/9。

損失は「モデルが占位子を出力に含めない」で 70 記録中 69（重複・全角・余分な地の文は主因ではない）。
system prompt は `%%N%%` を一度も説明していない（`translate.ts:177-178`）。Translator が
`downloadable` な環境では梯子の 1〜2 段が空振りして unmasked LanguageModel に落ちる（落ちる先で
あって引き金ではない）。

## 2. 読み

占位子が節の内容語をほぼ全部飲むと、モデルにとって節は「`%%1%%` と機能語」だけになり、
写しではなく作り直しをする。内容語が残っていれば、占位子は「置いておく記号」として扱われる。
これは表の行の長さではなく、**その節に残る内容語の量**の問題で、同じ行でも
`Kennedy Space Center finished the final checks` のように内容語が残る節では保つ。

## 3. 規則（1 つだけ）

`createMaskPlan`（`term-masking.ts`）で表の占有候補を長い順に取るとき、**その候補を隠した後の節に
内容語が 3 語未満（2 語以下）しか残らないなら、その候補を隠さず、その候補に入れ子になっている
次に短い表の行へ譲る**。

- 内容語 = `[A-Za-z]+(?:['’-][A-Za-z]+)*` に一致する語（`isn't` / `launch-ready` は 1 語、数字は数えない、
  日本語は数えない）のうち、機能語リスト（the / a / an / is / are / was / were / be / been / to / of /
  in / on / at / for / by / with / and / or / but / it / its / this / that / these / those / will / would /
  can / could / has / have / had / not / as / from）に無いもの。
- 数える対象は、**すでに採用した候補とこの候補**を占位子に置き換えた後の節（ページ由来の候補も
  採用済みなら置き換える）。
- 入れ子の行は現行の `findNonOverlappingOccurrences` が先に落とすので（`term-masking.ts:421`）、
  表の候補は入れ子を含めて集め、この判定の後に重なりを解く。譲った先の行が曖昧行なら、
  証拠規則（`glossary.ts` `allowKeepLatinMaskOccurrence`）はその行に対して従来どおり効く。
  証拠が無ければその名前は隠れない（`[定訳]` には残る）。これは `maskable: false` 案でも同じ。
- ページ由来の候補と上限 4 は変えない。表の候補が譲ったとき、重なりで落としていたページ由来の
  候補は復活させない（譲った先の行と重なるため）。「ページ由来 5 件以上で計画なし」も従来どおり。
- 閾値は 2 語以下を初期値にし、§5 の走行で動かす。

効果の予測（§1 の数字から）: `The Roman Space Telescope is ready for launch.` は長い行を隠すと残余が
"ready launch" = 2 語なので飛ばし、`Roman` を隠す（残余 "Space Telescope ready launch" = 4 語）。
旧表の形に戻り 7 割が戻る。復元は `Roman` の行の `ja`（ローマン）+ モデルの "Space Telescope" 訳。
`Engineers at Goddard say Roman will change how we see the universe.` は残余が十分なので変わらない。
`After years of testing at NASA Goddard.`（ASR 崩れの断片）は `NASA` と `Goddard` を隠しても
残余 "After years testing" = 3 語なので両方隠す。

やらないこと: 表の行を消さない（`Roman Space Telescope` の `ja` は救済プロンプトの `[定訳]` と、
内容語が残る節では引き続き使う）。system prompt への占位子の説明は別の A/B（H2）にし、
この規則と同時には入れない（効果が混ざる）。

比べた代案: 長い行だけ `maskable: false` にする案は影響範囲が小さいが、§2 の読みが正しければ
原因は行ではなく節に残る内容語の量で、次に長い行（Goddard Space Flight Center 等）が短い節に
出たときに同じことが起きる。規則で受けるのを先にし、閾値が合わなければ §5 の順で代案へ落とす。
最短の行を優先する案は、曖昧行と部分復元（`ローマン Space Telescope`）の問題を共有し、
内容語が残る節でも長い行の `ja` を捨てるので採らない。

## 4. 計測

- 実装順 6 で入った `rung` と、`placeholder-survival` の `sent / returned / response / refusal`
  （`321ae01`）。
- before = `1e96e58` の 5 走行（記録済み）、after = 5 走行、§5-3 の片側 Wilcoxon。
- **この PR の受け入れ**（改善の証拠。「後退の証拠なし」を改善と読まない）:
  1. Roman の `ローマ`（A-1 の分子）の走行ごとの率が下がる証拠がある（片側 Wilcoxon で after < before）。
  2. 占位子の戻り率（戻り / 送り）が走行ごとに上がる証拠がある。送信数も併記し、
     送らなくなっただけで率が上がる形（before 98 → 送信が大きく減る）を除外する。
  3. A-2 / A-4 / A-5 で他の名前に後退の証拠が無い。Roman の A-3 が下回らない。
- **#91 / #69 を閉じる条件**は正本のまま A-1 = 0（全走行）。この PR は上の 1〜3 で受け入れ、
  A-1 = 0 に届かなければ #91 は開いたまま次のレバー（H2）へ進む。
- 走行ごとの値と、同じ原文（Roman の文）の送信・復元・最終字幕の本数を表に出す。

## 5. 確信度と、外れたときの戻し方

- 確信度: 高（同じ文で 3 条件、他行が動かない対照つき）。閾値 2 語以下は初期値で根拠は §1 の形状表だけ。
- 外れ方: 閾値が高すぎると短い節で名前が隠れなくなり、`ローマ` が増える（A-1 が悪化）。
  そのときは閾値を 1 語以下に下げるか、この規則を外して `Roman Space Telescope` の行を
  `render: "ja"` のまま**マスク対象外**の印（`maskable: false`）にする案へ切り替える。
- 部分復元（`ローマン Space Telescope`）の頻度は未計測。after の走行で `response` から数え、
  目立てば復元検査に「復元後に ASCII の大文字語が残る」を足すかを別に決める。
