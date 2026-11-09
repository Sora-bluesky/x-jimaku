import { describe, expect, it } from "vitest";
import { captionDwell, joinLatency, readingSpeed } from "./latency.mjs";
import { cueDwellMs } from "../src/content/cue-dwell.ts";

it("uses the same character count for dwell policy and reading speed", () => {
  const lines = ["字 😀 e\u0301", "字幕"];
  const measured = captionDwell([{ line0: lines[0], line1: lines[1], displayStartAtMs: 0, displayEndAtMs: 1000 }]);
  expect(cueDwellMs(lines, false, { dwellRate: 1, dwellFloorMs: 0, dwellAccelRate: 0, dwellAccelFloorMs: 1000 }))
    .toBe(measured.pages[0].characters * 1000);
});

const event = trace => ({ data: { kind: "latency", trace } });
const segment = (id, start = 1000, end = 2000) => event({ segmentId: id,
  speechStartAtMs: start, segmentClosedAtMs: end, closeReason: "trailing-silence", whisperFinalAtMs: end + 200 });
const clause = (id, ids, final = 2200) => event({ clauseId: id, segmentIds: ids,
  finalizedAtMs: final, whisperFinalAtMs: final, enqueuedAtMs: final + 100,
  contextReadyAtMs: final + 200, plamoStartAtMs: final + 300, plamoEndAtMs: final + 500, disposition: "translated" });
const page = (ids, start = 3000, end = 5000) => ({ cueId: "cue", pageId: "0",
  sources: [{ id: 1, clauseIds: ids }], line0: "日本語", line1: "字幕",
  displayStartAtMs: start, displayEndAtMs: end, fallback: false });

describe("utterance latency", () => {
  it("joins incremental events, merged segments and split pages on an absolute clock", () => {
    const result = joinLatency({ replayStartedAtMs: 500, devLog: [segment("s1"), segment("s2", 2000, 2500),
      clause("c1", ["s1", "s2"], 2700), event({ clauseId: "c1", contextReadyAtMs: 3000 })],
    pages: [page(["c1"], 3400, 4000), { ...page(["c1"], 4100, 6000), pageId: "1" }] });
    expect(result.utterances).toHaveLength(1);
    expect(result.utterances[0]).toMatchObject({ segmentIds: ["s1", "s2"], displayStartAtMs: 3400,
      displayEndAtMs: 6000, gapsMs: { speechToClose: 1500, closeToWhisper: 200, whisperToEnqueue: 100,
        enqueueToContext: 200, contextToPlamo: 0, plamo: 200, plamoToDisplay: 200, closeToDisplay: 900 } });
    expect(result.summary.closeToDisplay).toMatchObject({ p50: 900, p90: 900 });
  });

  it("keeps split clauses and pages listing multiple clauses without duplicating records", () => {
    const result = joinLatency({ replayStartedAtMs: 0,
      devLog: [segment("s"), clause("a", ["s"]), clause("b", ["s"])], pages: [page(["a", "b"])] });
    expect(result.utterances.map(row => row.clauseId)).toEqual(["a", "b"]);
    expect(result.utterances.every(row => row.pages[0].clauseIds.length === 2)).toBe(true);
  });

  it("counts dropped, untranslated, never shown and unassembled audio separately", () => {
    const result = joinLatency({ replayStartedAtMs: 1000,
      devLog: [segment("orphan"), segment("s"), clause("drop", ["s"]), clause("plain", ["s"]), clause("lost", ["s"]),
        event({ clauseId: "drop", disposition: "queue-drop", settledAtMs: 2900 }),
        event({ clauseId: "plain", disposition: "untranslated", settledAtMs: 2900 }),
        clause("old", ["s"], 1000)],
      pages: [{ ...page(["plain"]), fallback: true, line0: "English", line1: "" }] });
    expect(result.summary).toMatchObject({ utterances: 4, excluded: 1,
      missing: { dropped: 1, untranslated: 1, neverShown: 2, closeToDisplay: 4 }, closeToDisplay: { samples: 0 } });
    expect(result.utterances.find(row => row.segmentId === "orphan").segments[0].closeReason).toBe("trailing-silence");
  });

  it("uses finalization for the gate window even when the display is later", () => {
    const result = joinLatency({ replayStartedAtMs: 2500,
      devLog: [segment("s"), clause("old", ["s"], 2400), clause("new", ["s"], 2600)],
      pages: [page(["old"], 9000), page(["new"], 10000)] });
    expect(result.summary.closeToDisplay).toMatchObject({ samples: 1, p50: 8000 });
  });

  it("handles no samples, missing segment evidence, and streaming display before closure", () => {
    expect(joinLatency({ replayStartedAtMs: 0 }).summary.closeToDisplay).toMatchObject({ samples: 0, p50: null, p90: null });
    const missing = joinLatency({ replayStartedAtMs: 0, devLog: [clause("c", ["unknown"])], pages: [page(["c"])] });
    expect(missing.summary.missing.closeToDisplay).toBe(1);
    const early = joinLatency({ replayStartedAtMs: 0, devLog: [segment("s"), clause("c", ["s"])], pages: [page(["c"], 1900)] });
    expect(early.summary.closeToDisplay.p50).toBe(-100);
    expect(joinLatency({ devLog: [event({ clauseId: "missing" })], replayStartedAtMs: 0 }).summary.missing.captureTime).toBe(1);
  });

  it("retains diagnostic percentiles without acceptance verdicts", () => {
    const devLog = [segment("s", 500, 1000)];
    const pages = [];
    for (let index = 0; index < 10; index++) {
      devLog.push(clause(`c${index}`, ["s"]));
      pages.push(page([`c${index}`], 1000 + (index < 9 ? 3000 : 5000)));
    }
    expect(joinLatency({ devLog, pages, replayStartedAtMs: 0 }).summary.closeToDisplay)
      .toMatchObject({ samples: 10, p50: 3000, p90: 5000 });
    expect(joinLatency({ devLog, pages, replayStartedAtMs: 0 }).summary.closeToDisplay).not.toHaveProperty("pass");
  });
});

