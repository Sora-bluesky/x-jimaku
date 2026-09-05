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
  assertCaseMedia,
  countPageLineReuse,
} from "./live2-config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

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

describe("both-mode reports", () => {
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
