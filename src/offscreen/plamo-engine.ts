import { absoluteNow, type LatencyTrace } from "../shared/latency-trace";
import { isPlamoWorkerOutputMessage, type PlamoDiagnostic, type PlamoStage, type PlamoCompletionMetrics, type PlamoWorkerInputMessage, type PlamoWorkerOutputMessage, type TranslationPath } from "../shared/messages";
import type { PlamoModel } from "../shared/plamo-models";
import type { Settings } from "../shared/settings";
import { LANGUAGE_MODEL_PROMPT_TIMEOUT_MS } from "../shared/translation-timing";
import { buildPfml3Prompt, type Pfml3Pair } from "./pfml3";
import { selectPlamoGlossary } from "./plamo-glossary";
import {
  MAX_PENDING_TRANSLATIONS, TRANSLATION_DEADLINE_MS, TRANSLATION_DRAIN_TIMEOUT_MS,
  type TranslationEngineContract, type TranslationEngineOptions,
  type TranslationQueueEntry, type TranslationEnqueueOptions,
} from "./translate";

export class PlamoHostError extends Error {
  constructor(message: string, readonly fatal: boolean) { super(message); }
}

export interface PlamoHost {
  initialize(model: PlamoModel, log: (message: string, data?: PlamoDiagnostic) => void): Promise<void>;
  translate(model: PlamoModel, prompt: string, current: () => boolean, observeStage?: (stage: PlamoStage) => void): Promise<string | ({ text: string } & PlamoCompletionMetrics)>;
}

export class WorkerPlamoHost implements PlamoHost {
  private worker: Worker | null = null;
  private disposed = false;
  private model: PlamoModel | null = null;
  private serial: Promise<unknown> = Promise.resolve();
  private nextId = 0;
  private observeStage: ((stage: PlamoStage) => void) | undefined;
  private lastStage: PlamoStage | undefined;
  private pending: { id?: number; resolve(message: PlamoWorkerOutputMessage): void; reject(error: Error): void } | null = null;
  private log: (message: string, data?: PlamoDiagnostic) => void = () => undefined;

