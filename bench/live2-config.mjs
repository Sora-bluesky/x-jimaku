import { existsSync } from "node:fs";
import os from "node:os";
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

export function countRomanKeptInJapanese(pages) {
  return pages.flatMap(page => page.lines ?? [page.line0 ?? "", page.line1 ?? ""])
    .filter(line => /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(line))
    .reduce((count, line) => count + (line.match(/\bRoman\b/gu) ?? []).length, 0);
}

export function selectGatePages({ pages, lines = [], clauseTimings = [], replayStartedAtMs, allowLegacy = false }) {
  const byId = new Map();
  for (const line of lines ?? []) {
    const previous = byId.get(line.id);
    if (!previous || Date.parse(line.acceptedAt) < Date.parse(previous.acceptedAt)) byId.set(line.id, line);
  }
  const timings = new Map(clauseTimings.map(entry => [entry.data?.lineId, entry.data]));
  const timestampSources = {};
  let missing = 0;
  const kept = (pages ?? []).filter(page => {
    const sources = page.sources?.length ? page.sources : [null];
    const times = sources.map(source => {
      const line = byId.get(source?.id);
      let field;
      let time;
      if (source?.finalizedAt !== undefined || line?.finalizedAt !== undefined) {
        field = source?.finalizedAt !== undefined ? "sources.finalizedAt" : "lines.finalizedAt";
        time = Date.parse(source?.finalizedAt ?? line?.finalizedAt);
      } else if (allowLegacy) {
        const accepted = Date.parse(line?.acceptedAt);
        const elapsed = timings.get(source?.id)?.enqueueToTerminalMs;
        if (Number.isFinite(accepted)) {
          field = "lines.acceptedAt";
          time = accepted;
          if (Number.isFinite(elapsed) && elapsed >= 0) {
            field += "-clause.enqueueToTerminalMs";
            time -= elapsed;
          }
        } else {
          field = page.appearedAt !== undefined ? "pages.appearedAt" : "blocks.sampledAtMs";
          time = page.appearedAt !== undefined ? Date.parse(page.appearedAt) : page.sampledAtMs;
        }
      }
      if (Number.isFinite(time)) timestampSources[field] = (timestampSources[field] ?? 0) + 1;
      return time;
    });
    if (times.some(time => !Number.isFinite(time))) missing += 1;
    return Number.isFinite(replayStartedAtMs) && times.every(time => Number.isFinite(time) && time > replayStartedAtMs);
  });
  return { pages: kept, timestampSources, missing, excluded: (pages?.length ?? 0) - kept.length };
}

export function countQualityGates(pages) {
  const joined = pages.flatMap(page => page.lines ?? [page.line0 ?? "", page.line1 ?? ""]).join("\n");
  return {
    englishPassthrough: countEnglishPassthrough(pages),
    wrongSenseRoma: (joined.match(/ローマ(?!ン)/gu) ?? []).length,
    unresolvedPlaceholders: (joined.match(/%%/gu) ?? []).length,
    romanKept: (joined.match(/(?<![A-Za-z])Roman(?![A-Za-z])/gu) ?? []).length,
    romanKeptInJapanese: countRomanKeptInJapanese(pages),
  };
}

export function soakSentences(script, count) {
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error("--plamo-soak must be a positive integer");
  const sentences = script.match(/[^.!?]+[.!?]+|[^.!?]+$/gu)?.map(s => s.trim()).filter(Boolean) ?? [];
  if (!sentences.length) throw new Error("PLaMo soak script is empty");
  return Array.from({ length: count }, (_, i) => sentences[i % sentences.length]);
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
  const localAppData =
    typeof env.LOCALAPPDATA === "string" && env.LOCALAPPDATA.trim()
      ? env.LOCALAPPDATA
      : path.join(os.homedir(), "AppData", "Local");
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
    backend: "plamo",
    plamoModel: "0.8b",
    plamoSoak: null,
    // null keeps the product's own timing path. A policy is sent only when a flag asks for one.
    dwellPolicy: null,
    // Absence of a display flag means both layouts. One configuration is
    // not evidence for the other.
    displayMode: "both",
    showOriginal: false,
    durationSeconds: 95,
    chromePath:
      chromeFromEnvironment
      ?? path.join(localAppData, "Google", "Chrome SxS", "Application", "chrome.exe"),
    profile:
      profileFromEnvironment
      ?? path.join(os.tmpdir(), "x-jimaku-builtin-ai-nano"),
    extension: path.join(root, "dist"),
  };
  let sawShowOriginal = false;
  let sawNoShowOriginal = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    const dwellKey = {
      "--dwell-rate": "dwellRate",
      "--dwell-floor-ms": "dwellFloorMs",
      "--dwell-accel-rate": "dwellAccelRate",
      "--dwell-accel-floor-ms": "dwellAccelFloorMs",
    }[flag];
    if (dwellKey) {
      const number = Number(value);
      if (value === undefined || value.trim() === "" || !Number.isFinite(number) || number < 0) {
        throw new Error(`${flag} must be a finite non-negative number (rate 0 disables length-based dwell)`);
      }
      options.dwellPolicy ??= { dwellRate: 0, dwellFloorMs: 1500, dwellAccelRate: 0, dwellAccelFloorMs: 1000 };
      options.dwellPolicy[dwellKey] = number;
      i += 1;
      continue;
    }
    if (flag === "--show-original") {
      sawShowOriginal = true;
      continue;
    }
    if (flag === "--no-show-original") {
      sawNoShowOriginal = true;
      continue;
    }

    if (flag === "--case") { options.caseName = value; i += 1; }
    else if (flag === "--model") { options.model = value; i += 1; }
    else if (flag === "--backend") { options.backend = value; i += 1; }
    else if (flag === "--plamo-soak") { options.plamoSoak = Number(value); i += 1; }
    else if (flag === "--plamo-model") { options.plamoModel = value; i += 1; }
    else if (flag === "--duration") { options.durationSeconds = Number(value); i += 1; }
    else if (flag === "--chrome") { options.chromePath = value; i += 1; }
    else if (flag === "--profile") { options.profile = value; i += 1; }
    else if (flag === "--extension") { options.extension = path.resolve(value); i += 1; }
    else if (flag === "--help") { options.help = true; }
  }
  if (options.plamoSoak !== null) options.backend = "plamo";
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

