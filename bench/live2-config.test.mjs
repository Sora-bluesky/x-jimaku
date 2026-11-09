import {
  describe,
  expect,
  it,
} from "vitest";
import path from "node:path";
import os from "node:os";
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
  countRomanKeptInJapanese,
  soakSentences,
  ALLOWED_BACKENDS,
  ALLOWED_PLAMO_MODELS,
  live2ProfilePolicy,
  live2BuildAction,
  createPlamoReadiness,
  countEnglishPassthrough,
} from "./live2-config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("development dwell options", () => {
  it("defaults to the current flat dwell and preserves flags for both display runs", () => {
    expect(parseArgs([], {}).dwellPolicy).toBeNull();
    expect(parseArgs(["--dwell-rate", "4"], {}).dwellPolicy)
      .toEqual({ dwellRate: 4, dwellFloorMs: 1500, dwellAccelRate: 0, dwellAccelFloorMs: 1000 });
    const argv = ["--dwell-rate", "4", "--dwell-floor-ms", "1600", "--dwell-accel-rate", "7", "--dwell-accel-floor-ms", "1100"];
    const policy = { dwellRate: 4, dwellFloorMs: 1600, dwellAccelRate: 7, dwellAccelFloorMs: 1100 };
    expect(parseArgs(argv, {}).dwellPolicy).toEqual(policy);
    for (const run of resolveDisplayRuns(parseArgs(argv, {}))) {
      expect(parseArgs(argvForDisplayRun(argv, run.displayConfig), {}).dwellPolicy).toEqual(policy);
    }
  });

  it.each(["--dwell-rate", "--dwell-floor-ms", "--dwell-accel-rate", "--dwell-accel-floor-ms"])(
    "rejects invalid values for %s before the bench can launch", flag => {
      for (const value of [undefined, "", "-1", "NaN", "Infinity"]) {
        expect(() => parseArgs(value === undefined ? [flag] : [flag, value], {})).toThrow(flag);
      }
    },
  );
});

describe("PLaMo bench configuration", () => {
  it("defaults to 0.8b and accepts each supported size", () => {
    expect(parseArgs([], {}).plamoModel).toBe("0.8b");
    expect(ALLOWED_BACKENDS).toContain("plamo");
    for (const model of ALLOWED_PLAMO_MODELS) {
      const options = parseArgs(["--backend", "plamo", "--plamo-model", model], {});
      expect(options.backend).toBe("plamo");
      expect(options.plamoModel).toBe(model);
    }
    expect(ALLOWED_PLAMO_MODELS).not.toContain("3b");
    expect(ALLOWED_PLAMO_MODELS).not.toContain(parseArgs(["--plamo-model"], {}).plamoModel);
  });

  it("preserves the PLaMo cache", () => {
    expect(live2ProfilePolicy()).toEqual({
      directoryName: "x-jimaku-bench-plamo", reset: false,
    });
    expect(ALLOWED_BACKENDS).toEqual(["plamo"]);
  });
});

describe("live2 build recovery", () => {
  for (const backend of ALLOWED_BACKENDS) {
    for (const profileReset of [false, true]) {
      const options = { backend, profileReset, expectedBuild: "current build" };
      it(`reuses a matching ${backend} profile (reset: ${profileReset})`, () => {
        expect(live2BuildAction({ ...options, workerBuild: "current build" })).toBe("reuse");
      });
      it(`handles a stale ${backend} profile (reset: ${profileReset})`, () => {
        expect(live2BuildAction({ ...options, workerBuild: "stale build" })).toBe(
          !profileReset ? "reset-and-retry" : "fail",
        );
      });
    }
  }
});

