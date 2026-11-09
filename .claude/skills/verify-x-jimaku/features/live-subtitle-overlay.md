# Live subtitle overlay

The core end-user feature: on a real x.com video with audio, the extension captures the tab's audio, runs it through offscreen ASR, translates the result, and renders a live Japanese subtitle bar over the video. `run-bench.mjs` scores ASR and waits for PLaMo initialization; `live2` collects the translation and overlay gates. `node bench/live2.mjs` (added 2026-09-01) does reach the translation and overlay stages unattended, but in real Chrome against the fixture page on `127.0.0.1:8123`, not against x.com — the x.com DOM (target selection, `対象外` badge, post-text term extraction) is still manual-only.

## Sub-features

- `overlay-caption-render` shows recognized/translated text in a subtitle bar positioned over the video.
- `overlay-target-detection` distinguishes a supported video (subtitle bar appears) from an unsupported one (`対象外` badge instead).
- `overlay-translation` shows Japanese output via PLaMo 3 Translate on WebGPU.
- `overlay-english-fallback` shows English-only output with 「翻訳未使用」 when PLaMo initialization fails (`translationPath === "none"`).
- `overlay-sentence-units` (since #50, 2026-08-30): *final* caption lines are bundled into sentence units before display and translation — the sentence assembler (`src/offscreen/sentence-assembler.ts`) buffers final clauses until sentence-final punctuation, a 20-word cap, or a 4s timeout (`sentence-assembler.ts:5-7`). Tentative (interim) lines still stream at clause granularity; only the final cadence changed.
- `overlay-context-terms` extracts proper nouns from the visible post text and supplies them to the PLaMo glossary prompt (`src/offscreen/plamo-glossary.ts`).

## How to get to it (user POV)

- Open a video with audio on `x.com` or `twitter.com` with the extension loaded and enabled for that tab.
- Play the video — capture and the overlay engage automatically once subtitles are toggled on for the tab (see `toggle-controls.md`).

## Driving it with real Chrome

Preconditions:

- `npm run build` has just completed and the unpacked extension in `chrome://extensions` has been reloaded (🔄) against the fresh `dist/`, **and the x.com test tab itself has been reloaded afterwards** — without the tab reload, the re-injected content script sees the old `window.__xJimakuContentScriptVersion__` marker and refuses to initialize (see SKILL.md Launch).
- Subtitles are toggled ON for the tab (toolbar icon or `Ctrl+Shift+9` — see `toggle-controls.md`).
- A real x.com/twitter.com tab with a playing video that has audio.
- WebGPU is available and the selected PLaMo model can be loaded.

- **Target video.** Open a video with audio and let it play. The subtitle bar appears over the video within the model's processing latency; observe it transition `字幕 準備中…N%` → `字幕ON` as loading completes.
- **Non-target video.** With capture active on the target video, bring a second **unmuted, visible** video into view. A `対象外` badge appears on it — confirm no subtitle bar renders and no ASR activity starts for that video. A muted video will NOT show the badge (`refreshOtherVideos` filters on `!video.muted`, `src/content/overlay.ts:1747-1783`); target selection itself has no muted filter (`refreshTarget`, `src/content/overlay.ts:1703`), so a muted video can even end up as the capture target instead. Either way a muted example cannot demonstrate `対象外` — a correct build would fail the recipe. See `toggle-controls.md` for the full badge conditions.
- **Caption content.** Let the video play for 15-20 seconds of speech. Confirm the subtitle bar text updates with plausible Japanese text tracking the audio (not frozen or garbled). Since #50, confirm final lines land as whole sentences rather than mid-clause fragments; interim text still updating at clause granularity is expected. Most final lines end in sentence-final punctuation, but a final line with no terminal punctuation is not a failure by itself: `SentenceAssembler.emitBundle()` (`src/offscreen/sentence-assembler.ts:121`) deliberately flushes the accumulated text as-is when the 20-word cap, the 4 s dwell timer, or a stop flush fires. Judge by fragment rate over the whole clip, not by any single line. If the post text contains distinctive proper nouns, check the **offscreen document's** console for the `"post context dictionary received"` line — it is logged by `src/offscreen/index.ts:622`, so it never appears in the x.com tab's DevTools; open it from `chrome://extensions` → the extension's Details → "Inspect views: offscreen.html" with non-zero `termCount` (`src/offscreen/index.ts:611-628`) and confirm those nouns come through the Japanese subtitle verbatim.
- **Translation path.** Start a new capture and confirm `SW_TRANSLATION_STATE.path` is `plamo`, then confirm Japanese output. The options page reports 「PLaMo 3 Translate（ローカル、WebGPU）」; model size/style changes apply to the next capture.
- **Translation-quality scoring (optional, scripted).** After a `live2` run, `node bench/score-ja.mjs prepare bench/results/<live2 result.json>` builds an LLM-judge prompt and `node bench/score-ja.mjs parse bench/work/judge-output.txt` totals the verdicts; procedure in `bench/README.md` (score-ja 節). This is the only scripted measure of Japanese quality; treat the counts as observations.
- **Manual fallback on Chrome Stable.** `node bench/serve-standalone.mjs <tts|tts2>` starts only the fixture server on 8123 so the fixture page can be opened in a Chrome where `live2` cannot install the extension; steps in `bench/README.md`. Same port conflict rules as the bench.
- **Proof.** Screenshot the video with the subtitle bar visible and readable text, at a point where the bar shows `字幕ON` (not the loading percentage state). Capture a second screenshot of the `対象外` badge case on a non-target video in the same session.

## Gotchas

- A persistent CfT profile also caches a stale service worker across rebuilds — irrelevant here since this feature is verified in real Chrome, but relevant if a CfT profile is ever reused across sessions for anything adjacent.
- "It should work" is not a substitute for this manual pass — confirm this feature against a real x.com video before any completion claim.
- Muted videos and fullscreen/scroll interactions are known areas that need hands-on confirmation each time the overlay or capture logic changes — don't assume a passing bench run covers them.
- **The `powerPreference ... ignored when calling requestAdapter() on Windows` entry in the chrome://extensions error list is known noise, excluded from error-zero checks.** It originates inside onnxruntime-web's WASM bundle hitting crbug.com/369219127; the v0.4.5 Windows adapter injection did not eliminate it (verified live 2026-08-30) and it has no functional impact. Every other error-list entry still counts.
