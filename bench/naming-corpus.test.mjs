import path from "node:path";

import {
  describe,
  expect,
  it,
} from "vitest";
import {
  analyzeCurrent,
  assessChange,
  buildUnits,
  classifyName,
  compareRates,
  parseArgs,
  renderCandidates,
  takeRun,
  wilcoxonRankSumOneSided,
} from "./naming-corpus.mjs";

const roman = {
  term: "Roman",
  render: "latin",
  rejected: [],
};
const romanJa = {
  term: "Roman",
  render: "ja",
  ja: "ローマン宇宙望遠鏡",
  rejected: [],
};

function source(
  id,
  text,
  rung = "masked",
) {
  return {
    id,
    text,
    rung,
    acceptedAt: `2026-09-05T00:00:${String(id).padStart(2, "0")}Z`,
  };
}

function page(
  cueId,
  sources,
  output,
  {
    fallback = false,
    appearedAt = "2026-09-05T00:01:00Z",
  } = {},
) {
  return {
    cueId,
    pageId: "0",
    sources,
    line0: output,
    line1: "",
    fallback,
    appearedAt,
  };
}

function newRun({
  lines = [],
  pages = [],
  drops = [],
  devLog = [],
} = {}) {
  return {
    recognition: {
      jaClauses: ["字幕"],
    },
    display: {
      lines,
      pages,
      drops,
    },
    diagnostics: {
      devLog,
    },
  };
}

function classifyFixture(
  sourceText,
  output,
  name = roman,
  rung = "masked",
) {
  const line = source(1, sourceText, rung);
  const run = newRun({
    lines: [line],
    pages: [
      page("1:0", [
        {
          id: line.id,
          text: line.text,
          rung: line.rung,
        },
      ], output),
    ],
  });
  return classifyName(buildUnits(run), name);
}

