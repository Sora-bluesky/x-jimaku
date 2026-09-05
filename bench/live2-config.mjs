import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

export function checkBuildInfo({ buildInfo, sourceHash, versionName }) {
  if (
    buildInfo === null
    || typeof buildInfo !== "object"
    || Array.isArray(buildInfo)
    || typeof buildInfo.revision !== "string"
    || typeof buildInfo.dirty !== "boolean"
    || typeof buildInfo.builtAt !== "string"
    || !Number.isFinite(Date.parse(buildInfo.builtAt))
    || typeof buildInfo.versionName !== "string"
    || typeof buildInfo.nameTableHash !== "string"
  ) {
    return {
      ok: false,
      reason: "dist/build-info.json is missing; run npm run build",
    };
  }
  // A build-info.json left over from an interrupted build can outlive the
  // manifest it was written with; the loaded worker was verified against
  // manifest.version_name, so build attribution must match that too.
  if (
    typeof versionName === "string"
    && buildInfo.versionName !== versionName
  ) {
    return {
      ok: false,
      reason:
        `dist/build-info.json is from a different build (${buildInfo.versionName}) than dist/manifest.json (${versionName}); run npm run build`,
    };
  }
  if (buildInfo.nameTableHash !== sourceHash) {
    return {
      ok: false,
      reason:
        "name table changed after the last build (src/offscreen/glossary.data.ts); run npm run build",
    };
  }
  return { ok: true };
}

export function cutCaptionLog({ pages, lines, drops, replayStartedAtMs }) {
  function cut(entries, timeField) {
    if (!Array.isArray(entries)) {
      return { entries: null, unparsed: null };
    }
    let unparsed = 0;
    const kept = entries.filter((entry) => {
      const time = Date.parse(entry?.[timeField]);
      if (!Number.isFinite(time)) {
        unparsed += 1;
        return false;
      }
      return time >= replayStartedAtMs;
    });
    return { entries: kept, unparsed };
  }

  const pageCut = cut(pages, "appearedAt");
  const lineCut = cut(lines, "acceptedAt");
  const dropCut = cut(drops, "droppedAt");
  return {
    pages: pageCut.entries,
    pagesUnparsed: pageCut.unparsed,
    lines: lineCut.entries,
    linesUnparsed: lineCut.unparsed,
    drops: dropCut.entries,
    dropsUnparsed: dropCut.unparsed,
  };
}

export function parseArgs(argv, env = process.env) {
  const chromeFromEnvironment =
    typeof env.BENCH_CHROME === "string"
    && env.BENCH_CHROME.trim()
      ? env.BENCH_CHROME.trim()
      : null;
  const profileFromEnvironment =
    typeof env.BENCH_PROFILE === "string"
    && env.BENCH_PROFILE.trim()
      ? env.BENCH_PROFILE.trim()
      : null;
  const options = {
    caseName: "tts2",
    model: "base",
    backend: "prompt-api",
    // Absence of a display flag means both layouts. One configuration is
    // not evidence for the other.
    displayMode: "both",
    showOriginal: false,
    keepProfileDir: false,
    durationSeconds: 95,
    chromePath:
      chromeFromEnvironment
      ?? "C:\\Users\\sorab\\AppData\\Local\\Google\\Chrome SxS\\Application\\chrome.exe",
    profile:
      profileFromEnvironment
      ?? "C:\\Users\\sorab\\AppData\\Local\\Temp\\x-jimaku-builtin-ai-nano",
    extension: path.join(root, "dist"),
  };
  let sawShowOriginal = false;
  let sawNoShowOriginal = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--show-original") {
      sawShowOriginal = true;
      continue;
    }
    if (flag === "--no-show-original") {
      sawNoShowOriginal = true;
      continue;
    }
    if (flag === "--keep-profile-dir") {
      options.keepProfileDir = true;
      continue;
    }

    if (flag === "--case") { options.caseName = value; i += 1; }
    else if (flag === "--model") { options.model = value; i += 1; }
    else if (flag === "--backend") { options.backend = value; i += 1; }
    else if (flag === "--duration") { options.durationSeconds = Number(value); i += 1; }
    else if (flag === "--chrome") { options.chromePath = value; i += 1; }
    else if (flag === "--profile") { options.profile = value; i += 1; }
    else if (flag === "--extension") { options.extension = path.resolve(value); i += 1; }
    else if (flag === "--help") { options.help = true; }
  }
  if (sawShowOriginal && sawNoShowOriginal) {
    options.displayModeError =
      "pass only one of --show-original and --no-show-original";
  } else if (sawShowOriginal) {
    options.displayMode = "original-on";
    options.showOriginal = true;
  } else if (sawNoShowOriginal) {
    options.displayMode = "original-off";
    options.showOriginal = false;
  }
  return options;
}

export function resolveDisplayRuns(options) {
  if (options.displayMode === "both") {
    return [
      { displayConfig: "original-off", showOriginal: false },
      { displayConfig: "original-on", showOriginal: true },
    ];
  }
  if (
    options.displayMode === "original-on"
    || options.displayMode === "original-off"
  ) {
    return [
      {
        displayConfig: options.displayMode,
        showOriginal: options.displayMode === "original-on",
      },
    ];
  }
  throw new Error(`unknown displayMode ${options.displayMode}`);
}

