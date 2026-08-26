# x-jimaku

[English](README.md) | [日本語](README.ja.md)

A Chrome extension (Manifest V3) that overlays live Japanese subtitles on videos playing on x.com.

<!-- screenshot -->

## Features

- Real-time Japanese subtitles overlaid under X (Twitter) videos
- Speech recognition and translation run entirely on-device, so no audio or text ever leaves your machine
- No tab-share indicator, and tab audio keeps playing normally, because the extension taps the video element directly instead of using tab capture
- Toggle per video from the toolbar icon or a keyboard shortcut (Ctrl+Shift+9)
- Four Whisper model sizes (tiny / base / small / turbo) to trade off speed and accuracy
- Automatic fallback from WebGPU to WASM on unsupported hardware

## How it works

The content script grabs the target `<video>` element's audio with `captureStream()`, resamples it to 16kHz PCM, and streams it to an offscreen document running Whisper (via transformers.js) for local English speech recognition, using WebGPU where available and falling back to WASM otherwise. Recognized text is translated from English to Japanese with Chrome's built-in Translator API, which also runs on-device. The result is drawn as a fixed caption bar over the bottom of the video, showing Japanese only by default (an options-page setting adds the smaller English source line), with in-progress lines re-translated roughly every two seconds as more audio comes in.

```
video element --captureStream()--> 16kHz PCM
   --> offscreen document: Whisper (transformers.js, WebGPU/WASM) --> English text
   --> Chrome Translator API (en -> ja, on-device) --> Japanese text
   --> caption overlay under the video
```

## Install

Chrome Web Store listing is not available yet. Install from a GitHub Release:

1. Download the `dist` zip from the [Releases](../../releases) page and unzip it.
2. Open `chrome://extensions`.
3. Enable "Developer mode" (top right).
4. Click "Load unpacked" and select the unzipped `dist` folder.

## Usage

1. Play a video on x.com.
2. Click the extension icon in the toolbar (or press Ctrl+Shift+9). Supported videos not yet loaded show a subtitle-related tag.
3. The target video shows a 「字幕 準備中…%」 chip while the model loads, then a 「字幕ON」 chip once captioning starts (chip labels are in Japanese).
4. Click again to stop. Other visible videos show a faint 「対象外」 (not targeted) badge.

## Models

Pick a model on the options page: `tiny`, `base` (default, ~150MB), `small`, or `turbo`. The chosen model downloads from Hugging Face the first time you start captioning, with a progress chip shown during the download.

## Privacy

Audio and recognized text never leave your device. Whisper speech recognition runs locally in an offscreen document (the model is downloaded once from Hugging Face and cached), and translation uses Chrome's built-in, on-device Translator model. There is no server component and no telemetry.

## Requirements

- Chrome 138 or later (required for the built-in Translator API)
- WebGPU is recommended (e.g. an NVIDIA GPU) for reasonable speed; without it the extension falls back to WASM, which is noticeably slower
- Translation normally needs no setup: Chrome fetches the language pack automatically. If translation doesn't appear, check the diagnostics on the options page.

## Tips

For fast-talking videos, lowering the X player's playback speed (e.g. to 0.75x) gives the pipeline more time to keep up, so captions fall behind less.

## Limitations

- Speech recognition targets English only. Setting the speech language to "auto" will still show the original (non-Japanese) text for non-English audio.
- Captions run a few seconds behind live playback.
- Intended for one video open and captioned at a time.

## Scope of use

x-jimaku is built for personal, local use. It only post-processes what your own browser is already displaying, entirely on your machine: no audio, transcript, or translation ever leaves your device, nothing is stored, and the extension makes no requests of its own to x.com (no X APIs, no crawling, no downloads). We reviewed this design against X's Terms of Service (effective April 10, 2026) and Japanese copyright law's private-use provisions before publishing.

Please keep it that way when using or forking this project. Features such as saving or sharing transcripts, downloading media, or automated browsing are out of scope here — they would put the project on the wrong side of those terms.

## License

MIT