describe("page dwell and reading speed", () => {
  it("uses code points, physical lines, and actual page closure timestamps", () => {
    const dwell = captionDwell([{ ...page([], 1000, 3000), line0: "日本😀", line1: "字幕" },
      { ...page([]), displayStartAtMs: undefined, displayEndAtMs: undefined,
        appearedAt: "2026-11-09T00:00:00Z", replacedAt: "2026-11-09T00:00:01Z" }]);
    expect(dwell.closedPages).toBe(2);
    expect(dwell.pages[0]).toMatchObject({ shownSeconds: 2, characters: 5, charsPerSecond: 2.5, lines: 2, maxCharactersPerLine: 3 });
    expect(dwell.dwellMsP50).toBe(2000);
  });

  it("excludes open, zero duration, reversed and invalid times without inventing a close", () => {
    const dwell = captionDwell([page([], 3000, 3000), page([], 3000, 2000),
      { ...page([]), displayEndAtMs: undefined, replacedAt: null },
      { ...page([]), displayStartAtMs: NaN }]);
    expect(dwell).toMatchObject({ closedPages: 0, openPages: 1, dwellMsP50: null });
    expect(readingSpeed(dwell.pages)).toMatchObject({ above7: { pageShare: null, shownTimeShare: null } });
  });

  it("weights time shares by dwell, page shares by count, with strict threshold comparisons", () => {
    const result = readingSpeed([
      { shownSeconds: 1, charsPerSecond: 8 }, { shownSeconds: 3, charsPerSecond: 7 },
      { shownSeconds: 4, charsPerSecond: 4 }, { shownSeconds: 2, charsPerSecond: 2 },
    ]);
    expect(result).toEqual({ pages: 4, shownSeconds: 10,
      above7: { pages: 1, shownSeconds: 1, pageShare: 0.25, shownTimeShare: 0.1 },
      above4: { pages: 2, shownSeconds: 4, pageShare: 0.5, shownTimeShare: 0.4 } });
  });
});
