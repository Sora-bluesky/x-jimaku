import {
  describe,
  expect,
  it,
} from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseArgs,
  resolveDisplayRuns,
  argvForDisplayRun,
  combineDisplayReports,
  parseChildReport,
  annotateDisplayMeta,
  finalizeGates,
  assertCaseMedia,
  countPageLineReuse,
  checkBuildInfo,
  cutCaptionLog,
} from "./live2-config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("checkBuildInfo", () => {
  const sourceHash = "a".repeat(64);
  const buildInfo = {
    revision: "abc1234",
    dirty: false,
    builtAt: "2026-09-02T03:04:05Z",
    versionName: "0.6.0 abc1234 2026-09-02T03:04:05Z",
    nameTableHash: sourceHash,
  };

  it.each([undefined, null, {}, [], "invalid"])(
    "rejects missing or invalid build info: %j",
    (value) => {
      expect(checkBuildInfo({ buildInfo: value, sourceHash })).toEqual({
        ok: false,
        reason: "dist/build-info.json is missing; run npm run build",
      });
    },
  );

  it("rejects a changed name table", () => {
    expect(checkBuildInfo({
      buildInfo,
      sourceHash: "b".repeat(64),
    })).toEqual({
      ok: false,
      reason:
        "name table changed after the last build (src/offscreen/glossary.data.ts); run npm run build",
    });
  });

  it("accepts the built name table", () => {
    expect(checkBuildInfo({ buildInfo, sourceHash })).toEqual({ ok: true });
  });
});

describe("cutCaptionLog", () => {
  const instant = "2026-09-02T03:04:05.123Z";
  const replayStartedAtMs = Date.parse(instant);
  const before = new Date(replayStartedAtMs - 1).toISOString();

  it("cuts pages by numeric time and preserves stored fields", () => {
    const kept = {
      cueId: "cue-1", pageId: "0", line0: "字幕", line1: "",
      sourceText: "full source", translationPath: "prompt-api",
      fallback: false, appearedAt: instant, replacedAt: null,
      sources: [{ id: "line-1", text: "full source", rung: "masked" }],
      showOriginal: false, showTentative: true,
      originalRowVisible: false, tentativeRowVisible: true,
    };
    const pages = [
      { ...kept, appearedAt: before },
      kept,
      { ...kept, appearedAt: "garbage" },
    ];
    const cut = cutCaptionLog({ pages, replayStartedAtMs });
    expect(cut).toEqual({
      pages: [kept], pagesUnparsed: 1,
      lines: null, linesUnparsed: null,
      drops: null, dropsUnparsed: null,
    });
    expect(pages).toHaveLength(3);
    expect(cut.pages[0]).toEqual(kept);
  });

  it("cuts lines and drops at their own timestamps", () => {
    const lines = [before, instant, "garbage"].map((acceptedAt) => ({
      id: "line-1", text: "source", rung: "masked", acceptedAt,
    }));
    const drops = [before, instant, "garbage"].map((droppedAt) => ({
      cueId: "cue-1", sourceIds: ["line-1"], droppedAt,
    }));
    expect(cutCaptionLog({
      pages: [], lines, drops, replayStartedAtMs,
    })).toEqual({
      pages: [], pagesUnparsed: 0,
      lines: [lines[1]], linesUnparsed: 1,
      drops: [drops[1]], dropsUnparsed: 1,
    });
  });

  it("distinguishes unavailable logs and does not synthesize sources", () => {
    expect(cutCaptionLog({ replayStartedAtMs })).toEqual({
      pages: null, pagesUnparsed: null,
      lines: null, linesUnparsed: null,
      drops: null, dropsUnparsed: null,
    });
    const cut = cutCaptionLog({
      pages: [{ appearedAt: instant }],
      lines: {}, drops: [], replayStartedAtMs,
    });
    expect(cut.pages[0]).not.toHaveProperty("sources");
    expect(cut.lines).toBeNull();
    expect(cut.drops).toEqual([]);
  });
});

