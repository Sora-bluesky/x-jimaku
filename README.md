# x-jimaku

[English](README.md) | [日本語](README.ja.md)

x-jimaku adds Japanese subtitles to English videos playing on x.com. It is a Chrome extension using Manifest V3. Speech recognition and translation run in the browser.

Built with PLaMo.

## Demo

![x-jimaku showing Japanese captions over a White House video on x.com](docs/demo/x-jimaku-demo.gif)

This is a 38-second silent excerpt of x-jimaku running on [a video the White House posted on X on November 7, 2026](https://x.com/WhiteHouse/status/2118852881684246741). It uses the default settings: Whisper base and PLaMo 0.8B. An [MP4 copy](docs/demo/x-jimaku-demo.mp4) is also available.

- Source: The White House. Its [copyright policy](https://www.whitehouse.gov/copyright/) says government-produced materials on its site are not copyright protected.
- The White House has not endorsed x-jimaku. The clip was picked because one speaker talks in clear English. Its use here is not a political statement. The Seal of the President on the lectern and on the flag is blurred.
- The Japanese captions are machine translation produced live by PLaMo 3 Translate. They are not an official translation and contain mistakes. The small English line under a caption is speech that has not been translated yet.

## Features

- Japanese captions over the video, with an option to show the English source.
- Start and stop from the toolbar icon or Ctrl+Shift+9.
- Whisper speech recognition through transformers.js. Choose tiny, base (default), small, or turbo.
- PLaMo 3 Translate through a bundled wllama build on WebGPU. Choose 0.8B (default), 2B, or 8B.
- Standard translation or やさしい日本語 (easy Japanese).
- A built-in glossary for names and terms, plus recent translations as context.
- A PLaMo cache panel showing stored files and sizes, with a delete button.
- An options-page self-check, 「この PC で試す」 (try on this PC), and recognition diagnostics.
- A local caption display log with copy, download, and erase controls.

The extension takes audio directly from the video element with `captureStream()`. Whisper transcribes it into English in an offscreen document. PLaMo translates the finalized text into Japanese. The overlay shows the captions while the video's audio continues to play. There is no tab-sharing prompt.

## Requirements

Chrome 138 or later must expose WebGPU and an available GPU adapter. Translation has no CPU fallback. The extension does not use Chrome's built-in AI.

See [model sizes and measured requirements](docs/requirements.md) before choosing a PLaMo size. Measurements cover a single RTX 4070 12 GB, Windows 11, and Chrome Canary 159. Other GPUs and operating systems have not been tested here.

An internet connection and local storage are needed for the first model downloads. Whisper and PLaMo are separate downloads. Cached files are reused.

## Install

Releases are distributed only through [GitHub Releases](../../releases). There is no Chrome Web Store release.

1. Download the release asset named `x-jimaku-<version>.zip` and extract it.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Click **Load unpacked** and select the extracted folder containing `manifest.json`. The zip contains the extension files directly, without a `dist` wrapper folder.

## Usage

1. Open the extension's options page from its menu. Choose the Whisper model, PLaMo size, and translation style. Settings apply when you next start captioning.
2. With captioning stopped, run 「この PC で試す」 to check your machine. It may download the selected PLaMo model. See [what the self-check shows](docs/requirements.md#check-your-machine).
3. Play an English video on x.com.
4. Click the toolbar icon or press Ctrl+Shift+9. The video shows a preparation chip while models load, then 「字幕ON」 when captioning starts.
5. Click again to stop. Use the options page to enable the English source line or inspect recognition results.

## Models and licenses

PLaMo uses the pfnet GGUF models with Q4_K_M quantization. They download from huggingface.co at first use. The model revision is pinned, and the downloaded file's size and SHA-256 are checked before use. The options page lists the PLaMo cache and can delete all its files. The next load downloads deleted files again. Changing sizes replaces the previously cached PLaMo model.

PLaMo 3 Translate is under the [PLaMo Community License](https://plamo.preferredai.jp/info/plamo-community-license-en). Personal and other non-commercial use is free without registration. Commercial use is free after registration if the user or its affiliates had revenue or sales of at most JPY 1 billion in the latest fiscal year. Above that, a separate license agreement is required. Read the full license for its terms.

[Whisper](https://github.com/openai/whisper) is under the MIT License. The extension downloads ONNX models from onnx-community on Hugging Face and runs them through transformers.js, which uses the Apache License. Whisper base is the default. Model weights are not included in the release zip. See [third-party notices](THIRD-PARTY-NOTICES.md) for the bundled runtime and other components.

## Privacy

All audio processing, speech recognition, and translation happen in the browser. Audio, transcripts, and translations are not uploaded. The extension downloads models from huggingface.co and hf.co, including CDN hosts such as us.aws.cdn.hf.co. Settings are saved with chrome.storage.sync. When Chrome sync is on, Chrome syncs them through your Google account. Settings contain no audio or subtitle text. There is no application server or telemetry.

Subtitles and the caption log stay on the device. The log uses Chrome local storage. Copying or downloading a log is a local action. Sharing that export is up to you.

## Caption display log

Logging is **on by default**. It keeps the subtitle text, not just layout measurements.

Each displayed page records its wrapped Japanese lines, the English source, cue and page identifiers, and the times it appeared and disappeared. The log also records English lines accepted by the overlay, their translation stage, and cues dropped under queue pressure. Some accepted lines may never reach the screen.

The log keeps the latest 400 pages and 400 lines. Older records are dropped, and the export includes truncation counts. It is intended to help match a subtitle problem to what was said and shown.

Use the options page's 「表示ログ」 section to switch logging on or off, copy, download, or erase it. Switching it off stops new records and keeps existing ones. 「表示ログを消す」 clears the stored log. Anyone sharing the Chrome profile can read it.

## Limitations

- The intended translation path is English speech to Japanese captions, with a single video captioned at a time.
- Only the default 0.8B model has end-to-end product measurements. The 2B and 8B sizes have prototype measurements, not product-path quality or latency measurements. Other GPUs are unmeasured.
- The default PLaMo file is 573,126,848 bytes, in addition to Whisper. Its prototype first load, including download, took 63.8 s on the measured machine. Download time depends on the connection. See [the size table and calculated download times](docs/requirements.md).
- In the measured 0.8B runs, latency from the end of a matched script sentence in the audio to the appearance of a Japanese caption page was p50 2.58 s and p90 4.50 s across 88 matched pages, and 28 pages could not be matched. Per-run p50 ranged from 2.0 to 4.2 s. Translation alone had per-run p50 of 0.60–0.78 s (per-run p50 of 604–783 ms).
- Captions can be too fast to read. In those runs, 60% of pages (42% of shown time) exceeded 7 Japanese characters per second; 72% (58%) exceeded 4. These are observations, not reading-speed targets.
- Recognition and translation can be wrong, and captions can be delayed or omitted. WebGPU is required; there is no CPU-only captioning path.

## Troubleshooting

- If loading or translation fails, stop captioning and run 「この PC で試す」 on the options page. Check WebGPU, adapter information, and any load error. The self-check does not certify that a model will fit or that live captioning will keep up.
- If captions stop or 「音声がありません」 (no audio) appears, bring the x.com tab to the foreground and check that the video is playing. Inspect the audio level and recognition results on the options page.
- To fetch PLaMo again, stop captioning, delete its saved data on the options page, and restart captioning.

## License

The extension's code is under [MIT](LICENSE). Models and bundled third-party components have their own licenses, as described above and in [third-party notices](THIRD-PARTY-NOTICES.md).
