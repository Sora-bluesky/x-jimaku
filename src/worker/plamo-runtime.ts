import { deletePlamoEntry, isPlamoCacheEntry, verifiedPlamoBlob, type PlamoCache, type VerificationStore } from "../shared/plamo-integrity";
import { PLAMO_CONTEXT_TOKENS, PLAMO_MODELS, plamoModelUrl, type PlamoModel } from "../shared/plamo-models";
import { stripPlamoStops } from "../offscreen/pfml3";
import type { PlamoStage, PlamoCompletionMetrics, PlamoWorkerInputMessage, PlamoWorkerOutputMessage } from "../shared/messages";

export interface PlamoWllama {
  loadModel(blobs: Blob[], options: {
    n_gpu_layers: number; n_ctx: number; n_threads: number;
  }): Promise<void>;
  getLoadedContextInfo(): object;
  createCompletion(options: {
    prompt: string; temperature: number; max_tokens: number; stop: string[];
  }): Promise<{ choices: ({ text: string } & Pick<PlamoCompletionMetrics, "finish_reason">)[] } & Pick<PlamoCompletionMetrics, "usage" | "timings">>;
  exit(): Promise<void>;
  cacheManager: PlamoCache;
}

export const PLAMO_MAX_TOKENS = 256;

export class PlamoRuntime {
  private instance: PlamoWllama | null = null;
  private model: PlamoModel | null = null;
  private pending: Promise<void> = Promise.resolve();
  private activeId: number | null = null;
  private nextActionId = 0;

  private record(stage: PlamoStage["stage"], details: Partial<PlamoStage> = {}): void {
    if (this.activeId === null) return;
    const record: PlamoStage = { id: this.activeId, stage, atMs: performance.timeOrigin + performance.now(), ...details };
    this.options.post({ t: "PLAMO_STAGE", record });
  }

  private observeProxy(instance: PlamoWllama): void {
    type Proxy = { wllamaAction(action: string, ...args: unknown[]): Promise<unknown> };
    const target = instance as unknown as { proxy: Proxy | null };
    let current = target.proxy;
    const wrap = (proxy: Proxy | null) => {
      if (!proxy) return;
      const action = proxy.wllamaAction;
      proxy.wllamaAction = async (name, ...args) => {
        const actionId = this.nextActionId++;
        this.record("proxy-sent", { action: name, actionId });
        try {
          const result = await action.call(proxy, name, ...args);
          const chunk = result as { has_more?: boolean; data_json?: string } | null;
          this.record("proxy-answered", { action: name, actionId,
            ...(typeof chunk?.has_more === "boolean" ? { hasMore: chunk.has_more } : {}),
            ...(typeof chunk?.data_json === "string" ? { responseBytes: new TextEncoder().encode(chunk.data_json).byteLength } : {}),
          });
          return result;
        } catch (error) {
          this.record("proxy-answered", { action: name, actionId, failed: true });
          throw error;
        }
      };
    };
    wrap(current);
    Object.defineProperty(target, "proxy", {
      configurable: true, enumerable: true,
      get: () => current,
      set: (proxy: Proxy | null) => { current = proxy; wrap(proxy); },
    });
  }

  constructor(private readonly options: {
    createWllama(): PlamoWllama;
    records: VerificationStore;
    withCacheLock<T>(operation: () => Promise<T>): Promise<T>;
    hasWebGpu(): Promise<boolean>;
    post(message: PlamoWorkerOutputMessage): void;
  }) {}

  handle(message: PlamoWorkerInputMessage): Promise<void> {
    if (message.t === "PLAMO_TRANSLATE") {
      const record: PlamoStage = { id: message.id, stage: "received", atMs: performance.timeOrigin + performance.now() };
      this.options.post({ t: "PLAMO_STAGE", record });
    }
    const operation = this.pending.then(() => this.process(message));
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  private async dispose(): Promise<void> {
    const instance = this.instance;
    this.instance = null;
    await instance?.exit();
  }

  private async load(model: PlamoModel, reportReady = true): Promise<void> {
    await this.dispose();
    if (!await this.options.hasWebGpu()) throw new Error("PLaMo requires WebGPU and an available GPU adapter; CPU fallback is disabled");
    const started = performance.now();
    const instance = this.options.createWllama();
    this.instance = instance;
    this.observeProxy(instance);
    await this.options.withCacheLock(async () => {
      const url = plamoModelUrl(model);
      const cache = instance.cacheManager;
      const name = await cache.getNameFromURL(url);
      for (const entry of await cache.list()) {
        if (entry.name !== name && isPlamoCacheEntry(entry.name)) {
          await deletePlamoEntry(cache, this.options.records, entry.name);
        }
      }
      const blob = await verifiedPlamoBlob(cache, this.options.records, url, PLAMO_MODELS[model],
        (loaded, total, phase) => this.options.post({ t: "PLAMO_PROGRESS", loaded, total, phase }));
      await instance.loadModel([blob], {
        n_gpu_layers: 99999, n_ctx: PLAMO_CONTEXT_TOKENS, n_threads: 1,
      });
    });
    const contextInfo = instance.getLoadedContextInfo();
    if ("success" in contextInfo && contextInfo.success === false) throw new Error("PLaMo model load rejected by llama.cpp");
    this.model = model;
    if (reportReady) this.options.post({ t: "PLAMO_READY", model, loadMs: performance.now() - started });
  }

  private async process(message: PlamoWorkerInputMessage): Promise<void> {
    if (message.t === "PLAMO_INIT") {
      try {
        await this.load(message.model);
      } catch (error) {
        await this.dispose();
        this.model = null;
        this.options.post({ t: "PLAMO_ERROR", fatal: true, message: String(error) });
      }
      return;
    }
    const instance = this.instance;
    const model = this.model;
    if (instance === null || model === null) {
      this.options.post({ t: "PLAMO_ERROR", id: message.id, fatal: true, message: "PLaMo is not initialized" });
      return;
    }
    this.activeId = message.id;
    try {
      const started = performance.now();
      this.record("completion-start");
      const response = await instance.createCompletion({
        prompt: message.prompt, temperature: 0,
        max_tokens: message.maxTokens ?? PLAMO_MAX_TOKENS,
        stop: ["<|plamo:tag|>", "<|plamo:bos|>"],
      });
      this.record("completion-end");
      const workerWallMs = performance.now() - started;
      this.options.post({ t: "PLAMO_RESULT", id: message.id, text: stripPlamoStops(response.choices[0]?.text ?? ""),
        finish_reason: response.choices[0]?.finish_reason, usage: response.usage, timings: response.timings, workerWallMs });
    } catch (error) {
      this.record("catch");
      this.record("recovery-start");
      try {
        await this.load(model, false);
        this.record("recovery-end");
        this.options.post({ t: "PLAMO_ERROR", id: message.id, fatal: false, recovered: true, message: String(error) });
      } catch (recoveryError) {
        this.record("recovery-end", { failed: true });
        await this.dispose();
        this.model = null;
        this.options.post({ t: "PLAMO_ERROR", id: message.id, fatal: true, message: `${String(error)}; recovery failed: ${String(recoveryError)}` });
      }
    } finally {
      this.activeId = null;
    }
  }
}
