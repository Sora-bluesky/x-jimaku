import { readFileSync } from "node:fs";
import path from "node:path";
import { countQualityGates, selectGatePages } from "./live2-config.mjs";
import { recountR1Audio, summarizeR1Audio } from "./r1-audio.mjs";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("Usage: node bench/recount-gates.mjs <result.json>...");
  process.exitCode = 1;
} else {
  const totals = countQualityGates([]);
  const audioValues = [];
  let unmatchedPages = 0;
  let failedFiles = 0;
  let unavailableFiles = 0;
  for (const file of files) {
    try {
      const result = JSON.parse(readFileSync(file, "utf8"));
      const replayStartedAtMs = Date.parse(result.replayStartedAt);
      if (!Number.isFinite(replayStartedAtMs)) throw new Error("missing/invalid replayStartedAt");
      const pages = result.display?.pages ?? result.display?.blocks;
      if (!Array.isArray(pages)) throw new Error("missing display pages/blocks");
      const window = selectGatePages({ pages, lines: result.display?.lines,
        clauseTimings: result.diagnostics?.clauseTimings ?? result.diagnostics?.devLog?.filter(entry => entry.data?.kind === "clause-timing"),
        replayStartedAtMs, allowLegacy: result.gateWindow === undefined });
      const gates = countQualityGates(window.pages);
      let r1Audio;
      if (Array.isArray(result.observations?.captionLogDwell?.pages)) {
        const { pages: audioPages, ...summary } = recountR1Audio(result);
        r1Audio = summary;
        audioValues.push(...audioPages.map(page => page.latencyMs));
        unmatchedPages += r1Audio.unmatchedPages;
      } else {
        unavailableFiles++;
        r1Audio = { ...summarizeR1Audio([]), available: false,
          reason: "missing observations.captionLogDwell.pages for measured-window audio latency" };
      }
      for (const key of Object.keys(totals)) totals[key] += gates[key];
      console.log(`${path.basename(file)} ${JSON.stringify({ ...gates, pages: window.pages.length, excluded: window.excluded,
        missing: window.missing, timestampSources: window.timestampSources,
        r1Audio })}`);
    } catch (error) {
      console.error(`${path.basename(file)} ERROR: ${error.message}`);
      process.exitCode = 1;
      failedFiles++;
    }
  }
  console.log(`TOTAL ${JSON.stringify({ ...totals,
    r1Audio: { ...summarizeR1Audio(audioValues), unmatchedPages,
      files: files.length, failedFiles, unavailableFiles,
      ...(failedFiles || unavailableFiles ? { pass: null } : {}) } })}`);
}
