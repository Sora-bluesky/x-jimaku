# Toggle controls

Two entry points turn subtitles on or off for the current tab: the toolbar action icon and the `Ctrl+Shift+9` keyboard shortcut (`_execute_action` command). The tab's chip/badge state reflects loading, active, and not-applicable states.

## Sub-features

- `toggle-icon` clicks the toolbar icon (`default_title`: "日本語字幕 ON/OFF") to flip subtitles on/off for the active tab.
- `toggle-shortcut` presses `Ctrl+Shift+9` to do the same without touching the mouse.
- `toggle-loading-chip` shows `字幕 準備中…N%` while the model loads/warms up.
- `toggle-active-chip` shows `字幕ON` once ASR is running and producing captions.
- `toggle-other-badge` shows `対象外` on other videos while capture is active — only when the extension status is `loadingModel` or `running`, and only on videos that are not the capture target, not muted, and visible (`src/content/overlay.ts:1747-1783`, `refreshOtherVideos`).

## How to get to it (user POV)

- Click the extension's toolbar icon while on an `x.com`/`twitter.com` tab.
- Press `Ctrl+Shift+9` (the manifest's suggested key for `_execute_action`) while the tab has focus.

## Driving it with real Chrome

Preconditions:

- Extension loaded unpacked from a freshly built and reloaded `dist/`.
- An `x.com` or `twitter.com` tab open with at least one video present.

- **Icon toggle on.** Click the toolbar icon. The chip transitions to `字幕 準備中…N%` and then `字幕ON` on a target video within a few seconds.
- **Icon toggle off.** Click the toolbar icon again. The subtitle bar and chip disappear; ASR activity for that tab stops.
- **Shortcut toggle.** With the page focused (not an input field), press `Ctrl+Shift+9`. Same effect as the icon click — confirm both entry points reach the same on/off state.
- **Non-target badge.** With capture actively on (`準備中…N%` or `字幕ON` showing on the target video), scroll to another video that is unmuted and visible. A `対象外` badge appears on that other video. A muted or off-screen video gets no badge, and nothing appears while capture is off.
- **Proof.** Screenshot the toolbar icon state plus the on-page chip at each of the three states (`準備中…N%`, `字幕ON`, `対象外`) in one verification pass.

## Gotchas

- The keyboard shortcut is a Chrome-level command (`commands._execute_action`) — it only fires while the browser window has focus and the shortcut isn't shadowed by another extension or OS binding. If it silently does nothing, check `chrome://extensions/shortcuts` for a conflict before assuming the extension is broken.
- The loading percentage in `字幕 準備中…N%` reflects model warm-up, not page load — a fast toggle-off/toggle-on cycle can re-trigger warm-up rather than resuming instantly.
- `対象外` is NOT independent of the toggle: `refreshOtherVideos` only marks other videos while status is `loadingModel`/`running`, and skips muted or invisible videos. Trying to reproduce it with capture off, or on a muted video, fails by design — that is not a bug.
- This feature is manual-only in real Chrome; the bench harness never touches the toolbar or the manifest command, so it provides no evidence here either way.
