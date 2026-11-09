import { isPlamoModel, type PlamoModel } from "../shared/plamo-models";
import type { OffDevLogMessage } from "../shared/messages";
import { PlamoTranslationEngine } from "./plamo-engine";

type SoakRequest =
  | { t: "OFF_DEV_PLAMO_SOAK"; action: "start"; model: PlamoModel; contextTerms: string[] }
  | { t: "OFF_DEV_PLAMO_SOAK"; action: "translate"; id: number; text: string }
  | { t: "OFF_DEV_PLAMO_SOAK"; action: "stop" };

export function isPlamoSoakRequest(value: unknown, sender: { id?: string; url?: string }, extensionId: string): value is SoakRequest {
  if (sender.id !== extensionId || sender.url !== `chrome-extension://${extensionId}/options.html`
    || typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  if (m.t !== "OFF_DEV_PLAMO_SOAK") return false;
  if (m.action === "stop") return true;
  if (m.action === "start") return isPlamoModel(m.model) && Array.isArray(m.contextTerms) && m.contextTerms.every(t => typeof t === "string");
  return m.action === "translate" && Number.isSafeInteger(m.id) && (m.id as number) >= 0 && typeof m.text === "string" && !!m.text.trim();
}

export class PlamoSoak {
  private engine: PlamoTranslationEngine | null = null;
  private readonly devLog: OffDevLogMessage[] = [];
  private pending: { id: number; resolve(result: { text?: string; fallback: boolean }): void } | null = null;

  async handle(message: SoakRequest): Promise<unknown> {
    if (message.action === "stop") {
      if (this.pending) throw new Error("PLaMo soak call is active");
      this.engine?.destroy();
      this.engine = null;
      return { devLog: this.devLog };
    }
    if (message.action === "start") {
      if (this.engine) throw new Error("PLaMo soak already started");
      this.devLog.length = 0;
      const engine = new PlamoTranslationEngine({ model: message.model, style: "standard", requestId: "plamo-soak",
        onPathChanged() {},
        onDevLog: entry => { this.devLog.push(entry); },
        onTranslated: (line, text) => { if (this.pending?.id === line.id) this.pending.resolve({ text, fallback: false }); },
        onSettled: ids => { if (this.pending && ids.includes(this.pending.id)) this.pending.resolve({ fallback: true }); },
      });
      this.engine = engine;
      await engine.initialize();
      if (engine.getPath() !== "plamo") {
        engine.destroy(); this.engine = null;
        throw new Error("PLaMo soak initialization failed");
      }
      engine.setContextReady(message.contextTerms);
      return { ready: true, devLog: [...this.devLog] };
    }
    if (!this.engine || this.pending) throw new Error("PLaMo soak is not ready or a call is active");
    const start = this.devLog.length;
    const startedAtMs = performance.timeOrigin + performance.now();
    try {
      const result = await new Promise<{ text?: string; fallback: boolean }>(resolve => {
        this.pending = { id: message.id, resolve };
        this.engine!.enqueue({ id: message.id, text: message.text, final: true, at: new Date(startedAtMs).toISOString() });
      });
      const endedAtMs = performance.timeOrigin + performance.now();
      const devLog = this.devLog.slice(start);
      return { ...result, id: message.id, source: message.text, startedAtMs, endedAtMs, wallMs: endedAtMs - startedAtMs,
        timeout: devLog.some(entry => entry.message.startsWith("PLaMo generation timed out")), devLog,
        stageRecords: devLog.flatMap(entry => entry.data?.stageRecord ? [entry.data.stageRecord] : []),
      };
    } finally { this.pending = null; }
  }
}