  private schedule<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation);
    this.serial = result.catch(() => undefined);
    return result;
  }

  initialize(model: PlamoModel, log: (message: string, data?: PlamoDiagnostic) => void): Promise<void> {
    return this.schedule(() => { this.log = log; return this.load(model); });
  }

  translate(model: PlamoModel, prompt: string, current: () => boolean, observeStage?: (stage: PlamoStage) => void): Promise<{ text: string } & PlamoCompletionMetrics> {
    return this.schedule(async () => {
      if (!current()) throw new DOMException("Translation cancelled", "AbortError");
      await this.load(model);
      if (this.disposed || !current()) throw new DOMException("Translation cancelled", "AbortError");
      this.observeStage = observeStage;
      try {
        const result = await this.send({ t: "PLAMO_TRANSLATE", id: this.nextId++, prompt });
        if (result.t !== "PLAMO_RESULT") throw new PlamoHostError("Unexpected PLaMo reply", true);
        return result;
      } finally { this.observeStage = undefined; }
    });
  }

  private async load(model: PlamoModel): Promise<void> {
    if (this.disposed) throw new PlamoHostError("PLaMo host is disposed", true);
    if (this.model === model) return;
    if (this.worker === null) {
      const worker = new Worker(new URL("../worker/plamo.worker.ts", import.meta.url), { type: "module" });
      this.worker = worker;
      worker.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (this.worker !== worker || !isPlamoWorkerOutputMessage(event.data)) return;
        const message = event.data;
        if (message.t === "PLAMO_STAGE") {
          if (message.record.id === this.pending?.id) {
            this.lastStage = message.record;
            this.observeStage?.(message.record);
          }
          this.log(`PLaMo ${message.record.stage}`, { stageRecord: message.record });
          return;
        }
        if (message.t === "PLAMO_PROGRESS") {
          this.log(`PLaMo ${message.phase === "hash" ? "sha256" : "download"}: ${message.loaded}/${message.total} bytes`);
          return;
        }
        if (message.t === "PLAMO_READY") {
          this.model = message.model;
          this.log(`PLaMo ready: ${message.model}, load ${Math.round(message.loadMs)} ms${message.layersOffloaded === undefined ? "" : `, offloaded layers ${message.layersOffloaded}`}`);
        }
        const pending = this.pending;
        this.pending = null;
        if (message.t === "PLAMO_ERROR") {
          if (message.fatal) this.model = null;
          pending?.reject(new PlamoHostError(message.message, message.fatal));
        } else {
          pending?.resolve(message);
        }
      });
      worker.addEventListener("error", event => {
        if (this.worker === worker) this.stopWorker(new PlamoHostError(event.message, true));
      });
    }
    const result = await this.send({ t: "PLAMO_INIT", model });
    if (result.t !== "PLAMO_READY") throw new PlamoHostError("Unexpected PLaMo initialization reply", true);
  }

  dispose(): void {
    this.disposed = true;
    this.stopWorker(new PlamoHostError("PLaMo check stopped", false));
  }

  private stopWorker(error: PlamoHostError): void {
    this.worker?.terminate();
    this.worker = null;
    this.model = null;
    const pending = this.pending;
    this.pending = null;
    pending?.reject(error);
  }

  private send(message: PlamoWorkerInputMessage): Promise<PlamoWorkerOutputMessage> {
    return new Promise((resolve, reject) => {
      const model = this.model;
      const started = performance.now();
      const timer = message.t === "PLAMO_TRANSLATE" ? setTimeout(() => {
        this.log(`PLaMo generation timed out after ${Math.round(performance.now() - started)} ms; prompt length ${message.prompt.length} characters`);
        this.log("PLaMo timeout stage", {
          ...(this.lastStage ? { stageRecord: this.lastStage } : {}),
          elapsedMs: performance.now() - started,
        });
        this.stopWorker(new PlamoHostError("PLaMo generation timed out", false));
        void this.schedule(async () => {
          if (!this.disposed && this.worker === null && model !== null) await this.load(model);
        }).catch(error => this.log(`PLaMo reload failed: ${String(error)}`));
      }, LANGUAGE_MODEL_PROMPT_TIMEOUT_MS) : undefined;
      this.pending = {
        id: message.t === "PLAMO_TRANSLATE" ? message.id : undefined,
        resolve: result => { clearTimeout(timer); resolve(result); },
        reject: error => { clearTimeout(timer); reject(error); },
      };
      if (message.t === "PLAMO_TRANSLATE") this.lastStage = undefined;
      try {
        this.worker!.postMessage(message);
      } catch (error) {
        this.stopWorker(new PlamoHostError(String(error), true));
      }
    });
  }
}

let sharedHost: PlamoHost | undefined;
function getSharedHost(): PlamoHost { return sharedHost ??= new WorkerPlamoHost(); }

type Entry = TranslationQueueEntry & { deadlineAt: number; enqueuedAt: number; modelCallStartedAt: number | null; path: TranslationPath; trace: LatencyTrace; metrics?: PlamoCompletionMetrics };

export class PlamoTranslationEngine implements TranslationEngineContract {
  private readonly host: PlamoHost;
  private readonly queue: Entry[] = [];
  private readonly terminal = new Set<number>();
  private readonly history: Pfml3Pair[] = [];
  private readonly drainWaiters = new Set<() => void>();
  private path: TranslationPath | null = null;
  private initialization: Promise<void> | null = null;
  private contextTerms: readonly string[] | null = null;
  private active: Entry | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(private readonly options: TranslationEngineOptions & {
    model: PlamoModel; style: Settings["plamoStyle"]; host?: PlamoHost;
  }) { this.host = options.host ?? getSharedHost(); }

  initialize(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    return this.initialization ??= this.host.initialize(this.options.model, (message, data) => {
      if (!this.destroyed) this.log(message, data);
    }).then(() => {
      if (!this.destroyed) this.setPath("plamo");
    }).catch(error => { if (!this.destroyed) this.fail(error); });
  }

