# Model selection

The options page lets a user pick which ASR model (`tiny`/`base`/`small`/`turbo`) the offscreen document loads. The extension prefers WebGPU and falls back to WASM when WebGPU is unavailable.

## Sub-features

- `model-picker` selects one of `tiny`, `base`, `small`, `turbo` from a `<select>` on the options page.
- `model-webgpu` runs the chosen model on WebGPU when the runtime supports it.
- `model-wasm-fallback` falls back to WASM execution when WebGPU is unavailable, without the user needing to pick anything different.

## How to get to it (user POV)

- Right-click the extension's toolbar icon → Options, or open `chrome://extensions` → the extension's Details → Extension options.
- The model `<select>` is on the options page alongside the diagnostics and display settings (see `options-page.md`).

## Driving it with real Chrome

Preconditions:

- Extension loaded unpacked from a freshly built `dist/`.
- Options page reachable via the extension's Details page.

- **Change model.** Open the options page. Change the model `<select>` from its current value to a different one of `tiny`/`base`/`small`/`turbo`. Confirm the new selection persists after closing and reopening the options page (backed by `chrome.storage`).
- **Apply to a live tab.** With the new model selected, toggle subtitles on for an x.com video (see `toggle-controls.md`). Confirm the loading chip (`字幕 準備中…N%`) and eventual `字幕ON` reflect the newly selected model actually loading (larger models take visibly longer to reach `字幕ON`).
- **WebGPU vs WASM.** On a machine/browser with WebGPU available, confirm captions proceed without a fallback delay. On a machine/browser without WebGPU (or with it disabled via flags), confirm the extension still reaches `字幕ON` via WASM rather than failing silently.
- **Proof.** Screenshot the options page with the model `<select>` showing the chosen value, plus a screenshot of the resulting `字幕ON` state on an x.com tab using that model.

## Gotchas

- A larger model (`small`/`turbo`) takes meaningfully longer to warm up — don't mistake a long `準備中…N%` period for a hang; give it time proportional to the model size before concluding it failed.
- Forcing the WASM fallback path deliberately (to verify it) may require disabling WebGPU at the browser level (e.g. `chrome://flags`) — that is an environment change outside the extension itself; note it clearly if used, and revert it afterward.
- Model choice is per-install (options page), not per-tab — verifying "did the new model apply" means checking a newly toggled tab, not a tab that was already running under the old model.
- The bench harness (`bench-offline-e2e.md`) does exercise the model parameter (`--model tiny|base|small|turbo`) but only against the disposable Puppeteer profile — it does not prove the options-page UI persists a user's choice; that part is manual-only.
