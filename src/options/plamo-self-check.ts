import type { PlamoHost } from "../offscreen/plamo-engine";
import { buildPfml3Prompt } from "../offscreen/pfml3";
import { PLAMO_MODELS, type PlamoModel } from "../shared/plamo-models";

export interface PlamoGpu {
  requestAdapter(): Promise<{
    info?: { vendor?: string; architecture?: string; device?: string; description?: string };
    limits: { maxBufferSize: number; maxStorageBufferBindingSize: number };
  } | null>;
}

export const PLAMO_CHECK_SENTENCES = [
  "Hello, how are you?",
  "The train arrives at nine.",
  "Please open the window.",
] as const;

export async function runPlamoSelfCheck(options: {
  model: PlamoModel;
  easy: boolean;
  gpu: PlamoGpu | undefined;
  host: PlamoHost;
  current(): boolean;
  report(label: string, value: string): void;
  progress(message: string): void;
}): Promise<void> {
  const { report, model } = options;
  report("選択モデル", `${model} / ダウンロード予定 ${PLAMO_MODELS[model].bytes.toLocaleString()} bytes（未保存の場合）`);
  report("WebGPU", options.gpu ? "利用可能" : "navigator.gpu がありません。ダウンロードせず終了します。");
  if (!options.gpu) return;
  const adapter = await options.gpu.requestAdapter();
  if (!options.current()) return;
  report("GPU アダプター", adapter ? "利用可能" : "取得できません。ダウンロードせず終了します。");
  if (!adapter) return;
  const info = adapter.info;
  report("アダプター情報", info ? JSON.stringify({ vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description }) : "取得できません");
  report("maxBufferSize", String(adapter.limits.maxBufferSize));
  report("maxStorageBufferBindingSize", String(adapter.limits.maxStorageBufferBindingSize));
  const started = performance.now();
  await options.host.initialize(model, options.progress);
  if (!options.current()) return;
  report("読込時間", `${Math.round(performance.now() - started)} ms（ダウンロード・検証を含む）`);
  for (const source of PLAMO_CHECK_SENTENCES) {
    if (!options.current()) return;
    const lineStarted = performance.now();
    const text = await options.host.translate(model, buildPfml3Prompt({
      source, targetLang: options.easy ? "ja-easy" : "ja", history: [], glossary: [],
    }), options.current);
    if (!options.current()) return;
    report(source, `${Math.round(performance.now() - lineStarted)} ms: ${text}`);
  }
}