describe("parseArgs display mode", () => {
  it("defaults to both configurations", () => {
    const options = parseArgs([], {});
    expect(options.displayMode).toBe("both");
    expect(options.showOriginal).toBe(false);
    expect(resolveDisplayRuns(options)).toEqual([
      { displayConfig: "original-off", showOriginal: false },
      { displayConfig: "original-on", showOriginal: true },
    ]);
  });

  it("keeps --show-original as original-on only", () => {
    const options = parseArgs(
      ["--show-original", "--case", "theo", "--duration", "30"],
      {},
    );
    expect(options.displayMode).toBe("original-on");
    expect(options.showOriginal).toBe(true);
    expect(options.caseName).toBe("theo");
    expect(options.durationSeconds).toBe(30);
    expect(options.model).toBe("base");
    expect(options.backend).toBe("prompt-api");
    expect(resolveDisplayRuns(options)).toEqual([
      { displayConfig: "original-on", showOriginal: true },
    ]);
  });

  it("runs original-off only when --no-show-original is passed", () => {
    const options = parseArgs(
      ["--no-show-original", "--model", "tiny"],
      {},
    );
    expect(options.displayMode).toBe("original-off");
    expect(options.showOriginal).toBe(false);
    expect(options.model).toBe("tiny");
    expect(resolveDisplayRuns(options)).toEqual([
      { displayConfig: "original-off", showOriginal: false },
    ]);
  });

  it("rejects passing both display flags", () => {
    const options = parseArgs(
      ["--show-original", "--no-show-original"],
      {},
    );
    expect(options.displayModeError).toBe(
      "pass only one of --show-original and --no-show-original",
    );
  });

  it("keeps the profile directory only when requested", () => {
    expect(
      parseArgs([], {}).keepProfileDir,
    ).toBe(false);
    expect(
      parseArgs(
        ["--keep-profile-dir"],
        {},
      ).keepProfileDir,
    ).toBe(true);
  });
});

describe("finalizeGates", () => {
  const displayMeta = {
    displayConfig: "original-off",
    showOriginal: false,
    displayCoverage: "single",
  };

  it("suppresses gates after playback aborts without captured lines", () => {
    const result = {
      error: "playback aborted",
      gates: {
        ...displayMeta,
        lines: 0,
        wrongSenseRoma: 0,
        englishPassthrough: 0,
        stopDrainTimedOut: false,
      },
      observations: { captionTopChanges: 0 },
      diagnostics: { primaryClippedExample: null },
      recognition: { jaClauses: [] },
    };
    const finalized = finalizeGates(result);

    expect(finalized).not.toBe(result);
    expect(finalized.gates).toEqual({
      ...displayMeta,
      lines: null,
      wrongSenseRoma: null,
      englishPassthrough: null,
      stopDrainTimedOut: null,
    });
    expect(finalized.gatesSuppressed).toBe("no captured lines");
    expect(finalized.error).toBe("playback aborted");
    expect(result.gates.lines).toBe(0);
    expect(result).not.toHaveProperty("gatesSuppressed");
    expect(finalized.observations).toBe(result.observations);
    expect(finalized.diagnostics).toBe(result.diagnostics);
    expect(finalized.recognition).toBe(result.recognition);
  });

  it("suppresses gates without captured lines even without an error", () => {
    const finalized = finalizeGates({
      error: undefined,
      gates: {
        ...displayMeta,
        lines: 0,
        wrongSenseRoma: 0,
        englishPassthrough: 0,
      },
    });

    expect(finalized.gates).toEqual({
      ...displayMeta,
      lines: null,
      wrongSenseRoma: null,
      englishPassthrough: null,
    });
    expect(finalized.gatesSuppressed).toBe("no captured lines");
  });

  it("preserves captured counts when a display gate fails", () => {
    const result = {
      error: "display gate failed: primaryClipped",
      gates: { ...displayMeta, lines: 28, primaryClipped: 3 },
    };
    const finalized = finalizeGates(result);

    expect(finalized).toBe(result);
    expect(finalized.gates.lines).toBe(28);
    expect(finalized.gates.primaryClipped).toBe(3);
    expect(finalized).not.toHaveProperty("gatesSuppressed");
  });

  it("returns a captured result without an error unchanged", () => {
    const result = {
      error: undefined,
      gates: { ...displayMeta, lines: 28, wrongSenseRoma: 2 },
    };

    expect(finalizeGates(result)).toBe(result);
    expect(result).not.toHaveProperty("gatesSuppressed");
  });

  it("a result with an error never carries a zeroed gate block", () => {
    for (const error of [
      "playback aborted",
      "backlog did not drain",
      "capture produced no caption lines",
    ]) {
      const finalized = finalizeGates({
        error,
        gates: {
          ...displayMeta,
          lines: 0,
          wrongSenseRoma: 0,
          englishPassthrough: 0,
        },
      });

      expect(finalized.gatesSuppressed).toBe("no captured lines");
      expect(finalized.gates.lines).toBeNull();
      expect(
        Object.values(finalized.gates).filter(
          (value) => typeof value === "number" && value === 0,
        ),
      ).toEqual([]);
    }
  });
});

