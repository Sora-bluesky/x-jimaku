import { describe, expect, it, vi } from "vitest";
import { PlamoRuntime, type PlamoWllama } from "./plamo-runtime";
import { PLAMO_MODELS, plamoModelUrl } from "../shared/plamo-models";
import type { VerificationStore, VerifiedModel } from "../shared/plamo-integrity";
import type { PlamoWorkerOutputMessage } from "../shared/messages";

vi.mock("../shared/plamo-models", async importOriginal => {
  const original = await importOriginal<typeof import("../shared/plamo-models")>();
  const models = Object.fromEntries(Object.entries(original.PLAMO_MODELS).map(([key, value]) => [key, {
    ...value, bytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  }]));
  return { ...original, PLAMO_MODELS: models };
});

function setup() {
  const replies: PlamoWorkerOutputMessage[] = [];
  const instances: ReturnType<typeof fake>[] = [];
  const gpu = vi.fn(async () => true);
  const factory = vi.fn(() => { const instance = fake(); instances.push(instance); return instance; });
  const verified = new Map<string, VerifiedModel>();
  const records: VerificationStore = {
    read: vi.fn(async name => verified.get(name) ?? null),
    write: vi.fn(async record => { verified.set(record.name, record); }),
    delete: vi.fn(async name => { verified.delete(name); }),
    clear: vi.fn(async () => { verified.clear(); }),
  };
  const runtime = new PlamoRuntime({ createWllama: factory, records, withCacheLock: operation => operation(), hasWebGpu: gpu, post: message => replies.push(message) });
  return { runtime, replies, instances, factory, gpu, records, verified };
}

function fake() {
  return {
    loadModel: vi.fn<PlamoWllama["loadModel"]>(async () => undefined),
    getLoadedContextInfo: vi.fn(() => ({ success: true })),
    createCompletion: vi.fn<PlamoWllama["createCompletion"]>(async () => ({ choices: [{ text: " 訳\uFFFD<|plamo:tag|> " }] })),
    exit: vi.fn(async () => undefined),
    cacheManager: {
      open: vi.fn<PlamoWllama["cacheManager"]["open"]>(async () => new Blob(["abc"])),
      download: vi.fn<PlamoWllama["cacheManager"]["download"]>(async (_url, options) => { options.progressCallback({ loaded: 1, total: 2 }); }),
      getNameFromURL: vi.fn(async () => "current"), getSize: vi.fn<PlamoWllama["cacheManager"]["getSize"]>(async () => PLAMO_MODELS["0.8b"].bytes),
      list: vi.fn(async () => [
        { name: "current", size: 1, metadata: { originalURL: plamoModelUrl("0.8b") } },
        { name: "old_plamo-3-translate-2b-Q4_K_M.gguf", size: 1, metadata: { originalURL: plamoModelUrl("2b") } },
        { name: "oldrevision_plamo-3-translate-0.8b-Q4_K_M.gguf", size: 1, metadata: { originalURL: "old" } },
        { name: "whisper.onnx", size: 1, metadata: { originalURL: "other" } },
      ]), delete: vi.fn<PlamoWllama["cacheManager"]["delete"]>(async () => undefined),
    },
  };
}

