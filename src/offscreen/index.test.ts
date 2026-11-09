import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../shared/settings";
import { type PlamoWorkerOutputMessage } from "../shared/messages";

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function tick() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function offscreen() {
  const portListener = vi.fn();
  const runtimeListener = vi.fn();
  const postMessage = vi.fn();
  const sent: { t: string; model?: string }[] = [];
  const workers: WorkerStub[] = [];
  class WorkerStub extends EventTarget {
    readonly sent: { t: string; model?: string }[] = [];
    constructor() { super(); workers.push(this); }
    postMessage(message: { t: string; model?: string }) { this.sent.push(message); sent.push(message); }
    terminate() {}
    emit(data: PlamoWorkerOutputMessage) {
      this.dispatchEvent(new MessageEvent("message", { data }));
    }
  }
  vi.stubGlobal("self", new EventTarget());
  vi.stubGlobal("Worker", WorkerStub);
  // Offscreen documents expose runtime, not storage. Keep this surface narrow.
  vi.stubGlobal("chrome", {
    runtime: {
      id: "extension-id",
      getURL: (path: string) => `chrome-extension://extension-id/${path}`,
      onMessage: { addListener: runtimeListener },
      connect: () => ({
        postMessage,
        onMessage: { addListener: portListener },
        onDisconnect: { addListener() {} },
      }),
    },
  });
  await import("./index");
  return {
    sent, workers, postMessage,
    receive: portListener.mock.calls[0][0] as (message: unknown) => void,
    soak: (message: unknown, respond: (response: unknown) => void) => runtimeListener.mock.calls[0][0](
      message, { id: "extension-id", url: "chrome-extension://extension-id/options.html" }, respond,
    ),
  };
}

it("starts PLaMo and relays progress before any PCM", async () => {
  const s = await offscreen();
  s.receive({
    t: "OFF_START", requestId: "capture",
    settings: { ...DEFAULT_SETTINGS, translationBackend: "plamo" },
  });
  await tick();
  expect(s.postMessage.mock.calls.map(([message]) => message).filter(message => message.state?.status === "error")).toEqual([]);
  expect(s.sent).toContainEqual({ t: "PLAMO_INIT", model: DEFAULT_SETTINGS.plamoModel });
  expect(s.sent.some(message => message.t === "WHISPER_INIT")).toBe(true);
  const worker = s.workers.find(worker => worker.sent.some(message => message.t === "PLAMO_INIT"))!;
  worker.emit({ t: "PLAMO_PROGRESS", loaded: 1, total: 2 });
  expect(s.postMessage).toHaveBeenCalledWith(expect.objectContaining({ t: "OFF_DEV_LOG", message: "PLaMo download: 1/2 bytes" }));
  worker.emit({ t: "PLAMO_READY", model: DEFAULT_SETTINGS.plamoModel, loadMs: 0 });
  await tick();
  expect(s.postMessage).toHaveBeenCalledWith({ t: "OFF_TRANSLATION_STATE", requestId: "capture", path: "plamo" });
});

it("starts the soak through runtime only", async () => {
  const s = await offscreen();
  const respond = vi.fn();
  expect(s.soak({
    t: "OFF_DEV_PLAMO_SOAK", action: "start", model: "0.8b", contextTerms: [],
  }, respond)).toBe(true);
  await tick();
  expect(respond.mock.calls).toEqual([]);
  expect(s.sent).toEqual([{ t: "PLAMO_INIT", model: "0.8b" }]);
  s.workers[0].emit({ t: "PLAMO_READY", model: "0.8b", loadMs: 0 });
  await tick();
  expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ready: true }));
});

