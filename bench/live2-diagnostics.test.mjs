import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createLive2Diagnostics, readLive2PageState } from "./live2-diagnostics.mjs";
import { createPlamoReadiness } from "./live2-config.mjs";

const source = readFileSync(new URL("./live2.mjs", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const prefix = "chrome-extension://test/";
function fixture() {
  const chip = { textContent: "字幕 準備中… 45%" };
  const window = { __devLog: [
    { tag: "translate", message: "PLaMo ready", arrivedAtMs: 1 },
    { tag: "whisper", message: "loading model", arrivedAtMs: 2 },
    { tag: "asr", message: "initializing pipeline", arrivedAtMs: 3, data: { phase: "init" } },
    { tag: "audio", message: "tap acquired", arrivedAtMs: 4 },
  ], __translationState: [{ path: "plamo", arrivedAtMs: 1 }] };
  const document = { querySelectorAll: () => [{ shadowRoot: { querySelector: () => chip } }] };
  const page = { evaluate: vi.fn(callback => Promise.resolve(runInNewContext(`(${callback.toString()})()`, { window, document }))) };
  const captureState = { status: "loadingModel", progress: 45, requestId: "request" };
  const worker = { evaluate: vi.fn(async () => captureState) };
  const workerTarget = { url: () => `${prefix}background.js`, type: () => "service_worker", worker: async () => worker };
  const session = new EventEmitter();
  session.send = vi.fn(async () => {
    session.emit("Runtime.consoleAPICalled", { type: "error", args: [{ value: "Whisper initialization error" }] });
  });
  const offscreen = { url: () => `${prefix}offscreen.html`, createCDPSession: vi.fn(async () => session) };
  const browser = new EventEmitter();
  const targets = [workerTarget, offscreen];
  browser.targets = () => targets;
  const diagnostics = { devLog: [], translationState: [] };
  return { page, browser, diagnostics, worker, captureState, session, offscreen, targets, window, chip,
    create: () => createLive2Diagnostics({ browser, extensionId: "test", page, diagnostics }) };
}

it("saves all log tags, session state, chip and offscreen errors through the actual failure catch", async () => {
  const f = fixture();
  const collector = await f.create();
  try {
    const observe = createPlamoReadiness({ timeoutMs: 120000, startedAtMs: 0 });
    const snapshot = await collector.snapshot();
    observe(snapshot, 0);
    let error;
    try { observe(snapshot, 120000); } catch (caught) { error = caught; }
    expect(error.message).toContain("capture running readiness stalled");
    const handler = source.match(/\} catch \(error\) \{\n  result\.error = String\(error\);[\s\S]*?\n\} finally \{/u);
    expect(handler).not.toBeNull();
    const result = { diagnostics: f.diagnostics };
    await runInNewContext(`(async () => { ${handler[0].slice("} catch (error) {".length, -"} finally {".length)} })()`, {
      result, error, runDiagnostics: collector, replayStartedAtMs: null, console: { error() {} },
    });
    // Round-trip as the result writer does, so undefined and timing fields matter.
    const saved = JSON.parse(JSON.stringify(result));
    expect(saved.error).toContain("capture running readiness stalled");
    expect(saved.diagnostics.devLog.map(entry => entry.tag)).toEqual(["translate", "whisper", "asr", "audio"]);
    expect(saved.diagnostics.devLog[2]).toMatchObject({ arrivedAtMs: 3, data: { phase: "init" } });
    expect(saved.diagnostics.devLog[2]).not.toHaveProperty("arrivalMs");
    expect(saved.diagnostics.captureState).toEqual(f.captureState);
    expect(saved.diagnostics.overlayChipText).toBe(f.chip.textContent);
    expect(saved.diagnostics.readiness).toMatchObject({ plamoReady: true, captureRunning: false, lastProgressAtMs: 0 });
    expect(saved.diagnostics.translationPaths).toEqual(["plamo"]);
    expect(saved.diagnostics.offscreenConsoleErrors[0].text).toBe("Whisper initialization error");
  } finally { collector.stop(); }
});

it("keeps logs and console exceptions when capture-state storage cannot be read", async () => {
  const f = fixture();
  const collector = await f.create();
  try {
    f.worker.evaluate.mockRejectedValue(new Error("storage unavailable"));
    f.session.emit("Runtime.exceptionThrown", { exceptionDetails: { text: "Uncaught", exception: { description: "Whisper failed" } } });
    await collector.saveFailure(0);
    expect(f.diagnostics.devLog).toHaveLength(4);
    expect(f.diagnostics.devLog[2].arrivalMs).toBe(3);
    expect(f.diagnostics.captureState).toBeNull();
    expect(f.diagnostics.overlayChipText).toBe(f.chip.textContent);
    expect(f.diagnostics.collectionErrors).toEqual(["m1.captureState: Error: storage unavailable"]);
    expect(f.diagnostics.offscreenConsoleErrors.at(-1).text).toBe("Whisper failed");
  } finally { collector.stop(); }
});

it("retains last state and console evidence if the fixture page becomes unreadable", async () => {
  const f = fixture();
  const collector = await f.create();
  try {
    await collector.snapshot();
    f.page.evaluate.mockRejectedValue(new Error("page closed"));
    await collector.saveFailure(null);
    expect(f.diagnostics.captureState).toEqual(f.captureState);
    expect(f.diagnostics.overlayChipText).toBe(f.chip.textContent);
    expect(f.diagnostics.collectionErrors).toEqual(["readiness snapshot: Error: page closed"]);
    expect(f.diagnostics.devLog.map(entry => entry.tag)).toEqual(["translate", "whisper", "asr", "audio"]);
    expect(f.diagnostics.offscreenConsoleErrors).toHaveLength(1);
  } finally { collector.stop(); }
});

it("attaches once when an offscreen document gets its URL after target creation", async () => {
  const f = fixture();
  f.targets.pop();
  const collector = await f.create();
  try {
    const target = { ...f.offscreen, url: () => "" };
    f.browser.emit("targetcreated", target);
    target.url = f.offscreen.url;
    f.targets.push(target);
    f.browser.emit("targetchanged", target);
    await collector.saveFailure(null);
    expect(f.offscreen.createCDPSession).toHaveBeenCalledTimes(1);
    expect(f.diagnostics.offscreenConsoleErrors).toHaveLength(1);
    expect(f.diagnostics.offscreenConsoleTargets).toEqual([`${prefix}offscreen.html`]);
  } finally { collector.stop(); }
  expect(f.browser.listenerCount("targetcreated")).toBe(0);
  expect(f.browser.listenerCount("targetchanged")).toBe(0);
});

it("records console access failures without losing the original readiness evidence", async () => {
  const f = fixture();
  f.offscreen.createCDPSession.mockRejectedValue(new Error("CDP unavailable"));
  const collector = await f.create();
  try {
    await collector.saveFailure(null);
    expect(f.diagnostics.collectionErrors).toContain("offscreen console: Error: CDP unavailable");
    expect(f.diagnostics.devLog).toHaveLength(4);
    expect(f.diagnostics.offscreenConsoleTargets).toEqual([]);
  } finally { collector.stop(); }
});

it("reads the chip and ASR initialization logs without interpreting timestamp-only traffic as progress", async () => {
  const f = fixture();
  const first = await f.page.evaluate(readLive2PageState);
  f.window.__devLog.push({ ...f.window.__devLog[2], arrivedAtMs: 99, timestampMs: 99 });
  const second = await f.page.evaluate(readLive2PageState);
  expect(first.asrProgress).toEqual(second.asrProgress);
  expect(second.path).toBe("plamo");
  expect(second.overlayChipText).toBe("字幕 準備中… 45%");
});