export const ALLOWED_BACKENDS = ["plamo"];
export const ALLOWED_PLAMO_MODELS = ["0.8b", "2b", "8b"];

export function live2ProfilePolicy() {
  return {
    directoryName: "x-jimaku-bench-plamo",
    reset: false,
  };
}

export function live2BuildAction({ workerBuild, expectedBuild, profileReset }) {
  if (workerBuild === expectedBuild) return "reuse";
  if (!profileReset) return "reset-and-retry";
  return "fail";
}

export function createPlamoReadiness({ timeoutMs, startedAtMs }) {
  let lastProgressAtMs = startedAtMs;
  let lastProgressKind = "wait-started";
  let loadedBytes = 0;
  let hashedBytes = 0;
  let pathReady = false;
  let capturePhase = 0;
  let asrPercent = -1;
  let chipPercent = -1;
  let chipWarmup = false;
  const asrLogs = new Set();
  return (snapshot, nowMs) => {
    let progressed = false;
    const progress = kind => {
      progressed = true;
      lastProgressKind = kind;
      lastProgressAtMs = nowMs;
    };
    if (snapshot.loadedBytes > loadedBytes) progress("plamo-download");
    if (snapshot.hashedBytes > hashedBytes) progress("plamo-sha256");
    if (snapshot.path === "plamo" && !pathReady) progress("plamo-ready");
    loadedBytes = Math.max(loadedBytes, snapshot.loadedBytes ?? 0);
    hashedBytes = Math.max(hashedBytes, snapshot.hashedBytes ?? 0);
    pathReady ||= snapshot.path === "plamo";

    const captureRunning = snapshot.captureState == null
      ? snapshot.running === true
      : snapshot.captureState.status === "running";
    const phase = { starting: 1, loadingModel: 2, running: 3 }[snapshot.captureState?.status]
      ?? (captureRunning ? 3 : 0);
    if (phase > capturePhase) {
      capturePhase = phase;
      progress("capture-state");
    }
    if (Number.isFinite(snapshot.captureState?.progress) && snapshot.captureState.progress > asrPercent) {
      asrPercent = snapshot.captureState.progress;
      progress("asr-progress");
    }
    const chip = snapshot.overlayChipText ?? "";
    const percent = /字幕 準備中[^\d]*(\d+)%/u.exec(chip);
    if (percent && Number(percent[1]) > chipPercent) {
      chipPercent = Number(percent[1]);
      progress("overlay-asr-progress");
    }
    if (chip.includes("ウォームアップ") && !chipWarmup) {
      chipWarmup = true;
      progress("asr-warmup");
    }
    if (snapshot.asrProgress) {
      const key = JSON.stringify(snapshot.asrProgress);
      if (!asrLogs.has(key)) {
        asrLogs.add(key);
        progress("asr-log");
      }
    }
    const plamoReady = snapshot.path === "plamo";
    const unmet = [
      ...(!plamoReady ? ["PLaMo ready"] : []),
      ...(!captureRunning ? ["capture running"] : []),
    ];
    const observed = { ready: unmet.length === 0, progressed, plamoReady, captureRunning,
      lastProgressKind, lastProgressAtMs };
    const fail = reason => {
      const error = new Error(`${reason}; unmet: ${unmet.join(", ")} (path: ${snapshot.path ?? "pending"}, capture state: ${JSON.stringify(snapshot.captureState ?? { running: snapshot.running ?? false })}, overlay chip: ${JSON.stringify(chip)}, downloaded: ${loadedBytes} bytes, hashed: ${hashedBytes} bytes, last progress: ${lastProgressKind} at ${lastProgressAtMs}ms, elapsed since progress: ${nowMs - lastProgressAtMs}ms)`);
      error.readiness = { ...snapshot, ...observed, observedAtMs: nowMs };
      throw error;
    };
    if (snapshot.path === "none") {
      fail("PLaMo initialization failed (translation path: none)");
    }
    if (!captureRunning && snapshot.captureState?.status === "error") {
      fail("capture running failed");
    }
    if (!observed.ready && nowMs - lastProgressAtMs >= timeoutMs) {
      const condition = !plamoReady ? "PLaMo" : "capture running";
      fail(`${condition} readiness stalled: no download, sha256 or initialization progress within ${timeoutMs}ms`);
    }
    return observed;
  };
}

export function countEnglishPassthrough(pageBlocks) {
  const japanese = /[\u3040-\u30ff\u4e00-\u9fff]/u;
  return pageBlocks.reduce((count, block) => count + (
    block.lines ?? [block.line0, block.line1]
  ).filter((line) => typeof line === "string" && line.trim() !== "" && !japanese.test(line)).length, 0);
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
      meta: report.meta,
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
