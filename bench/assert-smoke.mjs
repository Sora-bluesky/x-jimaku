import {
  appendFile,
  readFile,
  readdir,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const benchDirectory = dirname(fileURLToPath(import.meta.url));
const resultsDirectory = join(benchDirectory, "results");

function requireFiniteNumber(label, value) {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
}

function displayValue(value) {
  return value === null ? "null" : String(value);
}

try {
  const entries = await readdir(resultsDirectory, { withFileTypes: true });
  const jsonFiles = entries.filter(
    (entry) => entry.isFile() && entry.name.endsWith(".json"),
  );

  if (jsonFiles.length === 0) {
    throw new Error(`No result JSON found in ${resultsDirectory}`);
  }

  const candidates = await Promise.all(
    jsonFiles.map(async (entry) => ({
      name: entry.name,
      mtimeMs: (await stat(join(resultsDirectory, entry.name))).mtimeMs,
    })),
  );

  candidates.sort(
    (left, right) =>
      right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name),
  );

  const latest = candidates[0];
  const resultPath = join(resultsDirectory, latest.name);
  let result;

  try {
    result = JSON.parse(await readFile(resultPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse ${latest.name}: ${error.message}`);
  }

  if (typeof result?.error === "string" && result.error.length > 0) {
    throw new Error(`latest result carries an error: ${result.error}`);
  }

  const metrics = result?.metrics;
  if (metrics === null || typeof metrics !== "object" || Array.isArray(metrics)) {
    throw new Error("metrics must be an object");
  }

  requireFiniteNumber("metrics.wer", metrics.wer);
  requireFiniteNumber("metrics.werFiltered", metrics.werFiltered);
  requireFiniteNumber("metrics.fragmentRate", metrics.fragmentRate);

  const clauseCount = metrics.clauseStats?.count;
  requireFiniteNumber("metrics.clauseStats.count", clauseCount);
  if (clauseCount < 1) {
    throw new Error("metrics.clauseStats.count must be at least 1");
  }

  const rows = [
    ["wer", metrics.wer],
    ["werFiltered", metrics.werFiltered],
    ["fragmentRate", metrics.fragmentRate],
    ["clauseStats.count", clauseCount],
    ["properNounRecall", metrics.properNounRecall],
  ];

  const summary = [
    "## Bench smoke",
    "",
    `Result: \`${latest.name}\``,
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    ...rows.map(
      ([label, value]) => `| ${label} | ${displayValue(value)} |`,
    ),
    "",
  ].join("\n");

  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summary, "utf8");
  }

  console.log(`PASS: ${latest.name}`);
  console.log(summary);
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}
