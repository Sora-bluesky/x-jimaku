import { afterEach, expect, it, vi } from "vitest";
import { AudioCapture } from "./audio-capture";
import { WhisperSegmenter } from "./segmenter";
import { SentenceAssembler } from "./sentence-assembler";
import { TerminalLedger } from "./terminal-ledger";
import { createRecognitionRelays } from "../background/caption-replay";
import { absoluteNow, type LatencyTrace } from "../shared/latency-trace";
import { isM1Message, type OffRecognitionMessage } from "../shared/messages";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each(["trailing-silence", "maximum-length", "end-of-stream"])("traces PCM through %s and sentence assembly without changing waits", async reason => {
  vi.useFakeTimers();
  vi.stubGlobal("self", globalThis);
  const audio = new AudioCapture();
  await audio.start("capture", { onLevel() {} });
  const started = absoluteNow();
  const seconds = reason === "maximum-length" ? 8 : 1;
  await vi.advanceTimersByTimeAsync(seconds * 1000);
  audio.acceptPcm("capture", new Float32Array(seconds * 16000).fill(0.1));
  if (reason === "trailing-silence") {
    await vi.advanceTimersByTimeAsync(500);
    audio.acceptPcm("capture", new Float32Array(8000));
  }
  const closed = absoluteNow();
  const requests: { requestId: string }[] = [];
  class WorkerStub extends EventTarget {
    postMessage(message: { requestId: string }) { requests.push(message); }
  }
  const worker = new WorkerStub();
  const traces: LatencyTrace[] = [];
  const assembled = vi.fn();
  const assembler = new SentenceAssembler({ onLine: assembled });
  const segmenter = new WhisperSegmenter({
    worker: worker as unknown as Worker, tracePrefix: "capture", onTrace: trace => traces.push(trace),
    getWriteOffset: () => audio.getWriteOffset(), getCapacitySamples: () => audio.getCapacitySamples(),
    copySamples: (from, to) => audio.copySamples(from, to), getEnergyHistory: () => audio.getEnergyHistory(),
    onLine: line => assembler.accept("capture", line), onFlushCompleted: () => assembler.flush("capture"), onError: vi.fn(),
  });
  segmenter.start();
  if (reason === "end-of-stream") segmenter.flushPendingAudio();
  await vi.advanceTimersByTimeAsync(200);
  const finalAt = absoluteNow();
  worker.dispatchEvent(new MessageEvent("message", { data: { t: "WHISPER_RESULT", requestId: requests[0].requestId,
    text: "This is a complete spoken sentence.", finalizedAtMs: finalAt } }));
  expect(assembled).toHaveBeenCalled();
  const line = assembled.mock.calls[0][1];
  expect(line).toMatchObject({ segmentIds: ["capture:segment:0"], whisperFinalAtMs: finalAt });
  expect(traces.at(-1)).toMatchObject({ segmentId: "capture:segment:0", speechStartAtMs: started,
    segmentClosedAtMs: closed, whisperFinalAtMs: finalAt });
  expect(traces.some(trace => trace.closeReason?.startsWith(reason))).toBe(true);
  for (const trace of traces) expect(isM1Message({ t: "OFF_DEV_LOG", level: "info", tag: "latency", message: "trace",
    data: { kind: "latency", requestId: "capture", lineId: 0, trace } })).toBe(true);
  segmenter.stop(); assembler.destroy();
});

it("keeps every source segment when sentence assembly merges recognition lines", () => {
  vi.useFakeTimers();
  const onLine = vi.fn();
  const assembler = new SentenceAssembler({ onLine });
  assembler.accept("capture", { id: 1, text: "This clause has", final: true, at: "a", segmentIds: ["s1"], whisperFinalAtMs: 1000 });
  assembler.accept("capture", { id: 2, text: "another clause.", final: true, at: "b", segmentIds: ["s1", "s2"], whisperFinalAtMs: 2000 });
  expect(onLine.mock.calls[0][1]).toMatchObject({ id: 2, segmentIds: ["s1", "s2"], whisperFinalAtMs: 2000 });
  assembler.destroy();
});

it.each([true, false])("keeps the clause identity through terminal settlement and both background relays: %s", translated => {
  const released: OffRecognitionMessage[] = [];
  const ledger = new TerminalLedger("capture", line => released.push(line));
  ledger.register({ id: 1, text: "source", final: true, at: "time", clauseIds: ["capture:clause:1"] });
  if (translated) ledger.translated(1, "日本語", "plamo");
  else ledger.fallback([1]);
  expect(released[0].clauseIds).toEqual(["capture:clause:1"]);
  const relay = createRecognitionRelays(released[0]);
  expect(relay.caption.clauseIds).toEqual(["capture:clause:1"]);
  expect(relay.recognition.clauseIds).toEqual(["capture:clause:1"]);
});
