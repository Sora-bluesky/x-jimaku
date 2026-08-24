# x-jimaku

[English](README.md) | [日本語](README.ja.md)

X (x.com) の動画にリアルタイム日本語字幕を重ねる Chrome 拡張（Manifest V3）。

- 音声認識: ローカル Whisper（transformers.js + WebGPU）。クラウド API 不使用・無料
- 翻訳: Chrome 内蔵 Translator API（端末内の軽量翻訳モデル・GPU 不要）
- 方式: `chrome.tabCapture` でタブ音声を取得し、数秒遅れで動画下部に字幕を表示
- ON 中は対象動画に「字幕ON」チップを表示

## ステータス

設計完了・実装未着手（2026-08-24）

## 開発（予定）

```
npm install
npm run build   # dist/ を chrome://extensions で load unpacked
```

要件: Chrome 138+（Translator API）。WebGPU 推奨（ない場合は小さめの Whisper モデルで WASM にフォールバック）。

## ライセンス

MIT