  setContextReady(terms: readonly string[]): void {
    if (this.destroyed || this.contextTerms !== null) return;
    this.contextTerms = [...terms];
    const at = absoluteNow();
    for (const entry of this.queue) { entry.trace.contextReadyAtMs = at; this.trace(entry); }
    this.runQueue();
  }

  enqueue(line: TranslationQueueEntry, options: TranslationEnqueueOptions = {}): void {
    if (this.destroyed || !line.final || !line.text.trim() || this.terminal.has(line.id)
      || this.active?.id === line.id || this.queue.some(entry => entry.id === line.id)) return;
    const now = performance.now();
    const entry: Entry = { ...line, enqueuedAt: now, deadlineAt: now + TRANSLATION_DEADLINE_MS, modelCallStartedAt: null, path: "none", trace: { clauseId: line.clauseIds?.[0] ?? `${this.options.requestId}:clause:${line.id}`, enqueuedAtMs: absoluteNow(), ...(this.contextTerms === null ? {} : { contextReadyAtMs: absoluteNow() }) } };
    this.trace(entry);
    if (this.path === "none" && !line.skipTranslation) { this.settle(entry); return; }
    const capacity = MAX_PENDING_TRANSLATIONS - (this.active === null ? 0 : 1);
    if (!options.stopFlush && this.queue.length >= Math.max(1, capacity)) {
      const dropped = this.queue.shift();
      if (dropped) {
        this.settle(dropped, false, "queue-drop");
        void this.options.onDevLog?.({ t: "OFF_DEV_LOG", level: "info", tag: "translate", message: "dropped oldest pending committed clause",
          data: { requestId: this.options.requestId ?? "", kind: "queue-drop", lineId: dropped.id, text: dropped.text } });
      }
    }
    this.queue.push(entry);
    this.runQueue();
  }

  getPath(): TranslationPath | null { return this.path; }