describe("PLaMo readiness", () => {
  const timeoutMs = 120000;
  const start = () => createPlamoReadiness({ timeoutMs, startedAtMs: 0 });

  it("waits beyond the fixed timeout while download bytes increase", () => {
    const observe = start();
    for (let step = 1; step <= 4; step += 1) {
      expect(observe({ loadedBytes: step, running: true }, step * timeoutMs / 2)).toMatchObject({
        ready: false, progressed: true,
      });
    }
    expect(observe({ loadedBytes: 4, running: true, path: "plamo" }, timeoutMs * 3)).toMatchObject({
      ready: true, progressed: true,
    });
  });

  it("requires both the PLaMo path and running capture", () => {
    const observe = start();
    expect(observe({ path: "plamo", running: false }, 0).ready).toBe(false);
    expect(observe({ path: "plamo", running: true }, 1).ready).toBe(true);
  });

  it.each([
    ["plamo", false, true, false],
    [undefined, true, false, true],
    ["plamo", true, true, true],
  ])("reports independent conditions for path=%s, running=%s", (path, running, plamoReady, captureRunning) => {
    expect(start()({ path, running }, 0)).toMatchObject({
      plamoReady, captureRunning, ready: plamoReady && captureRunning,
    });
  });

  it("extends capture readiness for advancing Whisper state and chip progress only", () => {
    const observe = start();
    observe({ path: "plamo", captureState: { status: "loadingModel", progress: 10 } }, 0);
    const snapshot = { path: "plamo", captureState: { status: "loadingModel", progress: 20 }, overlayChipText: "字幕 準備中… 20%" };
    expect(observe(snapshot, timeoutMs / 2).progressed).toBe(true);
    expect(observe({ ...snapshot, overlayChipText: "字幕 準備中… 30%" }, timeoutMs).progressed).toBe(true);
    expect(observe({ ...snapshot, overlayChipText: "字幕 準備中(ウォームアップ)…" }, timeoutMs * 1.5).progressed).toBe(true);
    expect(observe({ path: "plamo", captureState: { status: "running" } }, timeoutMs * 2).ready).toBe(true);
  });

  it("counts ASR initialization logs once and preserves the last evidence in the failure", () => {
    const observe = start();
    const snapshot = { path: "plamo", captureState: { status: "loadingModel", progress: 99 },
      overlayChipText: "字幕 準備中(ウォームアップ)…", asrProgress: { tag: "whisper", message: "initializing pipeline" } };
    const last = observe(snapshot, timeoutMs / 2);
    expect(observe(snapshot, timeoutMs).progressed).toBe(false);
    expect(() => observe(snapshot, timeoutMs * 1.5)).toThrow(
      'capture running readiness stalled: no download, sha256 or initialization progress within 120000ms; unmet: capture running (path: plamo, capture state: {"status":"loadingModel","progress":99}, overlay chip: "字幕 準備中(ウォームアップ)…", downloaded: 0 bytes, hashed: 0 bytes, last progress: asr-log at 60000ms, elapsed since progress: 120000ms)',
    );
    expect(last).toMatchObject({ lastProgressKind: "asr-log", lastProgressAtMs: timeoutMs / 2 });
  });

  it("names both unmet conditions and the PLaMo-only condition", () => {
    expect(() => start()({}, timeoutMs)).toThrow("unmet: PLaMo ready, capture running");
    const observe = start();
    observe({ running: true }, 0);
    expect(() => observe({ running: true }, timeoutMs)).toThrow("unmet: PLaMo ready (path: pending");
  });

  it("does not renew the wait for regressing ASR percentages", () => {
    const observe = start();
    observe({ path: "plamo", captureState: { status: "loadingModel", progress: 50 }, overlayChipText: "字幕 準備中… 50%" }, 0);
    expect(() => observe({ path: "plamo", captureState: { status: "loadingModel", progress: 40 }, overlayChipText: "字幕 準備中… 40%" }, timeoutMs)).toThrow("capture running readiness stalled");
  });

  it("fails immediately on none even with running capture and download progress", () => {
    expect(() => start()({ path: "none", loadedBytes: 1, running: true }, 1)).toThrow(
      "PLaMo initialization failed (translation path: none)",
    );
  });

  it("fails at the existing timeout without progress", () => {
    const observe = start();
    observe({ running: true }, 0);
    expect(() => observe({ running: true }, timeoutMs)).toThrow("no download, sha256 or initialization progress within 120000ms");
  });

  it("does not let repeated or decreasing byte counts extend the wait", () => {
    const observe = start();
    observe({ loadedBytes: 10 }, timeoutMs / 2);
    expect(observe({ loadedBytes: 10 }, timeoutMs).progressed).toBe(false);
    expect(() => observe({ loadedBytes: 9 }, timeoutMs * 1.5)).toThrow("readiness stalled");
  });

  it("does not treat repeated ready-path notifications as progress while capture stalls", () => {
    const observe = start();
    observe({ path: "plamo", running: false }, 0);
    expect(() => observe({ path: "plamo", running: false }, timeoutMs)).toThrow("readiness stalled");
  });
});

