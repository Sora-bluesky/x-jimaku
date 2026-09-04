# v0.7.0 リリース手順

着手前に洗い出した手順と、実際に確かめた事実を並べます。実行済みの項目にはその印を付けてあります。

## 版番号がある場所

| 場所 | 現在 | 備考 |
|---|---|---|
| `public/manifest.json` の `version` | `0.7.0` | **ここだけが実質の版番号**。ストアもブラウザもここを見る |
| `public/manifest.json` の `version_name` | なし | ビルド時に `dist/manifest.json` へ注入される（`243c591`）。手で書かない |
| `package.json` の `version` | `0.7.0` | v0.6.0 の時点では `1.0.0` でずれていた。#86 でそろえた |
| git tag | `v0.6.0` | リリース作成時に付く |

ずれを直すだけでは同じことが起きるので、`src/build/version.test.ts` が両方のファイルをディスクから読んで突き合わせます。片方だけ上げるとテストが落ちます。実際、書いた時点では `1.0.0` と `0.6.0` で落ちました。

`manifest.json` の版が数字3つの形であることも同じテストが見ます。Chrome はこの形以外を受け付けませんが、拒否されるのは zip を作ってアップロードしたあとです。

## 前回（v0.6.0）がどう作られたか

zip を作る script も workflow もリポジトリに無く、手順も残っていませんでした。**公開 zip を落として中身を読んで確かめた**のが次の内容です。

- 添付は `x-jimaku-0.6.0.zip` 1 本（27.0 MB・40 エントリ）
- 中身は `dist/` そのもの。包むディレクトリは無く、`manifest.json` がルート直下にある
- 現在の `dist/` と 40 対 40 で一致し、差はハッシュ入りのファイル名 3 本だけ

そのとき分かった欠陥がもう1つあります。**40 エントリのうち 32 個が `assets\probe.worker.js` の形で格納されていました。** zip の仕様では区切りはスラッシュです。Chrome は受け取りましたが、仕様どおりの展開ソフトはこれを「名前にバックスラッシュを含む 1 個のファイル」として作ります。

この事実は最初、確認の途中で一度見落としています。Python の `zipfile` は読み込み時にバックスラッシュを黙ってスラッシュへ直すので、そちらで見ている限り正常に見えました。中央ディレクトリの生バイトを読んで分かったことです。

## zip の作り方

```bash
npm run zip
```

`scripts/build-zip.mjs` が `dist/` を読んで `dist-zip/x-jimaku-<版>.zip` を書きます。

- 版はビルド済みの `dist/manifest.json` から取る。ファイル名が拡張の名乗る版とずれない
- zip は Node で組み立てる。`Compress-Archive` を呼ぶのをやめたのは、上記のバックスラッシュを避けるためと、Windows でしか動かないため
- タイムスタンプは 1980-01-01 に固定。同じ `dist/` からは同じバイト列が出る（実測: 2 回実行して sha256 一致）
- 書いたあと、**展開ソフトと同じ手順で読み直して照合する**。エントリ名の集合が `dist/` と一致するか、CRC が通るか、中身がディスク上のファイルとバイト単位で同じか

最後の照合は飾りではありません。`Compress-Archive` 版を書いていたときにバックスラッシュを検出したのがこの照合です。

`npm run zip -- --list` はファイル一覧を出すだけで書き込みません。

未コミットの変更がある状態でビルドした `dist/` は拒否します。`version_name` の `-dirty` で判定しています。その zip は誰も作り直せませんが、入れてしまえば普通に動いて普通の版を名乗るので、あとからは見分けがつきません。開発中に試すときは `--allow-dirty` を付けます（実測: 拒否時の exit code は 1）。

### v0.7.0 の zip（実測）

```
40 entries verified byte for byte, 28.2 MB
```

公開済み v0.6.0 との照合:

| | 件数 |
|---|---|
| 共通 | 37 |
| v0.7.0 のみ | 3（`assets/probe.worker-C2hbD1vO.js` / `chunks/explicit-stop-drain-k6U0pwAB.js` / `chunks/messages-56_U29p8.js`） |
| v0.6.0 のみ | 3（同じ 3 モジュールの旧ハッシュ名） |
| バックスラッシュ格納 | v0.6.0 は 32、v0.7.0 は 0 |

Python の `zipfile` で `testzip()` も通しました（全エントリ合格）。自前の読み直しとは別の実装で確かめています。

## 手順

1. ~~#72 を main にマージ~~（済・`dad9fca`）
2. ~~`public/manifest.json` と `package.json` を `0.7.0` に~~（済・#86）
3. `npm run typecheck && npm test && npm run build`（済・エラー 0 / 464 件通過）
4. `dist/manifest.json` の `version_name` が `0.7.0 <sha> <時刻>` になっていることを目視（済・`0.7.0 dad9fca-dirty 2026-09-04T04:15:19Z`）
5. ~~Chrome で 1 本走らせて確認~~（済・下記）
6. `npm run zip`（済）
7. tag `v0.7.0` を打ち、release を作成
8. リリースノートに、**字幕ログが既定でオンである**ことを必ず入れる（文面は `docs/caption-log-notice-surfaces.md` の 3 面目）
9. `node .claude/local/wbs/build-release-matrix.mjs` で関連表を更新

7 以降は公開行為なので sora の判断を待ちます。

## マージ直後に Chrome で 1 本走らせた結果

`node bench/live2.mjs --case theo --duration 180`。引数なしで両構成（英語行オフ・オン）が回ります。

| 値 | 期待 | original-off | original-on |
|---|---|---|---|
| `primaryClipped` | 0 | 0 | 0 |
| `captionTopChanges` | 0 | 0 | 0 |
| `sentenceFitRate` | 1.0 | 1.0 | 1.0 |
| `captionLogEntries` | 1 以上 | 52 | 53 |
| `englishPassthrough` | 0 | **1** | **1** |

前の 4 つは期待どおりです。`englishPassthrough` だけが 1 でした。中身を見ると、どちらも日本語行に英語が 1 行入っています。片方は fallback として記録され、片方は記録されていません。記録されない経路があることが分かったので #87 に切り出しました。

60 秒・120 秒の過去実行はどちらも 0 ですが、その窓では該当の行に到達していません（16 cue と 37 cue で終わっている）。マージ前の 180 秒実行が無いため、**1 が新しく出たものかどうかは、この数字からは言えません。**

`captionLogDwell` は `closedPages` が 0 で、滞留時間は出ていません。bench はスクロールしないのでページが閉じないためです。#83 の効果はここでは測れません。

## 未確定

- ストア掲載を更新するかどうか（sora の判断）
