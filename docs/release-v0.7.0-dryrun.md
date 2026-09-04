# v0.7.0 リリース手順（実行前の洗い出し）

実行していません。手順と、実際に確かめた事実だけを並べます。

## 版番号がある場所

| 場所 | 現在 | 備考 |
|---|---|---|
| `public/manifest.json` の `version` | `0.6.0` | **ここだけが実質の版番号**。ストアもここを見る |
| `public/manifest.json` の `version_name` | なし | ビルド時に `dist/manifest.json` へ注入される（`243c591`）。手で書かない |
| `package.json` の `version` | `1.0.0` | **v0.6.0 の時点で既にずれている**。誰も見ていない。今回そろえるか、外すかを決める必要がある |
| git tag | `v0.6.0` | リリース作成時に付く |

**注意**: `package.json` が `1.0.0` のまま `manifest.json` が `0.6.0` という状態が既にあります。今回どちらに寄せるかを決めないと、次も同じずれが残ります。

## 前回（v0.6.0）がどう作られたか

ここが今回いちばん心もとないところです。released の記録から分かるのは次だけで、どういう手順で zip を組んだのかは残っていません。同じものを作れる保証がありません。

- 対象は `main`、2026-08-30 06:00Z
- 添付は `x-jimaku-0.6.0.zip` 1 本のみ（28.3 MB）
- **zip を作る script も workflow もリポジトリにありません**。手作業か、記録に残っていない手順です

## 手順

1. **#72 を main にマージ**（sora の承認待ち）
2. `public/manifest.json` の `version` を `0.7.0` に
3. `package.json` をどうするか決める（そろえる / 版管理から外す）
4. `npm run typecheck && npm test && npm run build`
5. `dist/manifest.json` の `version_name` が `0.7.0 <sha> <時刻>` になっていることを目視
6. **実機確認 1 本**（下記）
7. zip 化。前回と同じ名前なら `x-jimaku-0.7.0.zip`。**中身が何だったかは記録が無いので、v0.6.0 の zip を落として構成を確認してから作る**
8. tag `v0.7.0` を打ち、release を作成
9. リリースノートに告知文（`docs/caption-log-notice.md`）から**字幕ログが既定オンである旨**を必ず入れる
10. `node .claude/local/wbs/build-release-matrix.mjs` で関連表を更新

## マージ直後に走らせる実機確認 1 本

```bash
node bench/live2.mjs --case theo --duration 180
```

引数なしで**両構成（英語行オン・オフ）が回ります**。見る値は 4 つ。

| 値 | 期待 | 理由 |
|---|---|---|
| `primaryClipped` | 0（両構成） | 今回の中心。片方だけの合格を一度出しているので両方見る |
| `captionTopChanges` | 0 | 字幕が上下に動かないこと |
| `sentenceFitRate` | 1.0 | 一区切りが 1 画面に収まること |
| `captionLogEntries` | 1 以上 | 記録が**実際に動いた**こと。配線の有無ではなく作動の確認 |

`englishPassthrough` は `--case tts2 --duration 95` の側で見ます（固有名詞が密なのはそちら）。期待は 0。

## 未確定

着手前に決めておかないと、手が止まるか、前回と違うものを出すことになります。

- `package.json` の版をどうするか
- zip の中身（前回の構成が記録されていない）
- ストア掲載を更新するかどうか
