import { afterEach, describe, expect, it, vi } from "vitest";
import { PlamoHostError, PlamoTranslationEngine, type PlamoHost } from "./plamo-engine";
import { TRANSLATION_DEADLINE_MS, TRANSLATION_DRAIN_TIMEOUT_MS } from "./translate";
import type { PlamoWorkerInputMessage, PlamoWorkerOutputMessage } from "../shared/messages";
import { LANGUAGE_MODEL_PROMPT_TIMEOUT_MS } from "../shared/translation-timing";

function setup(hostOverrides: Partial<PlamoHost> = {}, style: "standard" | "easy" = "standard") {
  const host = {
    initialize: vi.fn<PlamoHost["initialize"]>(async () => undefined),
    translate: vi.fn<PlamoHost["translate"]>(async () => "訳"),
    ...hostOverrides,
  };
  const onTranslated = vi.fn(); const onSettled = vi.fn(); const onPathChanged = vi.fn(); const onDevLog = vi.fn();
  const engine = new PlamoTranslationEngine({ model: "0.8b", style, host, requestId: "capture", onTranslated, onSettled, onPathChanged, onDevLog });
  return { engine, host, onTranslated, onSettled, onPathChanged, onDevLog };
}
const line = (id: number, text = `line ${id}`) => ({ id, text, final: true, at: "2026-11-08T00:00:00Z" });
async function tick() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("PLaMo translation engine", () => {
  it("records context hold release, worker-clock start/end and terminal outcome for the same clause", async () => {
    vi.useFakeTimers();
    const epoch = performance.timeOrigin;
    const s = setup({ translate: vi.fn(async (_model, _prompt, _current, observe) => {
      observe?.({ id: 0, stage: "completion-start", atMs: epoch + 250 });
      observe?.({ id: 0, stage: "completion-end", atMs: epoch + 750 });
      return "訳";
    }) });
    s.engine.enqueue({ ...line(1), clauseIds: ["capture:clause:1"] });
    await vi.advanceTimersByTimeAsync(200);
    s.engine.setContextReady([]);
    await tick();
    const traces = s.onDevLog.mock.calls.flatMap(([message]) => message.data?.kind === "latency" ? [message.data.trace] : []);
    expect(traces.at(-1)).toMatchObject({ clauseId: "capture:clause:1", enqueuedAtMs: epoch,
      contextReadyAtMs: epoch + 200, plamoStartAtMs: epoch + 250, plamoEndAtMs: epoch + 750, disposition: "translated" });
    s.engine.destroy();
  });

  it("records queue drops and untranslated settlement even before context is ready", async () => {
    const s = setup();
    for (let id = 1; id <= 3; id++) s.engine.enqueue(line(id));
    s.engine.destroy();
    const terminal = s.onDevLog.mock.calls.flatMap(([message]) => message.data?.trace?.disposition ? [message.data.trace] : []);
    expect(terminal).toEqual([
      expect.objectContaining({ clauseId: "capture:clause:1", disposition: "queue-drop" }),
      expect.objectContaining({ clauseId: "capture:clause:2", disposition: "untranslated" }),
      expect.objectContaining({ clauseId: "capture:clause:3", disposition: "untranslated" }),
    ]);
    expect(terminal.every(trace => trace.settledAtMs >= trace.enqueuedAtMs && trace.contextReadyAtMs === undefined)).toBe(true);
  });

  it("holds clauses until the first PCM context is ready and uses its glossary", async () => {
    const s = setup(); await s.engine.initialize();
    s.engine.enqueue(line(1, "Quasar and Roman")); await tick();
    expect(s.host.translate).not.toHaveBeenCalled();
    s.engine.setContextReady(["Quasar"]); await tick();
    expect(s.host.translate).toHaveBeenCalledWith("0.8b", expect.stringContaining("<|plamo:index|>Quasar<|plamo:item|>Quasar"), expect.any(Function), expect.any(Function));
    expect(s.host.translate).toHaveBeenCalledWith("0.8b", expect.stringContaining("<|plamo:index|>Roman<|plamo:item|>ローマン"), expect.any(Function), expect.any(Function));
    expect(s.onTranslated).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), "訳", "plamo");
    s.engine.destroy();
  });
  it("passes completion metrics from the worker into the clause log", async () => {
    const usage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 };
    const timings = { cache_n: 1, prompt_n: 12, prompt_ms: 50, prompt_per_token_ms: 4, prompt_per_second: 240, predicted_n: 3, predicted_ms: 60, predicted_per_token_ms: 20, predicted_per_second: 50 };
    class FakeWorker extends EventTarget {
      postMessage(message: PlamoWorkerInputMessage) {
        const reply = message.t === "PLAMO_INIT"
          ? { t: "PLAMO_READY", model: message.model, loadMs: 1 }
          : { t: "PLAMO_RESULT", id: message.id, text: "訳", finish_reason: "stop", usage, timings, workerWallMs: 115 };
        queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: reply })));
      }
      terminate() {}
    }
    vi.stubGlobal("Worker", FakeWorker);
    const { WorkerPlamoHost } = await import("./plamo-engine");
    const host = new WorkerPlamoHost();
    const s = setup({ initialize: host.initialize.bind(host), translate: host.translate.bind(host) });
    s.engine.setContextReady([]); s.engine.enqueue(line(1)); await tick();
    expect(s.onDevLog).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ kind: "clause-timing", finish_reason: "stop", usage, timings, workerWallMs: 115 }) }));
    s.engine.destroy(); host.dispose();
  });
  it("an empty first PCM releases the barrier and easy style targets ja-easy", async () => {
    const s = setup({}, "easy"); s.engine.enqueue(line(1)); s.engine.setContextReady([]); await tick();
    expect(s.host.translate).toHaveBeenCalledWith("0.8b", expect.stringContaining("<|plamo:val|>ja-easy<|plamo:msg|>"), expect.any(Function), expect.any(Function));
    s.engine.destroy();
  });
  it("uses FIFO, a single completion and only four successful history pairs", async () => {
    let release!: (value: string) => void;
    const translate = vi.fn<PlamoHost["translate"]>().mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue("訳");
    const s = setup({ translate }); s.engine.setContextReady([]);
    s.engine.enqueue(line(1)); s.engine.enqueue(line(2), { stopFlush: true }); await tick();
    expect(translate).toHaveBeenCalledOnce(); release("最初"); await tick();
    for (let id = 3; id <= 6; id++) { s.engine.enqueue(line(id)); await tick(); }
    const prompt = translate.mock.calls.at(-1)![1];
    expect(prompt).not.toContain("line 1");
    for (let id = 2; id <= 6; id++) expect(prompt).toContain(`line ${id}`);
    expect(s.onTranslated.mock.calls.map(call => call[0].id)).toEqual([1, 2, 3, 4, 5, 6]);
    s.engine.destroy();
  });
  it("excludes failed and passthrough lines from history and preserves passthrough rung", async () => {
    const translate = vi.fn<PlamoHost["translate"]>().mockRejectedValueOnce(new PlamoHostError("recovered", false)).mockResolvedValue("訳");
    const s = setup({ translate }); s.engine.setContextReady([]);
    s.engine.enqueue(line(1, "failed source")); await tick();
    s.engine.enqueue({ ...line(2, "日本語"), skipTranslation: true }); await tick();
    s.engine.enqueue(line(3, "next source")); await tick();
    expect(s.onSettled).toHaveBeenCalledWith([1]);
    expect(s.onTranslated).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }), "日本語", "passthrough");
    expect(translate.mock.calls[1][1]).not.toContain("failed source");
    expect(translate.mock.calls[1][1]).not.toContain("日本語");
    expect(s.engine.getPath()).toBe("plamo"); s.engine.destroy();
  });
  it("drops the oldest live backlog, while stop flush bypasses the cap", async () => {
    const s = setup({ translate: vi.fn(async () => new Promise<string>(() => undefined)) }); s.engine.setContextReady([]);
    s.engine.enqueue(line(1)); await tick();
    s.engine.enqueue(line(2)); s.engine.enqueue(line(3));
    expect(s.onSettled).toHaveBeenCalledWith([2]);
    s.engine.enqueue(line(4), { stopFlush: true }); s.engine.enqueue(line(5), { stopFlush: true });
    expect(s.onSettled).toHaveBeenCalledOnce(); s.engine.destroy();
    expect(s.onSettled.mock.calls.flatMap(call => call[0])).toEqual([2, 1, 3, 4, 5]);
  });
  it("expires stale results once, cancels only this request and lets another engine use the host", async () => {
    vi.useFakeTimers();
    let release!: (value: string) => void;
    const translate = vi.fn<PlamoHost["translate"]>().mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue("次");
    const s = setup({ translate }); s.engine.setContextReady([]); s.engine.enqueue(line(1)); await tick();
    await vi.advanceTimersByTimeAsync(TRANSLATION_DEADLINE_MS);
    expect(s.onSettled).toHaveBeenCalledExactlyOnceWith([1]);
    expect(translate.mock.calls[0][2]()).toBe(false);
    release("遅い訳"); await tick(); expect(s.onTranslated).not.toHaveBeenCalled();
    s.engine.destroy();
    const next = setup(s.host); next.engine.setContextReady([]); next.engine.enqueue(line(2)); await tick();
    expect(next.onTranslated).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }), "次", "plamo"); next.engine.destroy();
  });
  it("settles fatal initialization without translating, logs the cause, keeps passthrough", async () => {
    const s = setup({ initialize: vi.fn(async () => { throw new Error("no WebGPU adapter"); }) });
    s.engine.setContextReady([]); s.engine.enqueue(line(1)); await tick();
    expect(s.engine.getPath()).toBe("none"); expect(s.onSettled).toHaveBeenCalledWith([1]);
    expect(s.host.translate).not.toHaveBeenCalled();
    expect(s.onDevLog).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("no WebGPU adapter") }));
    s.engine.enqueue(line(2)); s.engine.enqueue({ ...line(3), skipTranslation: true }); await tick();
    expect(s.onSettled).toHaveBeenCalledWith([2]); expect(s.onTranslated).toHaveBeenCalledOnce(); s.engine.destroy();
  });
  it("settles fatal generation and all pending clauses", async () => {
    const s = setup({ translate: vi.fn(async () => { throw new PlamoHostError("reload failed", true); }) });
    s.engine.setContextReady([]); s.engine.enqueue(line(1)); s.engine.enqueue(line(2), { stopFlush: true }); await tick();
    expect(s.engine.getPath()).toBe("none");
    expect(s.onSettled.mock.calls.flatMap(call => call[0]).sort()).toEqual([1, 2]); s.engine.destroy();
  });
  it("makes a late fatal reply disable pending work after the earlier clause expired", async () => {
    vi.useFakeTimers();
    let reject!: (reason: Error) => void;
    let laterCurrent!: () => boolean;
    const translate = vi.fn<PlamoHost["translate"]>()
      .mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
      .mockImplementationOnce(async (_model, _prompt, current) => {
        laterCurrent = current;
        return new Promise<string>(() => undefined);
      });
    const s = setup({ translate }); s.engine.setContextReady([]); s.engine.enqueue(line(1)); await tick();
    await vi.advanceTimersByTimeAsync(TRANSLATION_DEADLINE_MS);
    s.engine.enqueue(line(2)); await tick();
    reject(new PlamoHostError("GPU recovery failed", true)); await tick();
    expect(s.engine.getPath()).toBe("none"); expect(laterCurrent()).toBe(false);
    expect(s.onSettled.mock.calls.flatMap(call => call[0])).toEqual([1, 2]);
    s.engine.enqueue(line(3)); expect(translate).toHaveBeenCalledTimes(2);
    expect(s.onSettled).toHaveBeenLastCalledWith([3]); s.engine.destroy();
  });
  it("ignores invalid and terminal lines and prevents late callbacks after destroy", async () => {
    let release!: (value: string) => void;
    const s = setup({ translate: vi.fn(() => new Promise<string>(resolve => { release = resolve; })) });
    s.engine.setContextReady([]); s.engine.enqueue({ ...line(1), final: false }); s.engine.enqueue(line(2, " "));
    s.engine.enqueue(line(3)); s.engine.enqueue(line(3)); await tick();
    s.engine.destroy(); release("遅い"); await tick();
    s.engine.enqueue(line(4)); expect(s.onTranslated).not.toHaveBeenCalled(); expect(s.onSettled).toHaveBeenCalledExactlyOnceWith([3]);
  });
  it("drains successfully or returns false on the existing drain deadline", async () => {
    vi.useFakeTimers();
    const s = setup(); s.engine.setContextReady([]); s.engine.enqueue(line(1)); const drained = s.engine.drain(); await tick();
    expect(await drained).toBe(true); s.engine.destroy(); expect(await s.engine.drain()).toBe(false);
    const blocked = setup(); blocked.engine.enqueue(line(2)); const result = blocked.engine.drain();
    await vi.advanceTimersByTimeAsync(TRANSLATION_DRAIN_TIMEOUT_MS); expect(await result).toBe(false);
    expect(blocked.onSettled).toHaveBeenCalledExactlyOnceWith([2]);
  });

  it.each([false, true])("restarts a silent worker and resumes translation (next capture: %s)", async nextCapture => {
    vi.useFakeTimers();
    vi.resetModules();
    const { PlamoTranslationEngine: Engine } = await import("./plamo-engine");
    const workers: FakeWorker[] = [];
    class FakeWorker extends EventTarget {
      readonly sent: PlamoWorkerInputMessage[] = [];
      readonly terminate = vi.fn();
      constructor() { super(); workers.push(this); }
      postMessage(message: PlamoWorkerInputMessage) {
        this.sent.push(message);
        if (message.t === "PLAMO_INIT" && workers.length === 1) {
          queueMicrotask(() => this.reply({ t: "PLAMO_READY", model: message.model, loadMs: 1 }));
        } else if (message.t === "PLAMO_TRANSLATE" && workers.length > 1) {
          queueMicrotask(() => this.reply({ t: "PLAMO_RESULT", id: message.id, text: "次の訳" }));
        }
      }
      reply(data: PlamoWorkerOutputMessage) { this.dispatchEvent(new MessageEvent("message", { data })); }
    }
    vi.stubGlobal("Worker", FakeWorker);
    const callbacks = () => ({ onTranslated: vi.fn(), onSettled: vi.fn(), onPathChanged: vi.fn(), onDevLog: vi.fn() });
    const firstCallbacks = callbacks();
    const first = new Engine({ model: "0.8b", style: "standard", ...firstCallbacks });
    await first.initialize(); first.setContextReady([]); first.enqueue(line(1)); await tick();
    await vi.advanceTimersByTimeAsync(LANGUAGE_MODEL_PROMPT_TIMEOUT_MS - 1);
    expect(workers[0].terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(workers[0].sent.map(message => message.t)).toEqual(["PLAMO_INIT", "PLAMO_TRANSLATE"]);
    expect(firstCallbacks.onDevLog).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ kind: "plamo-stage", elapsedMs: LANGUAGE_MODEL_PROMPT_TIMEOUT_MS }) }));
    expect(firstCallbacks.onSettled).toHaveBeenCalledExactlyOnceWith([1]);
    expect(firstCallbacks.onTranslated).not.toHaveBeenCalled();
    expect(firstCallbacks.onDevLog).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/PLaMo generation timed out after 10000 ms; prompt length \d+ characters/) }));
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(workers).toHaveLength(2);
    expect(workers[1].sent).toEqual([{ t: "PLAMO_INIT", model: "0.8b" }]);

    await vi.advanceTimersByTimeAsync(TRANSLATION_DEADLINE_MS - LANGUAGE_MODEL_PROMPT_TIMEOUT_MS);
    const nextCallbacks = nextCapture ? callbacks() : firstCallbacks;
    if (nextCapture) first.destroy();
    const next = nextCapture ? new Engine({ model: "0.8b", style: "standard", ...nextCallbacks }) : first;
    next.setContextReady([]); next.enqueue(line(2)); await tick();
    workers[0].reply({ t: "PLAMO_RESULT", id: 0, text: "遅い訳" });
    workers[0].reply({ t: "PLAMO_READY", model: "2b", loadMs: 1 });
    workers[0].dispatchEvent(new Event("error"));
    await tick();
    expect(workers[1].sent).toHaveLength(1);
    expect(nextCallbacks.onTranslated).not.toHaveBeenCalled();
    expect(workers[1].terminate).not.toHaveBeenCalled();
    workers[1].reply({ t: "PLAMO_READY", model: "0.8b", loadMs: 1 }); await tick();
    expect(nextCallbacks.onTranslated).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 2 }), "次の訳", "plamo");
    next.enqueue(line(3)); await tick();
    expect(nextCallbacks.onTranslated).toHaveBeenLastCalledWith(expect.objectContaining({ id: 3 }), "次の訳", "plamo");
    await vi.advanceTimersByTimeAsync(LANGUAGE_MODEL_PROMPT_TIMEOUT_MS);
    expect(workers).toHaveLength(2);
    expect(workers[1].terminate).not.toHaveBeenCalled();
    expect(firstCallbacks.onSettled).toHaveBeenCalledExactlyOnceWith([1]);
    next.destroy();
  });

  it("keeps the module host warm across captures, reloads on size change, and cancels queued ownership", async () => {
    const workers: FakeWorker[] = [];
    class FakeWorker extends EventTarget {
      readonly sent: PlamoWorkerInputMessage[] = [];
      readonly terminate = vi.fn();
      constructor(readonly url: URL) { super(); workers.push(this); }
      postMessage(message: PlamoWorkerInputMessage) {
        this.sent.push(message);
        if (message.t === "PLAMO_INIT") queueMicrotask(() => this.reply({ t: "PLAMO_READY", model: message.model, loadMs: 1 }));
      }
      reply(message: PlamoWorkerOutputMessage) { this.dispatchEvent(new MessageEvent("message", { data: message })); }
    }
    vi.stubGlobal("Worker", FakeWorker);
    const callbacks = () => ({ onTranslated: vi.fn(), onSettled: vi.fn(), onPathChanged: vi.fn() });
    const firstCallbacks = callbacks();
    const first = new PlamoTranslationEngine({ model: "0.8b", style: "standard", ...firstCallbacks });
    await first.initialize(); first.setContextReady([]); first.enqueue(line(1)); await tick();
    first.enqueue(line(2), { stopFlush: true }); first.destroy();
    const secondCallbacks = callbacks();
    const second = new PlamoTranslationEngine({ model: "0.8b", style: "standard", ...secondCallbacks });
    const initialized = second.initialize();
    workers[0].reply({ t: "PLAMO_RESULT", id: 0, text: "旧要求" }); await initialized;
    second.setContextReady([]); second.enqueue(line(3)); await tick();
    expect(workers).toHaveLength(1);
    expect(workers[0].sent.map(message => message.t)).toEqual(["PLAMO_INIT", "PLAMO_TRANSLATE", "PLAMO_TRANSLATE"]);
    expect(firstCallbacks.onTranslated).not.toHaveBeenCalled();
    workers[0].reply({ t: "PLAMO_ERROR", id: 1, fatal: false, recovered: true, message: "UTF-8 recovered" }); await tick();
    expect(secondCallbacks.onSettled).toHaveBeenCalledExactlyOnceWith([3]);
    second.enqueue(line(4)); await tick();
    workers[0].reply({ t: "PLAMO_RESULT", id: 2, text: "次の訳" }); await tick();
    expect(secondCallbacks.onTranslated).toHaveBeenCalledWith(expect.objectContaining({ id: 4 }), "次の訳", "plamo");
    second.destroy();
    const third = new PlamoTranslationEngine({ model: "2b", style: "standard", ...callbacks() }); await third.initialize();
    expect(workers).toHaveLength(1);
    expect(workers[0].sent.filter(message => message.t === "PLAMO_INIT")).toEqual([
      { t: "PLAMO_INIT", model: "0.8b" }, { t: "PLAMO_INIT", model: "2b" },
    ]);
    expect(workers[0].terminate).not.toHaveBeenCalled(); third.destroy();
  });
  it.each([true, false])("logs only stages received for the timed out request (stage received: %s)", async hasStage => {
    vi.useFakeTimers();
    const { WorkerPlamoHost } = await import("./plamo-engine");
    const record = { id: 0, stage: "proxy-sent", atMs: performance.timeOrigin + performance.now(), action: "get_result", actionId: 8 };
    const log = vi.fn();
    class FakeWorker extends EventTarget {
      terminate = vi.fn();
      postMessage(message: PlamoWorkerInputMessage) {
        if (message.t === "PLAMO_INIT") queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: { t: "PLAMO_READY", model: message.model, loadMs: 1 } })));
        if (message.t === "PLAMO_TRANSLATE") {
          if (hasStage) this.dispatchEvent(new MessageEvent("message", { data: { t: "PLAMO_STAGE", record } }));
          this.dispatchEvent(new MessageEvent("message", { data: { t: "PLAMO_STAGE", record: { ...record, id: message.id + 1 } } }));
        }
      }
    }
    vi.stubGlobal("Worker", FakeWorker);
    const host = new WorkerPlamoHost();
    await host.initialize("0.8b", log);
    const call = host.translate("0.8b", "test", () => true).catch(error => error);
    let settled = false;
    void call.then(() => { settled = true; });
    await tick();
    await vi.advanceTimersByTimeAsync(LANGUAGE_MODEL_PROMPT_TIMEOUT_MS);
    expect(settled).toBe(true);
    expect(await call).toMatchObject({ message: "PLaMo generation timed out", fatal: false });
    expect(log).toHaveBeenCalledWith("PLaMo timeout stage", {
      ...(hasStage ? { stageRecord: record } : {}), elapsedMs: LANGUAGE_MODEL_PROMPT_TIMEOUT_MS,
    });
    host.dispose();
  });
  it("settles a timed out clause at the generation limit and translates the queued clause before its deadline", async () => {
    vi.useFakeTimers();
    const { WorkerPlamoHost } = await import("./plamo-engine");
    const workers: FakeWorker[] = [];
    class FakeWorker extends EventTarget {
      readonly terminate = vi.fn();
      constructor() { super(); workers.push(this); }
      postMessage(message: PlamoWorkerInputMessage) {
        const reply = (data: PlamoWorkerOutputMessage) => this.dispatchEvent(new MessageEvent("message", { data }));
        if (message.t === "PLAMO_INIT") {
          const ready = () => reply({ t: "PLAMO_READY", model: message.model, loadMs: 0 });
          if (workers.length === 1) queueMicrotask(ready);
          else setTimeout(ready, (TRANSLATION_DEADLINE_MS - LANGUAGE_MODEL_PROMPT_TIMEOUT_MS) * 0.75);
        } else if (message.t === "PLAMO_TRANSLATE" && workers.length > 1) {
          queueMicrotask(() => reply({ t: "PLAMO_RESULT", id: message.id, text: "次の訳" }));
        }
      }
    }
    vi.stubGlobal("Worker", FakeWorker);
    const host = new WorkerPlamoHost();
    const s = setup({ initialize: host.initialize.bind(host), translate: host.translate.bind(host) });
    try {
      await s.engine.initialize();
      s.engine.setContextReady([]);
      s.engine.enqueue(line(1)); await tick();
      await vi.advanceTimersByTimeAsync((TRANSLATION_DEADLINE_MS - LANGUAGE_MODEL_PROMPT_TIMEOUT_MS) / 2);
      s.engine.enqueue(line(2));
      await vi.advanceTimersByTimeAsync(LANGUAGE_MODEL_PROMPT_TIMEOUT_MS - (TRANSLATION_DEADLINE_MS - LANGUAGE_MODEL_PROMPT_TIMEOUT_MS) / 2);
      expect(s.onSettled).toHaveBeenCalledExactlyOnceWith([1]);
      expect(workers[0].terminate).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(TRANSLATION_DEADLINE_MS - LANGUAGE_MODEL_PROMPT_TIMEOUT_MS);
      expect(s.onTranslated).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 2 }), "次の訳", "plamo");
      await vi.advanceTimersByTimeAsync(TRANSLATION_DEADLINE_MS);
      expect(s.onSettled).toHaveBeenCalledExactlyOnceWith([1]);
    } finally {
      s.engine.destroy(); host.dispose();
    }
  });
  it("identifies the actual queue-drop clause in the dev log", async () => {
    const s = setup({ translate: vi.fn(() => new Promise<string>(() => undefined)) });
    s.engine.setContextReady([]);
    s.engine.enqueue(line(1)); await tick();
    s.engine.enqueue(line(2)); s.engine.enqueue(line(3));
    expect(s.onDevLog).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ kind: "queue-drop", lineId: 2, requestId: "capture" }) }));
    s.engine.destroy();
  });

});