describe("both-mode reports", () => {
  it("passes gatesSuppressed through to each configuration entry", () => {
    const report = {
      displayConfig: "original-off",
      ...finalizeGates({
        error: "playback aborted",
        gates: annotateDisplayMeta(
          { lines: 0, wrongSenseRoma: 0 },
          {
            displayConfig: "original-off",
            displayCoverage: "single",
          },
        ),
      }),
    };
    const combined = combineDisplayReports([report]);

    expect(combined.configs[0].gatesSuppressed).toBe("no captured lines");
    expect(combined.configs[0].gates).toBe(report.gates);
    expect(combined.configs[0].error).toBe("playback aborted");
  });

  it("returns a labelled result per configuration", () => {
    const combined = combineDisplayReports([
      {
        displayConfig: "original-off",
        showOriginal: false,
        outFile: "off.json",
        gates: annotateDisplayMeta(
          { primaryClipped: 0 },
          {
            displayConfig: "original-off",
            displayCoverage: "single",
          },
        ),
      },
      {
        displayConfig: "original-on",
        showOriginal: true,
        outFile: "on.json",
        gates: annotateDisplayMeta(
          { primaryClipped: 0 },
          {
            displayConfig: "original-on",
            displayCoverage: "single",
          },
        ),
      },
    ]);
    expect(combined.displayCoverage).toBe("both");
    expect(combined.error).toBeUndefined();
    expect(combined.configs.map((entry) => entry.displayConfig)).toEqual([
      "original-off",
      "original-on",
    ]);
    expect(combined.configs[0].gates.displayConfig).toBe("original-off");
    expect(combined.configs[1].gates.displayConfig).toBe("original-on");
    expect(combined.configs[0].outFile).toBe("off.json");
    expect(combined.configs[1].outFile).toBe("on.json");
  });

  it("fails the run when either configuration fails and names it", () => {
    const combined = combineDisplayReports([
      {
        displayConfig: "original-off",
        showOriginal: false,
        outFile: "off.json",
        gates: { displayConfig: "original-off", primaryClipped: 0 },
      },
      {
        displayConfig: "original-on",
        showOriginal: true,
        outFile: "on.json",
        gates: { displayConfig: "original-on", primaryClipped: 432 },
        error: "display gate failed: primaryClipped",
      },
    ]);
    expect(combined.displayCoverage).toBe("both");
    expect(combined.error).toBe(
      "display gate (original-on) failed: primaryClipped",
    );
  });

  it("names both configurations when both display gates fail", () => {
    const combined = combineDisplayReports([
      {
        displayConfig: "original-off",
        error:
          "display gate insufficient: no non-empty cue transition observed",
        gates: { displayConfig: "original-off" },
      },
      {
        displayConfig: "original-on",
        error: "display gate failed: primaryClipped",
        gates: { displayConfig: "original-on" },
      },
    ]);
    expect(combined.error).toBe(
      "display gate (original-off) insufficient: no non-empty cue transition observed; display gate (original-on) failed: primaryClipped",
    );
  });
});

describe("single-configuration argv", () => {
  it("pins one configuration without changing other flags", () => {
    expect(
      argvForDisplayRun(
        ["--case", "tts2", "--duration", "95", "--show-original"],
        "original-off",
      ),
    ).toEqual([
      "--case",
      "tts2",
      "--duration",
      "95",
      "--no-show-original",
    ]);
  });

  it("labels a child report with the configuration that produced it", () => {
    const report = parseChildReport(
      JSON.stringify({
        outFile: "on.json",
        gates: { primaryClipped: 0 },
        error: undefined,
      }),
      0,
      "original-on",
    );
    expect(report.displayConfig).toBe("original-on");
    expect(report.showOriginal).toBe(true);
    expect(report.gates.displayConfig).toBe("original-on");
    expect(report.gates.showOriginal).toBe(true);
    expect(report.gates.displayCoverage).toBe("single");
    expect(report.gates.primaryClipped).toBe(0);
  });
});

describe("countPageLineReuse", () => {
  it("does not flag two pages that share text but not cue identity", () => {
    expect(
      countPageLineReuse([
        { cueId: "cue-1", pageId: "0", lines: ["はい"] },
        { cueId: "cue-2", pageId: "0", lines: ["はい"] },
      ]),
    ).toBe(0);
  });

  it("flags a line carried across pages of the same cue", () => {
    expect(
      countPageLineReuse([
        { cueId: "cue-1", pageId: "0", lines: ["上の行", "持ち越し"] },
        { cueId: "cue-1", pageId: "1", lines: ["持ち越し", "新しい行"] },
      ]),
    ).toBe(1);
  });

  it("does not flag a two-page cue whose pages share no line", () => {
    expect(
      countPageLineReuse([
        { cueId: "cue-1", pageId: "0", lines: ["L1", "L2"] },
        { cueId: "cue-1", pageId: "1", lines: ["L3"] },
      ]),
    ).toBe(0);
  });
});

describe("assertCaseMedia", () => {
  it("fails fast with the path and local-only for a missing third-party fixture", () => {
    const mediaFile = "/no-such-x-jimaku-media/theo-speech.wav";
    expect(() =>
      assertCaseMedia({ mediaFile, localOnly: true }),
    ).toThrow(`missing local-only media file: ${mediaFile}`);
  });

  it("accepts committed fixture media", () => {
    assertCaseMedia({
      mediaFile: path.join(here, "refs", "tts-speech.wav"),
    });
  });
});