describe("row-level englishPassthrough", () => {
  it("counts English primary rows without a passthrough dev log", () => {
    const result = {
      diagnostics: { devLog: [] },
      pages: [
        { line0: "日本語の行", line1: "An untranslated English row" },
        { line0: "Another English row", line1: "" },
      ],
    };
    expect(countEnglishPassthrough(result.pages)).toBe(2);
    result.diagnostics.devLog.push({ data: { kind: "passthrough" } });
    expect(countEnglishPassthrough(result.pages)).toBe(2);
  });

  it("checks every primary row, including names and numbers, ignoring blank slots", () => {
    expect(countEnglishPassthrough([
      { lines: ["Roman", "123", "日本語 Roman", "", " "] },
      { line0: "NASA", line1: "訳文" },
    ])).toBe(3);
  });

  it("counts primary display-log rows independently of path, fallback, or English source", () => {
    expect(countEnglishPassthrough([
      { line0: "English", line1: "日本語", translationPath: "plamo", fallback: false },
      { line0: "Still English", line1: "", translationPath: "none", fallback: true },
      { line0: "日本語", line1: "", sourceText: "English source", originalRowVisible: true },
    ])).toBe(2);
  });
});

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

  it("rejects build info left over from a different build than the manifest", () => {
    const check = checkBuildInfo({
      buildInfo,
      sourceHash,
      versionName: "0.6.0 abc1234 2026-09-02T03:09:00Z",
    });
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("different build");
    expect(check.reason).toContain("npm run build");
  });

  it("accepts build info whose version name matches the manifest", () => {
    expect(checkBuildInfo({
      buildInfo,
      sourceHash,
      versionName: buildInfo.versionName,
    })).toEqual({ ok: true });
  });
});

describe("cutCaptionLog", () => {
  const instant = "2026-09-02T03:04:05.123Z";
  const replayStartedAtMs = Date.parse(instant);
  const before = new Date(replayStartedAtMs - 1).toISOString();

  it("cuts pages by numeric time and preserves stored fields", () => {
    const kept = {
      cueId: "cue-1", pageId: "0", line0: "字幕", line1: "",
      sourceText: "full source", translationPath: "plamo",
      fallback: false, appearedAt: instant, replacedAt: null,
      sources: [{ id: "line-1", text: "full source", rung: "plamo" }],
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
      id: "line-1", text: "source", rung: "plamo", acceptedAt,
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

describe("parseArgs Chrome path", () => {
  it.each([undefined, "", " \t "])(
    "uses the home fallback for absent or blank LOCALAPPDATA: %j",
    (localAppData) => {
      const options = parseArgs([], { LOCALAPPDATA: localAppData });
      expect(options.chromePath).toBe(path.join(
        os.homedir(), "AppData", "Local", "Google", "Chrome SxS",
        "Application", "chrome.exe",
      ));
      expect(path.isAbsolute(options.chromePath)).toBe(true);
    },
  );

  it("uses a nonblank LOCALAPPDATA", () => {
    const localAppData = path.join(os.tmpdir(), "local-app-data");
    expect(parseArgs([], { LOCALAPPDATA: localAppData }).chromePath).toBe(
      path.join(localAppData, "Google", "Chrome SxS", "Application", "chrome.exe"),
    );
  });

  it("preserves environment and command-line Chrome overrides", () => {
    const env = { LOCALAPPDATA: "", BENCH_CHROME: "custom-chrome" };
    expect(parseArgs([], env).chromePath).toBe("custom-chrome");
    expect(parseArgs(["--chrome", "cli-chrome"], env).chromePath).toBe("cli-chrome");
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
    expect(options.backend).toBe("plamo");
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
        meta: { backend: "plamo", plamoModel: "2b" },
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
    expect(combined.configs[0].meta).toEqual({ backend: "plamo", plamoModel: "2b" });
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


describe("PLaMo diagnostic metrics", () => {
  it("counts whole Roman words only in Japanese primary lines", () => {
    expect(countRomanKeptInJapanese([
      { line0: "Roman is ready.", line1: "English Roman", original: "Roman 日本語" },
      { line0: "Romanが完成。Romanを試験。", line1: "ローマンです。", original: "Roman" },
      { line0: "Romanian Roman2 _Roman 日本語", line1: "Roman 日本語" },
      { line0: "Roman", line1: "日本語" },
    ])).toBe(3);
  });
  it("cycles script sentences and rejects invalid counts or an empty script", () => {
    expect(soakSentences("First. Second! Third?", 5)).toEqual(["First.", "Second!", "Third?", "First.", "Second!"]);
    for (const count of [0, -1, 1.5, NaN, Infinity]) expect(() => soakSentences("Hi.", count)).toThrow();
    expect(() => soakSentences("  ", 1)).toThrow();
    expect(parseArgs(["--plamo-soak", "5"], {})).toMatchObject({ backend: "plamo", plamoSoak: 5 });
  });
});