export function argvForDisplayRun(argv, displayConfig) {
  if (
    displayConfig !== "original-on"
    && displayConfig !== "original-off"
  ) {
    throw new Error(
      `argvForDisplayRun needs a single displayConfig, got ${displayConfig}`,
    );
  }
  const stripped = [];
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--show-original" || flag === "--no-show-original") {
      continue;
    }
    stripped.push(flag);
  }
  stripped.push(
    displayConfig === "original-on"
      ? "--show-original"
      : "--no-show-original",
  );
  return stripped;
}

export function annotateDisplayMeta(gates, { displayConfig, displayCoverage }) {
  const rest = { ...gates };
  delete rest.displayConfig;
  delete rest.showOriginal;
  delete rest.displayCoverage;
  return {
    displayConfig,
    showOriginal: displayConfig === "original-on",
    displayCoverage,
    ...rest,
  };
}

export function finalizeGates(result) {
  // Captured counts remain evidence of failed display gates; error marks the run.
  if (result.gates.lines !== 0) {
    return result;
  }
  const identityFields = new Set([
    "displayConfig",
    "showOriginal",
    "displayCoverage",
  ]);
  return {
    ...result,
    gates: Object.fromEntries(
      Object.entries(result.gates).map(([key, value]) => [
        key,
        identityFields.has(key) ? value : null,
      ]),
    ),
    gatesSuppressed: "no captured lines",
  };
}

export function coverageNote(displayCoverage, displayConfig) {
  if (displayCoverage !== "single") {
    return undefined;
  }
  const other =
    displayConfig === "original-on"
      ? "original-off"
      : "original-on";
  return `covers ${displayConfig} only; not evidence for ${other}`;
}

function parsePrintedJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return null;
    }
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

export function parseChildReport(stdout, status, displayConfig) {
  const parsed = parsePrintedJson(stdout);
  const showOriginal = displayConfig === "original-on";
  const displayCoverage = "single";
  if (
    parsed === null
    || typeof parsed !== "object"
    || Array.isArray(parsed)
  ) {
    return {
      displayConfig,
      showOriginal,
      displayCoverage,
      error: `no result JSON from ${displayConfig} (exit ${status})`,
      gates: annotateDisplayMeta(
        {},
        { displayConfig, displayCoverage },
      ),
    };
  }
  return {
    ...parsed,
    displayConfig,
    showOriginal,
    displayCoverage,
    gates: annotateDisplayMeta(parsed.gates ?? {}, {
      displayConfig,
      displayCoverage,
    }),
  };
}

function formatConfigError(displayConfig, error) {
  if (typeof error !== "string" || error.length === 0) {
    return null;
  }
  if (error.startsWith("display gate ")) {
    return `display gate (${displayConfig}) ${error.slice("display gate ".length)}`;
  }
  return `${displayConfig}: ${error}`;
}

export function combineDisplayReports(reports) {
  const configs = reports.map((report) => {
    if (!report.displayConfig) {
      throw new Error("combineDisplayReports: report missing displayConfig");
    }
    return {
      displayConfig: report.displayConfig,
      showOriginal:
        report.showOriginal ?? report.displayConfig === "original-on",
      outFile: report.outFile,
      gates: report.gates,
      gatesSuppressed: report.gatesSuppressed,
      observations: report.observations,
      error: report.error,
    };
  });
  const errors = reports
    .map((report) => formatConfigError(report.displayConfig, report.error))
    .filter(Boolean);
  return {
    displayCoverage: "both",
    configs,
    error: errors.length > 0 ? errors.join("; ") : undefined,
  };
}

export function missingMediaError(mediaFile, { localOnly = false } = {}) {
  if (localOnly) {
    return `missing local-only media file: ${mediaFile}`;
  }
  return `missing media file: ${mediaFile}`;
}

export function assertCaseMedia(definition) {
  if (existsSync(definition.mediaFile)) {
    return;
  }
  throw new Error(
    missingMediaError(definition.mediaFile, {
      localOnly: definition.localOnly === true,
    }),
  );
}

export function countPageLineReuse(pageBlocks) {
  let reuse = 0;
  for (let index = 1; index < pageBlocks.length; index += 1) {
    const previous = pageBlocks[index - 1];
    const block = pageBlocks[index];
    if (
      previous.cueId === ""
      || block.cueId === ""
      || previous.cueId !== block.cueId
      || previous.pageId === block.pageId
    ) {
      continue;
    }
    const previousLines = new Set(
      (previous.lines ?? [previous.line0, previous.line1]).filter(
        (line) => line !== "" && line != null,
      ),
    );
    const currentLines = (
      block.lines ?? [block.line0, block.line1]
    ).filter((line) => line !== "" && line != null);
    if (currentLines.some((line) => previousLines.has(line))) {
      reuse += 1;
    }
  }
  return reuse;
}