describe("parseArgs", () => {
  it("keeps result and output directories inside bench", () => {
    for (const flag of ["--out", "--results"]) {
      expect(() => parseArgs([flag, "/tmp/x"]))
        .toThrow(/inside bench\//u);
    }
    expect(
      parseArgs(["--out", "bench/results"]).outputDirectory,
    ).toBe(path.resolve("bench/results"));
  });
});

describe("buildUnits", () => {
  it("joins split cues and merged cues by source lines", () => {
    const first = source(1, "Roman");
    const second = source(2, "NASA");
    const third = source(3, "Goddard");
    const built = buildUnits(newRun({
      lines: [first, second, third],
      pages: [
        page("1:0", [first], "前半", {
          appearedAt: "2026-09-05T00:01:00Z",
        }),
        page("1:1", [first], "後半", {
          appearedAt: "2026-09-05T00:01:01Z",
        }),
        page(
          "2:0+3:0",
          [second, third],
          "NASA Goddard",
          { appearedAt: "2026-09-05T00:01:02Z" },
        ),
      ],
    }));

    const split = built.units.find((unit) =>
      unit.lines.some((line) => line.id === 1),
    );
    const merged = built.units.find((unit) =>
      unit.lines.some((line) => line.id === 2),
    );
    expect(split.pages).toHaveLength(2);
    expect(split.output).toBe("前半\n後半");
    expect(merged.lines.map((line) => line.id)).toEqual([
      2,
      3,
    ]);
  });

  it("keeps an unpaged line as a unit and marks it missing on screen", () => {
    const built = buildUnits(newRun({
      lines: [source(1, "Roman")],
    }));
    const result = classifyName(built, roman);

    expect(built.units).toHaveLength(1);
    expect(result.classes.missing.count).toBe(1);
    expect(result.classes.missing.onScreen).toBe(1);
  });

  it("marks a dropped cue as missing before display", () => {
    const line = source(1, "Roman");
    const built = buildUnits(newRun({
      lines: [line],
      drops: [{
        cueId: "1:0",
        sourceIds: [1],
        droppedAt: "2026-09-05T00:01:00Z",
      }],
    }));
    const result = classifyName(built, roman);

    expect(result.classes.missing.count).toBe(1);
    expect(
      result.classes.missing.droppedBeforeDisplay,
    ).toBe(1);
  });

  it("adds queue drops to D and marks them before translation", () => {
    const built = buildUnits(newRun({
      devLog: [{
        data: {
          kind: "queue-drop",
          lineId: 9,
          text: "Roman",
        },
      }],
    }));
    const result = classifyName(built, roman);

    expect(result.english).toBe(1);
    expect(
      result.classes.missing.droppedBeforeTranslation,
    ).toBe(1);
  });

  it("deduplicates exact line records", () => {
    const line = source(1, "Roman");
    const built = buildUnits(newRun({
      lines: [line, { ...line }],
      pages: [page("1:0", [line], "Roman")],
    }));
    expect(built.units[0].lines).toHaveLength(1);
    expect(classifyName(built, roman).english).toBe(1);
  });
});

describe("classifyName", () => {
  it("classifies a Latin expected form", () => {
    const result = classifyFixture("Roman", "Roman");
    expect(result.classes.expected.count).toBe(1);
    expect(result.rates.nameExpectedRate).toBe(1);
  });

  it("classifies Latin output as keptLatin for a Japanese row", () => {
    const result = classifyFixture(
      "Roman",
      "Roman",
      romanJa,
    );
    expect(result.classes.keptLatin.count).toBe(1);
    expect(result.classes.expected.count).toBe(0);
  });

  it("matches rejected forms without matching ローマ inside ローマン", () => {
    const result = classifyFixture(
      "Roman and Roman",
      "ローマン ローマ",
      {
        ...roman,
        rejected: [{
          form: "ローマ",
          reason: "fixture",
        }],
      },
    );
    expect(result.classes.wrongKnown.count).toBe(1);
    expect(
      result.classes.wrongKnown.forms,
    ).toEqual({ "ローマ": 1 });
    expect(result.classes.variant.forms).toEqual({
      "ローマン": 1,
    });
  });

  it.each([
    ["Opus", "オпус"],
    [
      "Kennedy Space Center",
      "ケネディの Space Center",
    ],
  ])(
    "classifies a script-mixed form for %s",
    (term, output) => {
      const result = classifyFixture(
        term,
        output,
        {
          term,
          render: "latin",
          rejected: [],
        },
      );
      expect(result.classes.wrongKnown.count).toBe(1);
    },
  );

  it("does not count a script-mixed remainder as a variant", () => {
    const result = classifyFixture(
      "Opus and Opus",
      "オпус",
      {
        term: "Opus",
        render: "latin",
        rejected: [],
      },
    );
    expect(result.classes.wrongKnown.count).toBe(1);
    expect(result.classes.variant.count).toBe(0);
    expect(result.classes.missing.count).toBe(1);
  });

  it("uses the candidate majority rule when classifying variants", () => {
    const goddard = {
      term: "Goddard",
      render: "latin",
      rejected: [],
    };
    const makeUnits = (texts) =>
      texts.map((text, index) => ({
        lines: [{
          key: index,
          text,
          rung: "masked",
        }],
        output: "ゴッダード",
      }));

    const mostlyPositive = classifyName(
      makeUnits([...Array(3).fill("Goddard"), "NASA gottered"]),
      goddard,
    );
    expect(mostlyPositive.classes.variant.count).toBe(3);
    expect(mostlyPositive.classes.missing.count).toBe(0);

    const mostlyNegative = classifyName(
      makeUnits(["Goddard", ...Array(3).fill("NASA gottered")]),
      goddard,
    );
    expect(mostlyNegative.classes.variant.count).toBe(0);
    expect(mostlyNegative.classes.missing.count).toBe(1);
  });

  it("classifies an unknown Katakana form as a variant", () => {
    const result = classifyFixture(
      "Roman",
      "ローマン",
    );
    expect(result.classes.variant.count).toBe(1);
    expect(result.classes.variant.forms).toEqual({
      "ローマン": 1,
    });
  });

  it.each([
    [
      "ケネディ宇宙センターのチーム",
      "ケネディ宇宙センター",
    ],
    ["ローマ宇宙望遠鏡が", "ローマ宇宙望遠鏡"],
    ["ローマンの", "ローマン"],
  ])(
    "keeps the maximal Katakana and Kanji form in %s",
    (output, form) => {
      const result = classifyFixture(
        "Example",
        output,
        {
          term: "Example",
          render: "latin",
          rejected: [],
        },
      );
      expect(result.classes.variant.forms).toEqual({
        [form]: 1,
      });
    },
  );

  it("uses missing for English occurrences without output forms", () => {
    const result = classifyFixture(
      "Roman and Roman",
      "Roman",
    );
    expect(result.english).toBe(2);
    expect(result.classes.expected.count).toBe(1);
    expect(result.classes.missing.count).toBe(1);
  });

  it("attributes a single-rung unit to that rung", () => {
    const result = classifyFixture(
      "Roman",
      "Roman",
      roman,
      "lm-masked",
    );
    expect(
      result.classes.expected.byRung,
    ).toEqual({ "lm-masked": 1 });
  });

  it("attributes a multi-line, multi-rung name to mixed", () => {
    const first = source(1, "Roman", "lm-masked");
    const second = source(
      2,
      "Roman",
      "lm-unmasked",
    );
    const run = newRun({
      lines: [first, second],
      pages: [
        page(
          "1:0+2:0",
          [first, second],
          "Roman Roman",
        ),
      ],
    });
    const result = classifyName(buildUnits(run), roman);

    expect(result.classes.expected.count).toBe(2);
    expect(
      result.classes.expected.byRung,
    ).toEqual({ mixed: 2 });
  });
});

describe("set checks", () => {
  it("excludes only pages whose source ids are all pre-cut", () => {
    const eighth = source(8, "Roman");
    const built = buildUnits(newRun({
      lines: [eighth, source(9, "line nine")],
      pages: [
        page("3:0", [source(3, "warmup")], "古い字幕"),
        page("8:0", [eighth], "Roman"),
      ],
    }));

    expect(built.warmupPagesExcluded).toBe(1);
    expect(built.checksFailed).toEqual([]);
    expect(built.units).toHaveLength(2);
    expect(
      built.units.find((unit) =>
        unit.lines.some((line) => line.id === 9),
      ).pages,
    ).toHaveLength(0);

    const mixed = buildUnits(newRun({
      lines: [eighth],
      pages: [
        page(
          "7:0+8:0",
          [source(7, "warmup"), eighth],
          "Roman",
        ),
      ],
    }));
    expect(mixed.warmupPagesExcluded).toBe(0);
    expect(
      mixed.checksFailed.some((check) =>
        check.startsWith("①"),
      ),
    ).toBe(true);

    const empty = buildUnits(newRun({
      pages: [page("3:0", [source(3, "warmup")], "古い字幕")],
    }));
    expect(empty.warmupPagesExcluded).toBe(0);
    expect(empty.checksFailed[0]).toMatch(/^①/u);
  });
  it("invalidates rates when a page source is absent from lines", () => {
    const run = newRun({
      lines: [source(1, "Roman")],
      pages: [
        page(
          "2:0",
          [{
            id: 2,
            text: "Roman",
            rung: "masked",
          }],
          "Roman",
        ),
      ],
    });
    const built = buildUnits(run);
    const result = classifyName(built, roman);

    expect(built.checksFailed[0]).toMatch(/^①/u);
    expect(result.rates.nameExpectedRate).toBeNull();
    expect(result.rates.nameWrongKnownRate).toBeNull();
  });
});

describe("Wilcoxon rate comparisons", () => {
  it("returns 1/252 when all five after values are worse", () => {
    const p = wilcoxonRankSumOneSided(
      [0, 0, 0, 0, 0],
      [1, 1, 1, 1, 1],
      "higher",
    );
    expect(p).toBeCloseTo(1 / 252, 12);
  });

  it("does not report a small p for identical distributions", () => {
    const sample = [0, 0.25, 0.5, 0.75, 1];
    expect(
      wilcoxonRankSumOneSided(
        sample,
        sample,
        "higher",
      ),
    ).toBeGreaterThanOrEqual(0.5);
  });

  it("is undecidable with fewer than five runs", () => {
    const sample = Array.from({ length: 4 }, () => ({
      num: 0,
      den: 1,
    }));
    expect(compareRates({
      before: sample,
      after: sample,
      direction: "higher",
    }).verdict).toBe("undecidable");
  });
});

describe("assessChange", () => {
  function assessmentRun() {
    return {
      termsMode: "with",
      naming: {
        atRun: {
          names: {
            Roman: {
              expected: "Roman",
              english: 2,
              classes: {
                wrongKnown: { count: 0 },
                expected: { count: 2 },
              },
              rates: {
                nameWrongKnownRate: 0,
                nameExpectedRate: 1,
              },
            },
          },
          englishPassthroughRate: {
            num: 0,
            den: 10,
            rate: 0,
          },
        },
      },
    };
  }

  it("reads atCurrent when a run has no atRun and the table is unchanged", () => {
    const fromCurrent = () => {
      const run = assessmentRun();
      return {
        termsMode: run.termsMode,
        tableChanged: false,
        naming: { atCurrent: run.naming.atRun },
      };
    };
    const assessment = assessChange({
      runsBefore: Array.from({ length: 5 }, fromCurrent),
      runsAfter: Array.from({ length: 5 }, fromCurrent),
      target: "Roman",
    });
    expect(assessment.items.A3.verdict).toBe("no-evidence");

    const changed = () => ({ ...fromCurrent(), tableChanged: true });
    const undecidable = assessChange({
      runsBefore: Array.from({ length: 5 }, changed),
      runsAfter: Array.from({ length: 5 }, changed),
      target: "Roman",
    });
    expect(undecidable.items.A3.verdict).toBe("undecidable");
  });

  it("returns no-evidence when all five A comparisons are unchanged", () => {
    const before =
      Array.from({ length: 5 }, assessmentRun);
    const after =
      Array.from({ length: 5 }, assessmentRun);
    const assessment = assessChange({
      runsBefore: before,
      runsAfter: after,
      target: "Roman",
    });

    expect(assessment.items.A1.verdict).toBe(
      "no-evidence",
    );
    expect(assessment.items.A3.verdict).toBe(
      "no-evidence",
    );
    expect(assessment.items.A5.verdict).toBe(
      "no-evidence",
    );
    expect(assessment.overall).toBe("no-evidence");
  });
});

describe("takeRun", () => {
  it("takes a run whose only error is a display gate", () => {
    expect(takeRun({
      error: "display gate failed: x",
      display: { lines: [source(1, "Roman")] },
    }).taken).toBe(true);
  });

  it("skips a capture failure", () => {
    expect(takeRun({
      error: "capture produced no caption lines",
      recognition: { jaClauses: [] },
      display: {},
    }).taken).toBe(false);
  });

  it("skips suppressed gates", () => {
    const intake = takeRun({
      gatesSuppressed: "no captured lines",
      display: { lines: [source(1, "Roman")] },
    });
    expect(intake.taken).toBe(false);
    expect(intake.skippedReason).toContain(
      "gatesSuppressed",
    );
  });
});

describe("renderCandidates", () => {
  it("renders unstable forms and a pasteable NameTerm skeleton", () => {
    const markdown = renderCandidates({
      nameRows: [roman],
      runs: [{
        file: "run.json",
        taken: true,
        naming: {
          atCurrent: {
            names: {
              Roman: {
                expected: "Roman",
                english: 2,
                forms: {
                  Roman: 1,
                  "ローマン": 1,
                },
                formRungs: {
                  Roman: { masked: 1 },
                  "ローマン": { unmasked: 1 },
                },
                classes: {
                  variant: {
                    forms: { "ローマン": 1 },
                  },
                },
              },
            },
          },
        },
      }],
    });

    expect(markdown).toContain("Roman");
    expect(markdown).toContain("ローマン");
    expect(markdown).toContain('ja: ""');
    expect(markdown).toContain('source: ""');
    expect(markdown.match(/run\.json/gu)).toHaveLength(1);
    expect(markdown).toContain("masked:1, unmasked:1");
  });

  it("drops forms that another name owns for certain, but not its variants", () => {
    const goddardJa = {
      term: "Goddard",
      render: "ja",
      ja: "ゴッダード",
      rejected: [],
    };
    const shared = source(1, "Roman with Goddard");
    const withNames = analyzeCurrent(newRun({
      lines: [shared],
      pages: [page("1:0", [shared], "ゴッダード ローマン")],
    }), [roman, goddardJa]);
    expect(
      withNames.naming.names.Roman.candidateExcludedForms,
    ).toContain("ゴッダード");
    expect(
      withNames.naming.names.Roman.candidateExcludedForms,
    ).not.toContain("ローマン");

    const goddardLatin = { term: "Goddard", render: "latin", rejected: [] };
    const asVariant = analyzeCurrent(newRun({
      lines: [shared],
      pages: [page("1:0", [shared], "ゴッダード ローマン")],
    }), [roman, goddardLatin]);
    expect(
      asVariant.naming.names.Roman.candidateExcludedForms,
    ).not.toContain("ゴッダード");
  });

  it("strikes a form only when most known units without the name carry it", () => {
    const other = (id) => source(id, "The team ran a check.");
    const one = analyzeCurrent(newRun({
      lines: [other(2)],
      pages: [page("2:0", [other(2)], "エンジニア")],
    }), [roman]);
    expect(
      one.naming.names.Roman.candidateExcludedForms,
    ).not.toContain("エンジニア");

    const three = analyzeCurrent(newRun({
      lines: [other(2), other(3), other(4)],
      pages: [
        page("2:0", [other(2)], "エンジニア"),
        page("3:0", [other(3)], "エンジニア"),
        page("4:0", [other(4)], "エンジニア"),
      ],
    }), [roman]);
    expect(
      three.naming.names.Roman.candidateExcludedForms,
    ).toContain("エンジニア");
  });

  it("does not strike forms from units whose English side is unknown", () => {
    const oldShape = analyzeCurrent({
      recognition: { jaClauses: ["ローマの望遠鏡"] },
      display: {
        blocks: [
          { cueId: "1:0", pageId: "0", line0: "ローマの望遠鏡", line1: "", lines: ["ローマの望遠鏡"] },
        ],
      },
      diagnostics: { devLog: [] },
    }, [roman]);
    expect(
      oldShape.naming.names.Roman.candidateExcludedForms,
    ).not.toContain("ローマ");
  });
});
