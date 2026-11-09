import { expect, it } from "vitest";
import { isM1Message } from "./messages";

const log = { t: "OFF_DEV_LOG", level: "info", tag: "translate", message: "diagnostic" };
const identity = { requestId: "capture", lineId: 1 };

it("rejects the retired passthrough log kind while preserving the translation rung", () => {
  expect(isM1Message({ ...log, data: { ...identity, kind: "passthrough", text: "source" } })).toBe(false);
  expect(isM1Message({ t: "OFF_RECOG", id: 1, text: "source", final: true,
    at: "2026-11-09T00:00:00Z", rung: "passthrough" })).toBe(true);
});

it.each([
  { kind: "queue-drop", text: "source" },
  { kind: "clause-timing", path: "plamo", outcome: "translated", enqueueToTerminalMs: 50, modelCallMs: 40, deadlineExpired: false },
  { kind: "latency", trace: { clauseId: "capture:1", enqueuedAtMs: 100 } },
  { kind: "plamo-stage", elapsedMs: 50, workerAnswered: true },
  { kind: "asr-timing", inferenceId: "asr:1", startedAtMs: 10, endedAtMs: 20, failed: false },
])("accepts the active $kind dev-log kind", (data) => {
  expect(isM1Message({ ...log, data: { ...identity, ...data } })).toBe(true);
});

it("accepts unstructured diagnostics and rejects retired translation message values", () => {
  expect(isM1Message(log)).toBe(true);
  for (const rung of ["masked", "translator-masked", "translator-unmasked", "lm-unmasked"]) {
    expect(isM1Message({ t: "OFF_RECOG", id: 1, text: "source", final: true,
      at: "2026-11-09T00:00:00Z", rung })).toBe(false);
  }
  for (const path of ["language-model", "offscreen-translator", "content-translator"]) {
    expect(isM1Message({ t: "OFF_TRANSLATION_STATE", requestId: "capture", path })).toBe(false);
  }
});
