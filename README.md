# x-jimaku

[English](README.md) | [日本語](README.ja.md)

A Chrome extension (Manifest V3) that overlays live Japanese subtitles on videos playing on x.com.

Speech recognition runs locally with Whisper (transformers.js + WebGPU), and translation uses Chrome's built-in Translator API. Nothing leaves your machine: no cloud APIs, no API keys, no usage fees.

How it works: the extension captures tab audio with `chrome.tabCapture`, transcribes it in an offscreen document, translates English to Japanese on-device, and draws captions under the video a few seconds behind playback. While the extension is on, the target video shows a small "subtitles on" chip.

## Status

Design stage, no working code yet (2026-08-24).

## Development (planned)

```
npm install
npm run build   # then load dist/ unpacked at chrome://extensions
```

Requires Chrome 138 or later (Translator API). WebGPU is recommended. Without it the extension falls back to WASM with a smaller Whisper model.

## License

MIT
