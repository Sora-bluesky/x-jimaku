# Contributing to x-jimaku

[日本語版は下にあります / Japanese version below](#日本語)

Thanks for your interest. x-jimaku is an experimental extension and the codebase moves fast; small, focused pull requests have the best chance of landing quickly.

## Development setup

```bash
npm install
npm run build
```

Load the `dist/` directory via `chrome://extensions` → Developer mode → "Load unpacked". Chrome 138+ is required. After every rebuild, press the reload button on the extension card — Chrome does not pick up changed files on its own.

`npm run typecheck` must pass before you open a PR. There is no lint step beyond that today.

## Testing your change

- **Manual**: play an English video on x.com and click the toolbar icon. The options page shows the recognition log, the active model/device, and which translation path is in use.
- **Bench**: `node bench/run-bench.mjs --case tts --model base --backend plamo --plamo-model 0.8b --duration 45` runs a scripted end-to-end pass and prints word error rate and fragment rate (the share of recognized clauses with fewer than four words). PLaMo is the only bench backend. Use a locally cached Chrome for Testing, `--chrome <path>`, or `BENCH_CHROME`; the bench does not download Chrome. Anything that touches the recognition or segmentation pipeline should come with before/after bench numbers in the PR description. `bench/README.md` covers the Japanese-quality scoring flow.
- Pages served from `http://127.0.0.1:8123` (the bench server) accept `CS_DEV_TOGGLE` / `CS_DEV_SET_SETTINGS` window messages to drive capture without clicking the toolbar — useful for automated runs. These hooks are dead code on every other origin.

## Ground rules

- Keep accuracy claims tied to bench numbers, not impressions.
- Don't commit video or audio clips from x.com (copyright). The bench fetches its real-clip case locally via `yt-dlp` and it stays untracked.
- One concern per PR. A behavior change and a refactor should be two PRs.
- The translation pipeline (`translationBackend: "plamo"`) requires WebGPU and an available GPU adapter. It has no CPU fallback or Chrome built-in AI backend.

## Reporting issues

An issue with the video URL, your GPU, Chrome version, and what the options page showed for model/device/translation path is usually enough to reproduce. Screenshots of the caption behavior help a lot.

---

## 日本語

関心を持ってもらえて嬉しいです。x-jimaku は実験段階の拡張でコードベースの動きが速いため、小さく焦点の絞られた Pull Request が最も取り込みやすいです。

### 開発環境

```bash
npm install
npm run build
```

`chrome://extensions` → デベロッパーモード → 「パッケージ化されていない拡張機能を読み込む」で `dist/` を読み込みます。Chrome 138 以降が必要です。ビルドのたびに拡張カードの更新ボタンを押してください（ファイル変更は自動では反映されません）。

PR を出す前に `npm run typecheck` が通ることを確認してください。

### 変更の検証

- **手動**: x.com で英語動画を再生してツールバーのアイコンをクリック。オプションページに認識ログ・使用モデル/デバイス・翻訳経路が表示されます。
- **ベンチ**: `node bench/run-bench.mjs --case tts --model base --backend plamo --plamo-model 0.8b --duration 45`で一連の処理を自動実行し、認識誤り率と、認識された節のうち4語未満の節の割合（fragment rate）を出します。ベンチの翻訳バックエンドはPLaMoだけです。保存済みのChrome for Testing、`--chrome <path>`、または`BENCH_CHROME`を使います。ベンチはChromeを取得しません。認識・分節パイプラインに触る変更は、PR説明に変更前後のベンチ数値を添えてください。日本語訳質の採点フローは`bench/README.md`にあります。

### 約束ごと

- 精度の主張は体感でなくベンチ数値に紐づける
- x.com の動画・音声クリップはコミットしない（著作権）
- 1 PR に 1 つの関心事。挙動変更とリファクタは分ける
- 翻訳パイプライン（`translationBackend: "plamo"`）にはWebGPUとGPUアダプターが必要です。CPUへのフォールバックやChrome内蔵AIのバックエンドはありません。

### 不具合報告

動画 URL・GPU・Chrome バージョン・オプションページのモデル/デバイス/翻訳経路の表示があれば、だいたい再現できます。字幕の挙動のスクリーンショットがあると助かります。

## Release checklist

1. Check that the English and Japanese READMEs agree on what the extension does, its Chrome version and WebGPU requirements, how to install it from a GitHub Release, and its licenses. Do not claim anything that has not been built or measured.
2. Check that tracked files pass `npm run check:public` and CI's gitleaks scan. They must contain no local paths, user names, or internal notes.
3. Check that the full history passes the gitleaks scan in CI. Scan all refs and redact values in the output.
4. Enable secret scanning and push protection in the repository settings, and set the default Actions token to read-only. Allow only maintainers to write, and block force pushes and deletion of `main`.
5. Run Claude Security's "Scan codebase" on the release candidate, then reproduce and fix accepted findings. Focus on the content script on x.com, extension messaging, host permissions, CSP, and the integrity of downloaded model files.
6. Install the release zip into a fresh Chrome profile by following only the README. Check that captions appear, network requests go only to the model host, and the caption log stays on the device.
7. Check that screenshots, demo videos, and release notes show no user names, local paths, other people's data, or internal error details. Check that the release zip contains only the built extension.