  async drain(): Promise<boolean> {
    if (this.destroyed) return false;
    if (this.active === null && !this.queue.length) return true;
    return new Promise(resolve => {
      const timer = setTimeout(() => { resolve(false); this.destroy(); }, TRANSLATION_DRAIN_TIMEOUT_MS);
      this.drainWaiters.add(() => { clearTimeout(timer); resolve(true); });
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.active) this.settle(this.active);
    for (const entry of this.queue.splice(0)) this.settle(entry);
    this.active = null;
    this.history.length = 0;
    this.path = null;
    this.resolveDrain();
  }

  private setPath(path: TranslationPath): void {
    this.path = path;
    this.options.onPathChanged(path);
    if (path === "none") {
      const pending = this.queue.splice(0);
      for (const entry of pending) {
        if (entry.skipTranslation) this.queue.push(entry);
        else this.settle(entry);
      }
    }
    this.runQueue();
    this.resolveDrain();
  }

  private fail(error: unknown): void {
    this.log(`PLaMo unavailable: ${String(error)}`);
    this.setPath("none");
    if (this.active && !this.active.skipTranslation) this.finish(this.active);
  }

  private runQueue(): void {
    if (this.destroyed || this.active !== null || this.contextTerms === null) return;
    const entry = this.queue.shift();
    if (!entry) { this.resolveDrain(); return; }
    this.active = entry;
    this.timer = setTimeout(() => this.finish(entry, undefined, true), Math.max(0, entry.deadlineAt - performance.now()));
    void this.process(entry);
  }

  private current(entry: Entry): boolean {
    return !this.destroyed && this.active === entry && !this.terminal.has(entry.id) && performance.now() < entry.deadlineAt;
  }

  private async process(entry: Entry): Promise<void> {
    try {
      if (!entry.skipTranslation) await this.initialize();
      if (!this.current(entry)) return;
      if (entry.skipTranslation) { this.finish(entry, entry.text); return; }
      if (this.path === "none") { this.finish(entry); return; }
      const prompt = buildPfml3Prompt({
        source: entry.text, targetLang: this.options.style === "easy" ? "ja-easy" : "ja",
        history: this.history,
        glossary: selectPlamoGlossary(entry.text, this.contextTerms ?? []),
      });
      entry.path = "plamo";
      entry.modelCallStartedAt = performance.now();
      const result = await this.host.translate(this.options.model, prompt, () => this.current(entry) && this.path === "plamo", stage => {
        if (stage.stage === "completion-start") entry.trace.plamoStartAtMs = stage.atMs;
        if (stage.stage === "completion-end") entry.trace.plamoEndAtMs = stage.atMs;
        this.trace(entry);
      });
      entry.trace.plamoEndAtMs ??= absoluteNow();
      const text = typeof result === "string" ? result : result.text;
      if (typeof result !== "string") {
        const { finish_reason, usage, timings, workerWallMs } = result;
        entry.metrics = { finish_reason, usage, timings, workerWallMs };
      }
      if (this.current(entry)) this.finish(entry, text || undefined);
    } catch (error) {
      if (this.destroyed) return;
      if (error instanceof PlamoHostError && error.fatal) this.fail(error);
      if (!this.current(entry)) return;
      this.log(`PLaMo translation failed: ${String(error)}`);
      this.finish(entry);
    }
  }

  private finish(entry: Entry, text?: string, expired = false): void {
    if (this.active !== entry || this.terminal.has(entry.id)) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    try {
      if (text === undefined) this.settle(entry, expired);
      else {
        this.markTerminal(entry, "translated", false);
        if (!entry.skipTranslation) {
          this.history.push({ source: entry.text, target: text });
          if (this.history.length > 4) this.history.shift();
        }
        this.options.onTranslated(entry, text, entry.skipTranslation ? "passthrough" : "plamo");
      }
    } finally {
      this.active = null;
      this.runQueue();
      this.resolveDrain();
    }
  }

  private markTerminal(entry: Entry, outcome: "translated" | "fallback", expired: boolean): void {
    entry.trace.settledAtMs = absoluteNow();
    entry.trace.disposition ??= outcome === "translated" && !entry.skipTranslation ? "translated" : "untranslated";
    this.trace(entry);
    this.terminal.add(entry.id);
    if (this.options.requestId && this.options.onDevLog) {
      void this.options.onDevLog({ t: "OFF_DEV_LOG", level: "info", tag: "translate",
        message: "translation clause reached terminal state", data: {
          requestId: this.options.requestId, kind: "clause-timing", lineId: entry.id,
          path: entry.path, outcome, enqueueToTerminalMs: Math.round(performance.now() - entry.enqueuedAt),
          modelCallMs: entry.modelCallStartedAt === null ? 0 : Math.round(performance.now() - entry.modelCallStartedAt), deadlineExpired: expired,
          ...entry.metrics,
        } });
    }
  }

  private settle(entry: Entry, expired = false, disposition: "untranslated" | "queue-drop" = "untranslated"): void {
    if (this.terminal.has(entry.id)) return;
    entry.trace.disposition = disposition;
    this.markTerminal(entry, "fallback", expired);
    this.options.onSettled?.([entry.id]);
  }

  private trace(entry: Entry): void {
    void this.options.onDevLog?.({ t: "OFF_DEV_LOG", level: "info", tag: "latency", message: "clause latency",
      data: { kind: "latency", requestId: this.options.requestId ?? "", lineId: entry.id, trace: { ...entry.trace } } });
  }

  private log(message: string, data?: PlamoDiagnostic): void {
    void this.options.onDevLog?.({ t: "OFF_DEV_LOG", level: "info", tag: "translate", message,
      ...(data ? { data: { ...data, kind: "plamo-stage", requestId: this.options.requestId ?? "", lineId: this.active?.id ?? 0 } } : {}),
    });
  }

  private resolveDrain(): void {
    if (this.active !== null || this.queue.length) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }
}
