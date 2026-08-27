# Live subtitle overlay

The core end-user feature: on a real x.com video with audio, the extension captures the tab's audio, runs it through offscreen ASR, translates the result, and renders a live Japanese subtitle bar over the video. This is the feature the bench harness cannot reach — it requires a real Chrome instance and a real x.com page, and must be verified manually.

## Sub-features

- `overlay-caption-render` shows recognized/translated text in a subtitle bar positioned over the video.
- `overlay-target-detection` distinguishes a supported video (subtitle bar appears) from an unsupported one (`対象外` badge instead).
- `overlay-translation` shows Japanese output via the Chrome Translator API when available.
- `overlay-english-fallback` shows English-only output with a "translation unavailable" indication when the Translator API cannot create a translator (see Gotchas).

## How to get to it (user POV)

- Open a video with audio on `x.com` or `twitter.com` with the extension loaded and enabled for that tab.
- Play the video — capture and the overlay engage automatically once subtitles are toggled on for the tab (see `toggle-controls.md`).

## Driving it with real Chrome

Preconditions:

- `npm run build` has just completed and the unpacked extension in `chrome://extensions` has been reloaded (🔄) against the fresh `dist/`.
- Subtitles are toggled ON for the tab (toolbar icon or `Ctrl+Shift+9` — see `toggle-controls.md`).
- A real x.com/twitter.com tab with a playing video that has audio.
- This is real Chrome, not Chrome for Testing (CfT) — CfT cannot complete the Translator pack download, so translation cannot be verified there (see Gotchas).

- **Target video.** Open a video with audio and let it play. The subtitle bar appears over the video within the model's processing latency; observe it transition `字幕 準備中…N%` → `字幕ON` as loading completes.
- **Non-target video.** With capture active on the target video, bring a second **unmuted, visible** video into view. A `対象外` badge appears on it — confirm no subtitle bar renders and no ASR activity starts for that video. A muted video will NOT show the badge (`refreshOtherVideos` filters on `!video.muted`, `src/content/overlay.ts:1714-1732`); target selection itself has no muted filter (`refreshTarget`, `src/content/overlay.ts:1670-1700`), so a muted video can even end up as the capture target instead. Either way a muted example cannot demonstrate `対象外` — a correct build would fail the recipe. See `toggle-controls.md` for the full badge conditions.
- **Caption content.** Let the video play for 15-20 seconds of speech. Confirm the subtitle bar text updates with plausible Japanese text tracking the audio (not frozen, not garbled placeholder text).
- **Translation path.** Confirm the rendered text is Japanese, not English — this is the signal that the Translator API succeeded from the content-script origin at `x.com`.
- **Proof.** Screenshot the video with the subtitle bar visible and readable text, at a point where the bar shows `字幕ON` (not the loading percentage state). Capture a second screenshot of the `対象外` badge case on a non-target video in the same session.

## Gotchas

- **Chrome for Testing cannot verify translation.** The Translator pack download hangs under CfT (`create()` never resolves) — this is a component-updater constraint, not a bug in the extension. Any bench-driven or CfT-driven check of this feature will silently stall on the translation step; do not attempt it there.
- **`chrome-extension://` origin cannot create a Translator either**, even in real Chrome — only the content-script origin (`x.com` itself) can. If a check is run from an offscreen-document context expecting translation to work, it will fail with "Unable to create translator..." — this is expected and not a regression; the content-script path (real x.com page) is the one that must be verified.
- A persistent CfT profile also caches a stale service worker across rebuilds — irrelevant here since this feature is verified in real Chrome, but relevant if a CfT profile is ever reused across sessions for anything adjacent.
- "It should work" is not a substitute for this manual pass — HANDOFF.md is explicit that this feature must be confirmed against a real x.com video before any completion claim.
- Muted videos and fullscreen/scroll interactions are known areas that need hands-on confirmation each time the overlay or capture logic changes — don't assume a passing bench run covers them.
