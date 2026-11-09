import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

it("prints quality gates for missing audio evidence and pools only available latency", () => {
  const directory = mkdtempSync(path.join(process.cwd(), ".p3-recount-test-"));
  try {
    const replayStartedAt = "2026-11-09T00:00:00Z";
    const result = { case: "tts2", replayStartedAt,
      display: { pages: [{ cueId: "cue", pageId: "page", sourceText: "ready for launch",
        lines: ["Roman ローマ %%"],
        appearedAt: "2026-11-09T00:00:04Z",
        displayStartAtMs: Date.parse(replayStartedAt) + 4000 }] } };
    const missing = path.join(directory, "missing.json");
    const available = path.join(directory, "available.json");
    writeFileSync(missing, JSON.stringify(result) + "\n", "utf8");
    writeFileSync(available, JSON.stringify({ ...result,
      observations: { captionLogDwell: { pages: result.display.pages } } }) + "\n", "utf8");
    const run = spawnSync(process.execPath, ["bench/recount-gates.mjs", missing, available], { encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const rows = run.stdout.trim().split(/\r?\n/).map(row => JSON.parse(row.slice(row.indexOf(" ") + 1)));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ pages: 1, r1Audio: { available: false, samples: 0, pass: null,
      reason: "missing observations.captionLogDwell.pages for measured-window audio latency" } });
    expect(rows[0]).toMatchObject({ romanKept: 1, wrongSenseRoma: 1, unresolvedPlaceholders: 1 });
    expect(rows[1]).toMatchObject({ pages: 1, r1Audio: { samples: 1, p50: 1321.315 } });
    expect(rows[2]).toMatchObject({ r1Audio: { samples: 1, p50: 1321.315, p90: 1321.315,
      files: 2, failedFiles: 0, unavailableFiles: 1, pass: null } });
    for (const key of ["romanKept", "wrongSenseRoma", "unresolvedPlaceholders", "romanKeptInJapanese", "englishPassthrough"]) {
      expect(rows[2][key]).toBe(rows[0][key] + rows[1][key]);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each(["available", "missing", "failed"])("reports a complete or incomplete pool with %s input", (input) => {
  const directory = mkdtempSync(path.join(process.cwd(), ".p3-recount-test-"));
  try {
    const page = { cueId: "pool", pageId: "0", sourceText: "ready for launch", lines: ["translation"],
      appearedAt: "2026-11-09T00:00:04Z", displayStartAtMs: Date.parse("2026-11-09T00:00:04Z") };
    const result = { case: "tts2", replayStartedAt: "2026-11-09T00:00:00Z", display: { pages: [page] } };
    const good = path.join(directory, "good.json");
    const extra = path.join(directory, "extra.json");
    writeFileSync(good, JSON.stringify({ ...result, observations: { captionLogDwell: { pages: [page] } } }), "utf8");
    writeFileSync(extra, input === "failed" ? "invalid JSON" : JSON.stringify(result), "utf8");
    const run = spawnSync(process.execPath, ["bench/recount-gates.mjs", good, ...(input === "available" ? [] : [extra])], { encoding: "utf8" });
    expect(run.status).toBe(input === "failed" ? 1 : 0);
    if (input === "failed") expect(run.stderr).toContain("extra.json ERROR:");
    else expect(run.stderr).toBe("");
    const total = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1).slice("TOTAL ".length));
    expect(total.r1Audio).toMatchObject({ samples: 1, p50: 1321.315, p90: 1321.315,
      failedFiles: input === "failed" ? 1 : 0, unavailableFiles: input === "missing" ? 1 : 0,
      pass: input === "available" ? true : null });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
