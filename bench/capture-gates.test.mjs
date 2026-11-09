import { describe, expect, it } from "vitest";
import * as config from "./live2-config.mjs";

describe("capture-time gates", () => {
  const replayStartedAtMs = Date.parse("2026-11-09T00:00:00Z");
  const at = delta => new Date(replayStartedAtMs + delta).toISOString();
  const page = sources => ({ appearedAt: at(1000), line0: "Roman はローマ %%", line1: "English", sources });

  it("excludes mixed, boundary, missing and invalid sources even when displayed later", () => {
    expect(config.selectGatePages).toEqual(expect.any(Function));
    const kept = page([{ id: 1, finalizedAt: at(1) }, { id: 2, finalizedAt: at(2) }]);
    const pages = [kept, page([{ finalizedAt: at(-1) }, { finalizedAt: at(1) }]),
      page([{ finalizedAt: at(0) }]), page([]), page([{ finalizedAt: "invalid" }])];
    const copy = structuredClone(pages);
    const cut = config.selectGatePages({ pages, replayStartedAtMs });
    expect(cut.pages).toEqual([kept]);
    expect(cut.missing).toBe(2);
    expect(pages).toEqual(copy);
    expect(config.countQualityGates(cut.pages)).toEqual({ englishPassthrough: 1,
      wrongSenseRoma: 1, unresolvedPlaceholders: 1, romanKept: 1, romanKeptInJapanese: 1 });
  });

  it("uses all source IDs, preferring exact timestamps over legacy estimates", () => {
    const pages = [page([{ id: 1 }, { id: 2 }])];
    const lines = [{ id: 1, acceptedAt: at(500), finalizedAt: at(-1) }, { id: 2, acceptedAt: at(500) }];
    const clauseTimings = [{ data: { lineId: 2, enqueueToTerminalMs: 100 } }];
    expect(config.selectGatePages({ pages, lines, clauseTimings, replayStartedAtMs, allowLegacy: true }).pages).toEqual([]);
    delete lines[0].finalizedAt;
    const cut = config.selectGatePages({ pages, lines, clauseTimings, replayStartedAtMs, allowLegacy: true });
    expect(cut.pages).toEqual(pages);
    expect(cut.timestampSources).toEqual({ "lines.acceptedAt": 1, "lines.acceptedAt-clause.enqueueToTerminalMs": 1 });
  });

  it("reports display-time fallback and cannot silently use it in strict mode", () => {
    const pages = [page([{ id: 1 }])];
    expect(config.selectGatePages({ pages, replayStartedAtMs }).pages).toEqual([]);
    expect(config.selectGatePages({ pages, replayStartedAtMs, allowLegacy: true }).timestampSources)
      .toEqual({ "pages.appearedAt": 1 });
    expect(config.selectGatePages({ pages, replayStartedAtMs: NaN, allowLegacy: true }).pages).toEqual([]);
  });

});
