# Options page

Beyond model selection (`model-selection.md`), the options page has display settings (English original text, tentative-text dimming), pipeline settings (audio source language, translation backend), a translation-model preparation button, and a diagnostics panel that reports WebGPU and Chrome Translator API availability per execution context.

## Sub-features

- `options-english-original` toggles a checkbox ("英語原文も表示") that shows the English source text alongside the Japanese subtitle.
- `options-show-tentative` toggles a checkbox ("暫定を薄字で表示", `src/options/options.html:472-476`) that renders interim (non-final) caption text dimmed.
- `options-source-language` selects the audio's source language ("音声の言語": 英語 / 自動判定, `src/options/options.html:428-431`, settings field `sourceLang`).
- `options-translation-backend` selects the translation engine ("翻訳エンジン": 自動 / Chrome Translator / LanguageModel, `src/options/options.html:439-447`, settings field `translationBackend`) — this is the selector `live-subtitle-overlay.md`'s translation-path recipe drives.
- `options-prepare-translation` triggers a translation-model preparation/download pass ("翻訳モデルを準備する", `src/options/index.ts:289-294,607-682`).
- `options-diagnostics-run` runs the background diagnostics pass ("診断を実行" → `runBackgroundDiagnostics`, `src/options/index.ts:787-854`, wired at `:268-273`). Translator state is NOT part of this button — it has its own probe (next item).
- `options-diagnostics-translator` reports Translator API status specifically for the options-page execution context ("Options page Translator診断").
- `options-diagnostics-saved` retrieves a previously saved diagnostics result ("保存済み診断を取得") rather than re-running.
- `options-webgpu-report` shows WebGPU availability for the options-page context.

## How to get to it (user POV)

- Right-click the extension's toolbar icon → Options, or `chrome://extensions` → Details → Extension options.
- All controls in this feature live on that single options page under the "診断" (diagnostics) heading and the display-settings section above it.

## Driving it with real Chrome

Preconditions:

- Extension loaded unpacked from a freshly built `dist/`.
- Options page open in real Chrome (not CfT — see Gotchas).

- **English original toggle.** Check "英語原文も表示". Toggle subtitles on for an x.com video. Confirm the subtitle bar now shows both the English source and the Japanese translation, not just Japanese.
- **Toggle off.** Uncheck "英語原文も表示", then **restart the capture** (toggle subtitles off and back on for the tab) before checking. The overlay snapshots `showOriginal` at capture start (`CaptionOverlay` holds it as a fixed field, `src/content/overlay.ts:124`), so unchecking mid-capture leaves the current overlay showing English — that is correct behavior, not a failure. After the restart, confirm the subtitle bar is Japanese-only.
- **Tentative dimming.** Check "暫定を薄字で表示", start a capture on an x.com video and confirm interim text appears in a dimmed `.caption-tentative` line (`src/content/overlay.ts:341`, style at `:2892`) before each final line replaces it. Uncheck it, restart the capture, and confirm no dimmed interim line appears while finals still arrive. Capture one screenshot of each state.
- **Prepare translation model.** Read the button first. `renderTranslationAvailability()` (`src/options/index.ts:756-765`) disables it and relabels it `翻訳モデル準備済み` when the pack is already installed, and disables it (label unchanged) when the API is not exposed or the pack is unavailable; both are correct states, record them and skip the click. Only when it reads "翻訳モデルを準備する" and is enabled: click it, and the status line must go to `翻訳モデルを準備しています…` then `翻訳モデルの準備が完了しました。` (`src/options/index.ts:607-682`). A failure message after a click is a finding. On Chrome for Testing the download hangs (Gotchas) — run it in real Chrome only.
- **Pipeline settings.** Change "音声の言語" and "翻訳エンジン" and confirm both persist across an options-page reload (they save on `change` via `saveSelectedSettings`, like the model picker). Restore the previous values afterwards — `translationBackend` in particular redirects every future capture (see `live-subtitle-overlay.md`'s translation-path recipe and its restore step).
- **Run diagnostics.** Click "診断を実行". This runs the background/offscreen diagnostics snapshot only (`runBackgroundDiagnostics`, `src/options/index.ts:787-854`, wired at `:268-273`). The WebGPU result is rendered automatically at page load (`optionsWebGpuPromise` at `src/options/index.ts:192`, rendered in its `.then` at `:251-266`), not by this button.
- **Translator probe.** Click the separate Translator button ("Options page Translator診断" → `runOptionsTranslatorProbe`, `src/options/index.ts:856-956`, wired at `:275-280`) to get the Translator status for the options-page context.
- **Retrieve saved diagnostics.** Click "保存済み診断を取得" without re-running. Confirm it returns the last diagnostics result rather than blocking on a fresh probe.
- **Proof.** Screenshots of the dimmed and non-dimmed interim states and of the completed preparation status line, plus: screenshot the diagnostics panel after clicking both "診断を実行" and the Translator probe (their results populate separately), plus a screenshot of the subtitle bar with the English-original toggle on.

## Gotchas

- **The Translator diagnostics result from the options page describes the options-page (`chrome-extension://`) origin, not the content-script origin.** Per `live-subtitle-overlay.md`, `chrome-extension://` cannot successfully `create()` a Translator even when the language pack is installed — so an options-page diagnostics failure here does NOT mean live subtitle translation on x.com is broken. Do not conflate the two; the content-script path is the one that actually serves translation to users.
- **This diagnostics panel cannot be fully exercised under Chrome for Testing** — the Translator pack download hangs there, so any CfT-driven diagnostics run will show an incomplete or stalled Translator status regardless of extension correctness.
- The English-original toggle only affects rendering, not ASR/translation — verifying it does not substitute for verifying translation quality itself (see `live-subtitle-overlay.md`).
- "保存済み診断を取得" reads a cached result — if the extension or Chrome was updated since the last "診断を実行" pass, the cached result may be stale; re-run diagnostics fresh when in doubt rather than trusting the cache.