describe("PLaMo runtime", () => {
  it("downloads into cache and verifies a matching streamed hash before load", async () => {
    const s = setup();
    const instance = fake();
    const blob = new Blob(["abc"]);
    const stream = vi.spyOn(blob, "stream");
    instance.cacheManager.open.mockResolvedValueOnce(null).mockResolvedValue(blob);
    instance.loadModel.mockImplementation(async ([loaded]) => {
      expect(loaded).toBe(blob);
      expect(stream).toHaveBeenCalledOnce();
      expect(s.verified.get("current")).toEqual({ name: "current", size: 3, sha256: PLAMO_MODELS["0.8b"].sha256 });
    });
    s.factory.mockReturnValueOnce(instance);
    await s.runtime.handle({ t: "PLAMO_INIT", model: "0.8b" });
    expect(instance.cacheManager.download).toHaveBeenCalledWith(plamoModelUrl("0.8b"), expect.any(Object));
    expect(s.replies).toContainEqual({ t: "PLAMO_PROGRESS", loaded: 1, total: 2, phase: "download" });
    expect(s.replies.at(-1)).toMatchObject({ t: "PLAMO_READY" });
  });
  it("deletes a mismatching hash and its record, reports fatal and never loads", async () => {
    const s = setup();
    const instance = fake();
    instance.cacheManager.open.mockResolvedValue(new Blob(["bad"]));
    s.factory.mockReturnValueOnce(instance);
    await s.runtime.handle({ t: "PLAMO_INIT", model: "0.8b" });
    expect(instance.loadModel).not.toHaveBeenCalled();
    expect(instance.cacheManager.delete).toHaveBeenCalledWith("current");
    expect(s.verified.has("current")).toBe(false);
    expect(s.replies.at(-1)).toMatchObject({ t: "PLAMO_ERROR", fatal: true, message: expect.stringContaining("hash did not match") });
  });
  it("trusts a matching record across runtime instances without hashing", async () => {
    const s = setup();
    const instance = fake();
    const blob = new Blob(["abc"]);
    const stream = vi.spyOn(blob, "stream");
    instance.cacheManager.open.mockResolvedValue(blob);
    s.verified.set("current", { name: "current", size: 3, sha256: PLAMO_MODELS["0.8b"].sha256 });
    s.factory.mockReturnValueOnce(instance);
    await s.runtime.handle({ t: "PLAMO_INIT", model: "0.8b" });
    expect(stream).not.toHaveBeenCalled();
    expect(instance.cacheManager.download).not.toHaveBeenCalled();
    expect(instance.loadModel).toHaveBeenCalledOnce();
  });
  it.each(["missing", "size", "digest", "name"])("does not trust a stale %s record", async reason => {
    const s = setup();
    const instance = fake();
    const blob = new Blob(["abc"]);
    const stream = vi.spyOn(blob, "stream");
    instance.cacheManager.open.mockResolvedValue(blob);
    if (reason === "missing") instance.cacheManager.open.mockResolvedValueOnce(null);
    if (reason === "size") instance.cacheManager.open.mockResolvedValueOnce(new Blob(["x"]));
    s.verified.set("current", { name: reason === "name" ? "another" : "current", size: 3, sha256: reason === "digest" ? "wrong" : PLAMO_MODELS["0.8b"].sha256 });
    s.factory.mockReturnValueOnce(instance);
    await s.runtime.handle({ t: "PLAMO_INIT", model: "0.8b" });
    expect(stream).toHaveBeenCalledOnce();
    if (reason === "missing" || reason === "size") expect(instance.cacheManager.download).toHaveBeenCalledOnce();
    expect(s.replies.at(-1)).toMatchObject({ t: "PLAMO_READY" });
  });
  it("requires WebGPU before creating wllama", async () => {
    const s = setup(); s.gpu.mockResolvedValue(false);
    await s.runtime.handle({ t: "PLAMO_INIT", model: "0.8b" });
    expect(s.factory).not.toHaveBeenCalled();
    expect(s.replies).toContainEqual(expect.objectContaining({ t: "PLAMO_ERROR", fatal: true, message: expect.stringContaining("WebGPU") }));
  });
  it("loads pinned URL, reports progress, validates size and removes only other PLaMo caches", async () => {
    const s = setup(); await s.runtime.handle({ t: "PLAMO_INIT", model: "0.8b" });
    expect(s.instances[0].loadModel).toHaveBeenCalledWith([expect.any(Blob)], expect.objectContaining({ n_gpu_layers: 99999, n_ctx: 4096, n_threads: 1 }));
    expect(s.instances[0].cacheManager.delete.mock.calls.flat()).toEqual(["old_plamo-3-translate-2b-Q4_K_M.gguf", "oldrevision_plamo-3-translate-0.8b-Q4_K_M.gguf"]);
    expect(s.replies).toContainEqual({ t: "PLAMO_PROGRESS", loaded: 3, total: 3, phase: "hash" });
    expect(s.replies.at(-1)).toMatchObject({ t: "PLAMO_READY", model: "0.8b" });
  });
  it.each(["throw", "rejected"])("evicts other sizes before a failed size switch (%s) and retains the selected cache for retry", async failure => {
    const s = setup(); await s.runtime.handle({ t: "PLAMO_INIT", model: "0.8b" });
    const selected = "selected_plamo-3-translate-2b-Q4_K_M.gguf";
    const previous = "previous_plamo-3-translate-0.8b-Q4_K_M.gguf";
    const oldRevision = "oldrevision_plamo-3-translate-2b-Q4_K_M.gguf";
    const cached = new Map([
      [previous, PLAMO_MODELS["0.8b"].bytes], [oldRevision, PLAMO_MODELS["2b"].bytes], ["unrelated.gguf", 1],
    ]);
    const replacement = fake();
    replacement.cacheManager.getNameFromURL.mockResolvedValue(selected);
    replacement.cacheManager.list.mockImplementation(async () => [...cached].map(([name, size]) => ({ name, size, metadata: { originalURL: "fixture" } })));
    replacement.cacheManager.delete.mockImplementation(async name => { cached.delete(name); });
    replacement.cacheManager.getSize.mockImplementation(async name => cached.get(name) ?? -1);
    replacement.cacheManager.open.mockImplementation(async name => cached.has(name) ? new Blob(["abc"]) : null);
    replacement.cacheManager.download.mockImplementation(async () => { cached.set(selected, PLAMO_MODELS["2b"].bytes); });
    replacement.loadModel.mockImplementation(async () => {
      if (failure === "throw") throw new Error("GPU load failed after download");
    });
    if (failure === "rejected") replacement.getLoadedContextInfo.mockReturnValue({ success: false });
    s.factory.mockReturnValueOnce(replacement);
    await s.runtime.handle({ t: "PLAMO_INIT", model: "2b" });
    expect(s.replies.at(-1)).toMatchObject({ t: "PLAMO_ERROR", fatal: true });
    expect(replacement.exit).toHaveBeenCalledOnce();
    expect([...cached.keys()].sort()).toEqual([selected, "unrelated.gguf"].sort());
    expect(replacement.cacheManager.delete.mock.invocationCallOrder.at(-1)).toBeLessThan(replacement.loadModel.mock.invocationCallOrder[0]);

    replacement.getLoadedContextInfo.mockReturnValue({ success: true });
    replacement.loadModel.mockImplementation(async () => { expect(cached.has(selected)).toBe(true); });
    s.factory.mockReturnValueOnce(replacement);
    await s.runtime.handle({ t: "PLAMO_INIT", model: "2b" });
    expect(s.replies.at(-1)).toMatchObject({ t: "PLAMO_READY", model: "2b" });
    expect(cached.has(selected)).toBe(true);
  });
  it.each(["rejected", "size"])("disposes failed %s loads", async failure => {
    const s = setup();
    const instance = fake();
    if (failure === "rejected") instance.getLoadedContextInfo.mockReturnValue({ success: false });
    else instance.cacheManager.open.mockResolvedValue(new Blob(["x"]));
    s.factory.mockReturnValueOnce(instance);
    await s.runtime.handle({ t: "PLAMO_INIT", model: "0.8b" });
    expect(instance.exit).toHaveBeenCalled();
    expect(s.replies.at(-1)).toMatchObject({ t: "PLAMO_ERROR", fatal: true });
    if (failure === "size") expect(instance.cacheManager.delete).toHaveBeenCalledWith("current");
  });
  it("generates greedily with stops, default bound and debug override", async () => {
    const s = setup(); await s.runtime.handle({ t: "PLAMO_INIT", model: "0.8b" });
    const usage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 };
    const timings = { cache_n: 1, prompt_n: 12, prompt_ms: 50, prompt_per_token_ms: 4, prompt_per_second: 240, predicted_n: 3, predicted_ms: 60, predicted_per_token_ms: 20, predicted_per_second: 50 };
    s.instances[0].createCompletion.mockResolvedValueOnce({ choices: [{ text: " 訳 ", finish_reason: "stop" }], usage, timings });
    await s.runtime.handle({ t: "PLAMO_TRANSLATE", id: 1, prompt: "prompt" });
    expect(s.instances[0].createCompletion).toHaveBeenLastCalledWith({ prompt: "prompt", temperature: 0, max_tokens: 256, stop: ["<|plamo:tag|>", "<|plamo:bos|>"] });
    expect(s.replies.at(-1)).toEqual({ t: "PLAMO_RESULT", id: 1, text: "訳", finish_reason: "stop", usage, timings, workerWallMs: expect.any(Number) });
    await s.runtime.handle({ t: "PLAMO_TRANSLATE", id: 2, prompt: "debug", maxTokens: 1 });
    expect(s.instances[0].createCompletion).toHaveBeenLastCalledWith(expect.objectContaining({ max_tokens: 1 }));
  });
  it("recovers the UTF-8 crash and holds later requests until reload completes", async () => {
    const s = setup(); await s.runtime.handle({ t: "PLAMO_INIT", model: "0.8b" });
    s.instances[0].createCompletion.mockRejectedValueOnce(new RangeError("Invalid typed array length: 1163217991"));
    let finish!: () => void;
    const loaded = new Promise<void>(resolve => { finish = resolve; });
    const replacement = fake(); replacement.loadModel.mockImplementation(async () => loaded);
    s.factory.mockReturnValueOnce(replacement);
    const failed = s.runtime.handle({ t: "PLAMO_TRANSLATE", id: 1, prompt: "bad" });
    const next = s.runtime.handle({ t: "PLAMO_TRANSLATE", id: 2, prompt: "good" });
    await vi.waitFor(() => expect(replacement.loadModel).toHaveBeenCalled());
    expect(replacement.createCompletion).not.toHaveBeenCalled();
    finish(); await Promise.all([failed, next]);
    expect(s.instances[0].exit).toHaveBeenCalledOnce();
    expect(s.replies.filter(m => m.t !== "PLAMO_STAGE").slice(-2)).toEqual([
      { t: "PLAMO_ERROR", id: 1, fatal: false, recovered: true, message: "RangeError: Invalid typed array length: 1163217991" },
      { t: "PLAMO_RESULT", id: 2, text: "訳", finish_reason: undefined, usage: undefined, timings: undefined, workerWallMs: expect.any(Number) },
    ]);
  });
  it("reports a fatal error when the cached reload fails and disposes both instances", async () => {
    const s = setup(); await s.runtime.handle({ t: "PLAMO_INIT", model: "0.8b" });
    s.instances[0].createCompletion.mockRejectedValueOnce(new RangeError("Invalid typed array length: 1163217991"));
    const replacement = fake(); replacement.loadModel.mockRejectedValueOnce(new Error("reload failed"));
    s.factory.mockReturnValueOnce(replacement);
    await s.runtime.handle({ t: "PLAMO_TRANSLATE", id: 1, prompt: "bad" });
    expect(s.instances[0].exit).toHaveBeenCalledOnce(); expect(replacement.exit).toHaveBeenCalledOnce();
    expect(s.replies.at(-1)).toMatchObject({ t: "PLAMO_ERROR", id: 1, fatal: true, message: expect.stringContaining("reload failed") });
  });
  it("streams the last proxy stage while its action is stalled", async () => {
    const s = setup();
    const instance = Object.assign(fake(), { proxy: null as null | { wllamaAction(action: string): Promise<unknown> } });
    let answer!: (value: unknown) => void;
    const action = vi.fn(() => new Promise(resolve => { answer = resolve; }));
    instance.loadModel.mockImplementation(async () => { instance.proxy = { wllamaAction: action }; });
    instance.createCompletion.mockImplementation(async () => {
      await instance.proxy!.wllamaAction("get_result");
      return { choices: [{ text: "訳" }] };
    });
    s.factory.mockReturnValueOnce(instance);
    await s.runtime.handle({ t: "PLAMO_INIT", model: "0.8b" });
    const call = s.runtime.handle({ t: "PLAMO_TRANSLATE", id: 4, prompt: "test" });
    await Promise.resolve();
    expect(s.replies.at(-1)).toMatchObject({ t: "PLAMO_STAGE", record: { id: 4, stage: "proxy-sent", action: "get_result" } });
    answer({ has_more: true, data_json: "" });
    await call;
    const records = s.replies.flatMap(m => m.t === "PLAMO_STAGE" ? [m.record] : []);
    expect(records.map(r => r.stage)).toEqual(["received", "completion-start", "proxy-sent", "proxy-answered", "completion-end"]);
    expect(records[3]).toMatchObject({ actionId: records[2].actionId, hasMore: true, responseBytes: 0 });
    expect(records.every(r => r.atMs >= performance.timeOrigin)).toBe(true);
  });
  it("records catch and both recovery boundaries before reporting a generation failure", async () => {
    const s = setup();
    await s.runtime.handle({ t: "PLAMO_INIT", model: "0.8b" });
    s.instances[0].createCompletion.mockRejectedValueOnce(new Error("generation failed"));
    await s.runtime.handle({ t: "PLAMO_TRANSLATE", id: 6, prompt: "test" });
    expect(s.replies.flatMap(m => m.t === "PLAMO_STAGE" ? [m.record.stage] : [])).toEqual([
      "received", "completion-start", "catch", "recovery-start", "recovery-end",
    ]);
    expect(s.replies.at(-1)).toMatchObject({ t: "PLAMO_ERROR", recovered: true });
  });

});
