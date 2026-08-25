import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

import { computeMetrics } from "./metrics.mjs";
import { startBenchServer } from "./serve.mjs";

const BENCH_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.dirname(BENCH_DIRECTORY);
const TRACE_ENABLED = process.argv.includes("--trace");
const traceLines = [];
const DIST_DIRECTORY = path.join(PROJECT_ROOT, "dist");
const RESULTS_DIRECTORY = path.join(BENCH_DIRECTORY, "results");
const WORK_DIRECTORY = path.join(BENCH_DIRECTORY, "work");
const REFS_DIRECTORY = path.join(BENCH_DIRECTORY, "refs");
const PUPPETEER_CHROME_DIRECTORY = path.join(
  homedir(),
  ".cache",
  "puppeteer",
  "chrome",
);

const ALLOWED_MODELS = ["tiny", "base", "small", "turbo"];
const DEFAULT_MODEL = "base";
const DEFAULT_DURATION_SECONDS = 90;
const DEFAULT_BROWSER_TIMEOUT_MS = 30_000;
const SAMPLE_INTERVAL_MS = 500;

const delay = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

class ArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArgumentError";
    this.exitCode = 2;
  }
}

function parseArguments(argv) {
  const options = {
    caseName: null,
    chromePath: null,
    durationSeconds: DEFAULT_DURATION_SECONDS,
    help: false,
    model: DEFAULT_MODEL,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }

    if (argument === "--trace") {
      continue;
    }

    const value = argv[index + 1];

    if (argument === "--case") {
      if (!value) {
        throw new ArgumentError("--case requires tts or tibo");
      }

      options.caseName = value;
      index += 1;
      continue;
    }

    if (argument === "--chrome") {
      if (!value) {
        throw new ArgumentError("--chrome requires an executable path");
      }

      options.chromePath = value;
      index += 1;
      continue;
    }

    if (argument === "--model") {
      if (!value) {
        throw new ArgumentError("--model requires a value");
      }

      options.model = value;
      index += 1;
      continue;
    }

    if (argument === "--duration") {
      if (!value) {
        throw new ArgumentError(
          "--duration requires a number of seconds",
        );
      }

      options.durationSeconds = Number(value);
      index += 1;
      continue;
    }

    throw new ArgumentError(`Unknown argument: ${argument}`);
  }

  if (options.help) {
    return options;
  }

  if (options.caseName !== "tts" && options.caseName !== "tibo") {
    throw new ArgumentError("--case must be tts or tibo");
  }

  if (
    !Number.isFinite(options.durationSeconds)
    || options.durationSeconds <= 0
  ) {
    throw new ArgumentError("--duration must be a positive number");
  }

  if (!ALLOWED_MODELS.includes(options.model)) {
    throw new ArgumentError(
      `--model must be one of: ${ALLOWED_MODELS.join(", ")}`,
    );
  }

  return options;
}

function printUsage() {
  console.log(
    "Usage: node bench/run-bench.mjs --case tts|tibo "
      + "[--model tiny|base|small|turbo] [--duration 90] "
      + "[--chrome <path>]",
  );
}

function isFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function normalizeExecutablePath(value) {
  const trimmed = value.trim();

  if (trimmed === "~") {
    return homedir();
  }

  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(homedir(), trimmed.slice(2));
  }

  return path.resolve(trimmed);
}

function versionParts(value) {
  const matches = value.match(/\d+(?:\.\d+)+/g);

  if (!matches) {
    return [];
  }

  return matches[matches.length - 1]
    .split(".")
    .map((part) => Number(part));
}

function compareVersionPartsDescending(left, right) {
  const count = Math.max(left.length, right.length);

  for (let index = 0; index < count; index += 1) {
    const leftPart = left[index] ?? 0;
    const rightPart = right[index] ?? 0;

    if (leftPart !== rightPart) {
      return rightPart - leftPart;
    }
  }

  return 0;
}

function readDirectoryEntries(directory) {
  try {
    return readdirSync(directory, {
      withFileTypes: true,
    });
  } catch {
    return [];
  }
}

function chromeExecutableWithin(browserDirectory) {
  if (process.platform === "win32") {
    return path.join(browserDirectory, "chrome.exe");
  }

  if (process.platform === "darwin") {
    return path.join(
      browserDirectory,
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing",
    );
  }

  if (process.platform === "linux") {
    return path.join(browserDirectory, "chrome");
  }

  return null;
}

function matchesPlatformBrowserDirectory(name) {
  if (process.platform === "win32") {
    return name === "chrome-win64";
  }

  if (process.platform === "darwin") {
    return name.startsWith("chrome-mac");
  }

  if (process.platform === "linux") {
    return name.startsWith("chrome-linux");
  }

  return false;
}

function findNewestCachedChrome() {
  const candidates = [];

  for (const releaseEntry of readDirectoryEntries(
    PUPPETEER_CHROME_DIRECTORY,
  )) {
    if (!releaseEntry.isDirectory()) {
      continue;
    }

    const releaseDirectory = path.join(
      PUPPETEER_CHROME_DIRECTORY,
      releaseEntry.name,
    );

    for (const browserEntry of readDirectoryEntries(releaseDirectory)) {
      if (
        !browserEntry.isDirectory()
        || !matchesPlatformBrowserDirectory(browserEntry.name)
      ) {
        continue;
      }

      const executablePath = chromeExecutableWithin(
        path.join(releaseDirectory, browserEntry.name),
      );

      if (!executablePath || !isFile(executablePath)) {
        continue;
      }

      candidates.push({
        executablePath,
        modifiedAt: statSync(executablePath).mtimeMs,
        version: versionParts(releaseEntry.name),
      });
    }
  }

  candidates.sort((left, right) => {
    const versionOrder = compareVersionPartsDescending(
      left.version,
      right.version,
    );

    if (versionOrder !== 0) {
      return versionOrder;
    }

    if (left.modifiedAt !== right.modifiedAt) {
      return right.modifiedAt - left.modifiedAt;
    }

    return left.executablePath.localeCompare(right.executablePath);
  });

  return candidates[0]?.executablePath ?? null;
}

function resolveProvidedChrome(value, source) {
  const executablePath = normalizeExecutablePath(value);

  if (!isFile(executablePath)) {
    throw new Error(
      `${source} does not point to a Chrome executable: ${executablePath}. `
        + "Pass a valid executable path with --chrome <path>.",
    );
  }

  return executablePath;
}

function resolveChromeExecutable(chromeArgument) {
  if (typeof chromeArgument === "string" && chromeArgument.trim()) {
    return resolveProvidedChrome(chromeArgument, "--chrome");
  }

  if (
    typeof process.env.BENCH_CHROME === "string"
    && process.env.BENCH_CHROME.trim()
  ) {
    return resolveProvidedChrome(
      process.env.BENCH_CHROME,
      "BENCH_CHROME",
    );
  }

  const cachedChrome = findNewestCachedChrome();

  if (cachedChrome) {
    return cachedChrome;
  }

  throw new Error(
    "Chrome for Testing was not found in the Puppeteer cache. "
      + "Pass its executable path with --chrome <path> or set BENCH_CHROME.",
  );
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function loadCase(caseName) {
  if (caseName === "tts") {
    const mediaFile = path.join(REFS_DIRECTORY, "tts-speech.wav");
    const referenceFile = path.join(REFS_DIRECTORY, "tts-script.txt");

    if (!existsSync(mediaFile)) {
      throw new Error(`Missing TTS media file: ${mediaFile}`);
    }

    if (!existsSync(referenceFile)) {
      throw new Error(`Missing TTS reference file: ${referenceFile}`);
    }

    return {
      mediaFile,
      properNouns: [],
      reference: readFileSync(referenceFile, "utf8").trim(),
      referenceSource: "bench/refs/tts-script.txt",
    };
  }

  const metadataFile = path.join(REFS_DIRECTORY, "tibo-clip.json");
  const mediaFile = path.join(WORK_DIRECTORY, "tibo-clip.mp4");

  if (!existsSync(metadataFile)) {
    throw new Error(`Missing Tibo metadata file: ${metadataFile}`);
  }

  const metadata = readJson(metadataFile);

  if (
    typeof metadata.source !== "string"
    || typeof metadata.transcript !== "string"
    || !Array.isArray(metadata.properNouns)
  ) {
    throw new Error(
      "bench/refs/tibo-clip.json must contain source, transcript, and properNouns",
    );
  }

  if (!existsSync(mediaFile)) {
    const source = JSON.stringify(metadata.source);
    console.log("bench/work/tibo-clip.mp4 is not present.");
    console.log("Fetch it locally and do not commit the downloaded clip:");
    console.log(
      "yt-dlp --remux-video mp4 "
        + '-o "bench/work/tibo-clip.%(ext)s" '
        + source,
    );

    return {
      missingLocalMedia: true,
    };
  }

  return {
    mediaFile,
    properNouns: metadata.properNouns,
    reference: metadata.transcript.trim(),
    referenceSource: "bench/refs/tibo-clip.json",
    source: metadata.source,
  };
}

function cleanEnglishText(value) {
  if (typeof value !== "string") {
    return "";
  }

  const lines = value
    .replace(/\u00a0/g, " ")
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(?:final|interim|committed|pending)$/i.test(line))
    .map((line) => line.replace(
      /^(?:en|english|final|committed)\s*[:\-–—·]\s*/i,
      "",
    ));

  let candidate = lines.find((line) => /[a-z]/i.test(line)) ?? "";

  if (!candidate) {
    return "";
  }

  const japaneseIndex = candidate.search(
    /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,
  );

  if (japaneseIndex > 0 && /[a-z]/i.test(candidate.slice(0, japaneseIndex))) {
    candidate = candidate.slice(0, japaneseIndex);
  }

  return candidate
    .replace(/\s*(?:=>|→|｜|\|)\s*$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function recordFinality(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return {
      final: false,
      interim: false,
    };
  }

  let final = false;
  let interim = false;

  for (const key of ["final", "isFinal", "committed", "isCommitted"]) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      continue;
    }

    const value = record[key];

    if (value === true || value === "true") {
      final = true;
    }

    if (value === false || value === "false") {
      interim = true;
    }
  }

  for (const key of ["status", "state", "phase", "kind", "type"]) {
    const value = record[key];

    if (typeof value !== "string") {
      continue;
    }

    if (/^(?:final|committed|complete|completed|stable)$/i.test(value)) {
      final = true;
    }

    if (/^(?:interim|partial|draft|pending)$/i.test(value)) {
      interim = true;
    }
  }

  return {
    final,
    interim,
  };
}

function recordEnglishText(record) {
  for (const key of [
    "english",
    "en",
    "sourceText",
    "recognizedText",
    "recognitionText",
    "transcript",
    "text",
    "finalText",
  ]) {
    const text = cleanEnglishText(record?.[key]);

    if (text) {
      return {
        field: key,
        text,
      };
    }
  }

  return null;
}

function recognitionPath(pathParts) {
  return /(recogn|transcript|utterance|clause|segment|cue|line)/i.test(
    pathParts.join("."),
  );
}

function extractFinalClausesFromSession(storage) {
  const results = [];
  const visited = new WeakSet();
  const textFields = new Set([
    "english",
    "en",
    "sourceText",
    "recognizedText",
    "recognitionText",
    "transcript",
    "text",
    "finalText",
  ]);
  const ignoredScalarFields = new Set([
    "status",
    "state",
    "phase",
    "kind",
    "type",
    "ja",
    "japanese",
    "translation",
  ]);

  function add(pathParts, text, record) {
    const identity = record && typeof record === "object"
      ? (
        record.id
        ?? record.segmentId
        ?? record.clauseId
        ?? record.cueId
        ?? record.sequence
        ?? record.index
      )
      : null;
    const pathKey = pathParts.join(".");
    const key = identity === null || identity === undefined
      ? pathKey
      : `${pathKey}:${identity}`;

    results.push({
      key,
      text,
    });
  }

  function visit(value, pathParts) {
    if (typeof value === "string") {
      const scalarKey = pathParts[pathParts.length - 1];

      if (
        recognitionPath(pathParts)
        && !ignoredScalarFields.has(scalarKey)
      ) {
        const text = cleanEnglishText(value);

        if (text) {
          add(pathParts, text, null);
        }
      }

      return;
    }

    if (!value || typeof value !== "object") {
      return;
    }

    if (visited.has(value)) {
      return;
    }

    visited.add(value);

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        visit(item, [...pathParts, String(index)]);
      });
      return;
    }

    const finality = recordFinality(value);
    const textEntry = recordEnglishText(value);

    if (
      textEntry
      && !finality.interim
      && (finality.final || recognitionPath(pathParts))
    ) {
      add(pathParts, textEntry.text, value);
    }

    for (const [key, child] of Object.entries(value)) {
      if (textFields.has(key)) {
        continue;
      }

      visit(child, [...pathParts, key]);
    }
  }

  visit(storage, []);
  return results;
}

class ClauseCollector {
  constructor() {
    this.sessionClauses = new Map();
    this.optionsClauses = new Map();
    this.revision = 0;
  }

  commit(store, key, text, ja = "") {
    const cleaned = cleanEnglishText(text);
    const cleanedJa = typeof ja === "string" ? ja.trim() : "";

    if (!cleaned) {
      return;
    }

    if (!store.has(key)) {
      store.set(key, {
        ja: cleanedJa,
        text: cleaned,
      });
      return;
    }

    const existing = store.get(key);

    if (existing.text === cleaned) {
      if (cleanedJa && existing.ja !== cleanedJa) {
        store.set(key, {
          ja: cleanedJa,
          text: cleaned,
        });
      }

      return;
    }

    this.revision += 1;
    store.set(`${key}:revision-${this.revision}`, {
      ja: cleanedJa,
      text: cleaned,
    });
  }

  ingestSession(records) {
    for (const record of records) {
      this.commit(this.sessionClauses, record.key, record.text);
    }
  }

  ingestOptions(rows, captureStopped = false) {
    for (const row of rows) {
      if (row.explicitInterim) {
        continue;
      }

      const isFinal = row.explicitFinal
        || row.index < rows.length - 1
        || captureStopped;

      if (isFinal) {
        this.commit(this.optionsClauses, row.key, row.text, row.ja);
      }
    }
  }

  resultFrom(store, source) {
    const entries = [...store.values()];

    return {
      clauses: entries.map((entry) => entry.text),
      jaClauses: entries.map((entry) => entry.ja),
      source,
    };
  }

  result() {
    if (this.sessionClauses.size > 0) {
      return this.resultFrom(
        this.sessionClauses,
        "chrome.storage.session",
      );
    }

    return this.resultFrom(
      this.optionsClauses,
      "options.html#recognition-log",
    );
  }
}

async function readSessionStorage(browser) {
  return evaluateInServiceWorker(
    browser,
    async () => chrome.storage.session.get(null),
  );
}

let lastTracedCaptureState = "";

function traceCaptureState(state) {
  if (!TRACE_ENABLED) {
    return;
  }

  const snapshot = JSON.stringify(state ?? null);

  if (snapshot !== lastTracedCaptureState) {
    lastTracedCaptureState = snapshot;
    traceLines.push(`[bench-state] ${new Date().toISOString()} ${snapshot}`);
  }
}

function findCaptureState(storage) {
  const state = findCaptureStateRaw(storage);
  traceCaptureState(state);
  return state;
}

function findCaptureStateRaw(storage) {
  if (Object.prototype.hasOwnProperty.call(storage, "m1.captureState")) {
    return storage["m1.captureState"];
  }

  for (const [key, value] of Object.entries(storage)) {
    if (/captureState$/i.test(key)) {
      return value;
    }
  }

  return undefined;
}

function isRunningCaptureState(value) {
  if (typeof value === "string") {
    return /^(?:running|capturing|active|started)$/i.test(value);
  }

  if (!value || typeof value !== "object") {
    return false;
  }

  for (const key of ["running", "capturing", "isRunning", "isCapturing"]) {
    if (value[key] === true || value[key] === "true") {
      return true;
    }
  }

  for (const key of ["status", "state", "phase", "mode"]) {
    if (
      typeof value[key] === "string"
      && /^(?:running|capturing|active|started)$/i.test(value[key])
    ) {
      return true;
    }
  }

  return Object.values(value).some((child) => isRunningCaptureState(child));
}

async function waitForCaptureState(browser, statuses, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastState;

  while (Date.now() < deadline) {
    const storage = await readSessionStorage(browser);
    lastState = findCaptureState(storage);

    if (lastState && statuses.includes(lastState.status)) {
      return;
    }

    await delay(250);
  }

  throw new Error(
    `Capture did not reach ${statuses.join("/")}: ${JSON.stringify(lastState)}`,
  );
}

async function waitForCaptureRunning(browser) {
  const deadline = Date.now() + 240_000;
  let lastState;

  while (Date.now() < deadline) {
    const storage = await readSessionStorage(browser);
    lastState = findCaptureState(storage);

    if (isRunningCaptureState(lastState)) {
      return;
    }

    await delay(250);
  }

  throw new Error(
    `Capture did not enter a running state: ${JSON.stringify(lastState)}`,
  );
}

async function waitForCaptureStopped(browser) {
  const deadline = Date.now() + 240_000;

  while (Date.now() < deadline) {
    const storage = await readSessionStorage(browser);
    const state = findCaptureState(storage);

    if (state === undefined || !isRunningCaptureState(state)) {
      return;
    }

    await delay(250);
  }

  throw new Error("Capture did not leave the running state");
}

async function freshServiceWorker(browser) {
  const target = await browser.waitForTarget(
    (t) => t.type() === "service_worker" && t.url().includes("background.js"),
    { timeout: 30_000 },
  );
  const worker = await target.worker();
  if (!worker) throw new Error("service worker target has no worker handle");
  return worker;
}

async function evaluateInServiceWorker(browser, fn, ...args) {
  try {
    const worker = await freshServiceWorker(browser);
    return await worker.evaluate(fn, ...args);
  } catch (error) {
    // The SW may have restarted (install/idle suspend); one fresh retry.
    await delay(500);
    const worker = await freshServiceWorker(browser);
    return await worker.evaluate(fn, ...args);
  }
}

async function setRecognitionModel(browser, model) {
  await evaluateInServiceWorker(browser, async (selectedModel) => {
    await chrome.storage.sync.set({
      settings: {
        model: selectedModel,
      },
    });
  }, model);
}

async function dispatchCaptureForUrl(browser, targetUrl) {
  return evaluateInServiceWorker(browser, async (url) => {
    // Without the "tabs" permission tab.url is undefined, so match the
    // active tab (the bench brings the case page to front before dispatch).
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || typeof tab.id !== "number") {
      throw new Error(`Could not find bench tab for ${url}`);
    }

    await chrome.action.onClicked.dispatch(tab);
    return tab.id;
  }, targetUrl);
}

async function dispatchCaptureForTabId(browser, tabId) {
  await evaluateInServiceWorker(browser, async (id) => {
    const tab = await chrome.tabs.get(id);
    await chrome.action.onClicked.dispatch(tab);
  }, tabId);
}

async function scrapeOptionsRows(page) {
  return page.$$eval("#recognition-log li", (rows) => rows.map((row, index) => {
    const attributes = Array.from(row.attributes)
      .map((attribute) => `${attribute.name}=${attribute.value}`)
      .join(" ");
    const metadata = `${row.className ?? ""} ${attributes}`.toLowerCase();
    const finalAttribute = row.getAttribute("data-final")
      ?? row.getAttribute("data-is-final");
    const explicitInterim = (
      finalAttribute === "false"
      || /(?:^|[\s=_-])(?:interim|partial|draft|pending)(?:$|[\s=_-])/.test(
        metadata,
      )
    );
    const explicitFinal = !explicitInterim && (
      finalAttribute === "true"
      || /(?:^|[\s=_-])(?:final|committed|complete|stable)(?:$|[\s=_-])/.test(
        metadata,
      )
    );

    const ja = row.querySelector(".recognition-ja")?.textContent?.trim() ?? "";

    const textWithoutJapanese = (element) => {
      const clone = element.cloneNode(true);

      clone.querySelectorAll(".recognition-ja").forEach((node) => {
        node.remove();
      });

      return clone.textContent ?? "";
    };

    let text = "";
    const original = row.querySelector(".recognition-original");

    if (original) {
      text = textWithoutJapanese(original);
    }

    if (!text.trim()) {
      const englishSelectors = [
        '[data-lang="en"]',
        '[lang="en"]',
        '[lang^="en-"]',
        ".recognition-english",
        ".recognition-text",
        ".english",
        ".en",
        ".source-text",
        ".source",
      ];

      for (const selector of englishSelectors) {
        const candidate = row.querySelector(selector);
        const candidateText = candidate
          ? textWithoutJapanese(candidate)
          : "";

        if (candidateText.trim()) {
          text = candidateText;
          break;
        }
      }
    }

    if (!text.trim()) {
      const clone = row.cloneNode(true);

      for (const selector of [
        ".recognition-ja",
        '[data-lang="ja"]',
        '[lang="ja"]',
        '[lang^="ja-"]',
        ".translation",
        ".japanese",
        ".status",
        ".badge",
        "button",
        "time",
      ]) {
        clone.querySelectorAll(selector).forEach((node) => node.remove());
      }

      text = clone.textContent ?? "";
    }

    const identity = row.dataset.id
      ?? row.dataset.segmentId
      ?? row.dataset.clauseId
      ?? row.dataset.key
      ?? row.id
      ?? `row-${index}`;

    return {
      explicitFinal,
      explicitInterim,
      index,
      ja,
      key: `${identity}:${index}`,
      text,
    };
  }));
}

async function openOptionsPage(browser, extensionBase) {
  const page = await browser.newPage();
  await page.goto(`${extensionBase}/options.html`, {
    waitUntil: "domcontentloaded",
  });

  try {
    await page.waitForSelector("#recognition-log", {
      timeout: DEFAULT_BROWSER_TIMEOUT_MS,
    });

    return {
      page,
      ready: true,
    };
  } catch {
    return {
      page,
      ready: false,
    };
  }
}

async function collectForDuration({
  browser,
  collector,
  durationSeconds,
  optionsPage,
  optionsReady,
}) {
  const startedAt = Date.now();
  const deadline = startedAt + durationSeconds * 1_000;

  while (Date.now() < deadline) {
    const storage = await readSessionStorage(browser);
    collector.ingestSession(extractFinalClausesFromSession(storage));

    if (optionsReady) {
      collector.ingestOptions(await scrapeOptionsRows(optionsPage));
    }

    const remaining = deadline - Date.now();

    if (remaining > 0) {
      await delay(Math.min(SAMPLE_INTERVAL_MS, remaining));
    }
  }

  return {
    endedAt: new Date().toISOString(),
    startedAt: new Date(startedAt).toISOString(),
  };
}

function timestampForFile(date) {
  const pad = (value) => String(value).padStart(2, "0");

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function safeFilePart(value) {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
}

function formatMetric(value) {
  return value === null || value === undefined
    ? "n/a"
    : value.toFixed(3);
}

function tableCell(value) {
  return String(value).replace(/\|/g, "\\|");
}

function printMarkdownTable({
  caseName,
  clauseCount,
  metrics,
  model,
}) {
  console.log(
    "| case | model | wer | werFiltered | pnRecall | fragmentRate | clauses |",
  );
  console.log(
    "|---|---|---:|---:|---:|---:|---:|",
  );
  console.log(
    `| ${tableCell(caseName)} `
      + `| ${tableCell(model)} `
      + `| ${formatMetric(metrics.wer)} `
      + `| ${formatMetric(metrics.werFiltered)} `
      + `| ${formatMetric(metrics.properNounRecall)} `
      + `| ${formatMetric(metrics.fragmentRate)} `
      + `| ${clauseCount} |`,
  );
}

async function runBench(options, caseDefinition) {
  const chromeExecutable = resolveChromeExecutable(options.chromePath);

  if (!existsSync(DIST_DIRECTORY)) {
    throw new Error(
      `Extension build directory was not found: ${DIST_DIRECTORY}`,
    );
  }

  let browser;
  let server;
  let profileDirectory;
  let captureStarted = false;
  let caseTabId;

  try {
    server = await startBenchServer({
      directory: PROJECT_ROOT,
      mediaFile: caseDefinition.mediaFile,
      contextTerms: caseDefinition.properNouns ?? [],
    });

    profileDirectory = mkdtempSync(
      path.join(tmpdir(), "x-jimaku-accuracy-bench-"),
    );

    browser = await puppeteer.launch({
      executablePath: chromeExecutable,
      headless: false,
      userDataDir: profileDirectory,
      args: [
        `--disable-extensions-except=${DIST_DIRECTORY}`,
        `--load-extension=${DIST_DIRECTORY}`,
        "--autoplay-policy=no-user-gesture-required",
        "--no-first-run",
      ],
    });

    if (TRACE_ENABLED) {
      const attachConsole = async (target) => {
        try {
          if (target.type() === "service_worker" || target.type() === "page") {
            return;
          }
          const session = await target.createCDPSession();
          await session.send("Runtime.enable");
          session.on("Runtime.consoleAPICalled", (event) => {
            void (async () => {
              const parts = [];

              for (const argument of event.args) {
                if (argument.objectId) {
                  try {
                    const serialized = await session.send(
                      "Runtime.callFunctionOn",
                      {
                        objectId: argument.objectId,
                        functionDeclaration:
                          "function() { try { return JSON.stringify(this); } catch { return String(this); } }",
                        returnByValue: true,
                      },
                    );
                    parts.push(String(serialized.result?.value).slice(0, 400));
                  } catch {
                    parts.push(argument.description ?? "?");
                  }
                } else {
                  parts.push(
                    argument.value !== undefined
                      ? String(argument.value)
                      : (argument.description ?? ""),
                  );
                }
              }

              traceLines.push(`[${target.type()}] ${parts.join(" ")}`);
            })();
          });
        } catch {
          // best-effort tracing only
        }
      };
      browser.on("targetcreated", (t) => { void attachConsole(t); });
      for (const t of browser.targets()) {
        void attachConsole(t);
      }
    }

    const serviceWorkerTarget = await browser.waitForTarget(
      (target) => (
        target.type() === "service_worker"
        && target.url().includes("background.js")
      ),
      {
        timeout: DEFAULT_BROWSER_TIMEOUT_MS,
      },
    );

    if (!(await serviceWorkerTarget.worker())) {
      throw new Error("Extension service worker target has no worker");
    }

    await setRecognitionModel(browser, options.model);

    const casePage = await browser.newPage();
    await casePage.goto(server.caseUrl, {
      waitUntil: "domcontentloaded",
    });
    await casePage.bringToFront();
    await casePage.evaluate(async () => {
      const media = document.querySelector("#bench-media");

      if (!(media instanceof HTMLMediaElement)) {
        throw new Error("Bench media element was not found");
      }

      await media.play();
    });
    await casePage.waitForFunction(
      () => {
        const media = document.querySelector("#bench-media");
        return media instanceof HTMLMediaElement
          && media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
          && !media.paused;
      },
      {
        timeout: DEFAULT_BROWSER_TIMEOUT_MS,
      },
    );

    caseTabId = await dispatchCaptureForUrl(browser, server.caseUrl);
    captureStarted = true;
    // The tap needs a playing video at dispatch, but a short clip must not
    // end (and stop the session) while the model downloads. Once the tap is
    // acquired (loadingModel reached), pause; resume from 0 when running.
    await waitForCaptureState(browser, ["loadingModel", "running"], 60_000);
    await casePage.evaluate(() => {
      document.getElementById("bench-media").pause();
    });
    await waitForCaptureRunning(browser);
    await casePage.evaluate(async () => {
      const media = document.getElementById("bench-media");
      media.currentTime = 0;
      await media.play();
    });

    // chrome-extension: is a non-special scheme; URL.origin returns "null".
    const extensionBase = serviceWorkerTarget.url().replace(
      /\/background\.js$/,
      "",
    );
    const optionsView = await openOptionsPage(browser, extensionBase);
    const collector = new ClauseCollector();

    if (!optionsView.ready) {
      console.error(
        "[bench] #recognition-log was unavailable; session storage remains active",
      );
    }

    const timing = await collectForDuration({
      browser,
      collector,
      durationSeconds: options.durationSeconds,
      optionsPage: optionsView.page,
      optionsReady: optionsView.ready,
    });

    // Model-load time varies run to run, so a fixed duration can land before
    // the clip finishes playing. Stopping mid-playback truncates the tail:
    // wait for playback to end, then give the segmenter's 6s agreement
    // timeout room to flush the final clause while still "running".
    try {
      await casePage.waitForFunction(
        () => document.getElementById("bench-media").ended,
        { timeout: 120_000, polling: 500 },
      );
      await delay(10_000);
    } catch {
      console.error(
        "[bench] media did not reach ended before timeout; "
          + "stopping anyway (tail may be truncated)",
      );
    }

    {
      const storage = await readSessionStorage(browser);
      collector.ingestSession(extractFinalClausesFromSession(storage));

      if (optionsView.ready) {
        collector.ingestOptions(await scrapeOptionsRows(optionsView.page));
      }
    }

    await casePage.bringToFront();
    await delay(100);
    await dispatchCaptureForTabId(browser, caseTabId);
    captureStarted = false;

    let captureStopped = false;

    try {
      await waitForCaptureStopped(browser);
      captureStopped = true;
    } catch (error) {
      console.error(`[bench] ${error.message}`);
    }

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const storage = await readSessionStorage(browser);
      collector.ingestSession(extractFinalClausesFromSession(storage));

      if (optionsView.ready) {
        collector.ingestOptions(
          await scrapeOptionsRows(optionsView.page),
          captureStopped,
        );
      }

      if (attempt < 3) {
        await delay(SAMPLE_INTERVAL_MS);
      }
    }

    const collected = collector.result();

    if (collected.clauses.length === 0) {
      throw new Error(
        "No final recognition clauses were found in session storage "
          + "or options.html",
      );
    }

    const hypothesis = collected.clauses.join(" ");
    const metrics = computeMetrics({
      clauses: collected.clauses,
      hypothesis,
      properNouns: caseDefinition.properNouns,
      reference: caseDefinition.reference,
    });
    const generatedAt = new Date();
    const result = {
      schemaVersion: 2,
      generatedAt: generatedAt.toISOString(),
      case: options.caseName,
      model: options.model,
      durationSeconds: options.durationSeconds,
      timing,
      reference: {
        properNouns: caseDefinition.properNouns,
        source: caseDefinition.referenceSource,
        sourceUrl: caseDefinition.source ?? null,
        text: caseDefinition.reference,
      },
      recognition: {
        clauses: collected.clauses,
        collectionSource: collected.source,
        hypothesis,
        jaClauses: collected.jaClauses,
        jaText: collected.jaClauses.filter(Boolean).join("\n"),
      },
      metrics,
    };

    mkdirSync(RESULTS_DIRECTORY, {
      recursive: true,
    });

    const resultFileName = [
      options.caseName,
      safeFilePart(options.model),
      timestampForFile(generatedAt),
    ].join("-") + ".json";
    const resultFile = path.join(RESULTS_DIRECTORY, resultFileName);

    writeFileSync(
      resultFile,
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8",
    );

    printMarkdownTable({
      caseName: options.caseName,
      clauseCount: collected.clauses.length,
      metrics,
      model: options.model,
    });
    console.error(
      `[bench] result: ${path.relative(PROJECT_ROOT, resultFile)}`,
    );
    if (TRACE_ENABLED) {
      const tracePath = resultFile.replace(/\.json$/u, ".trace.log");
      writeFileSync(tracePath, traceLines.join("\n"), "utf8");
      console.error(
        `[bench] trace: ${path.relative(PROJECT_ROOT, tracePath)}`,
      );
    }
  } finally {
    if (captureStarted && browser && typeof caseTabId === "number") {
      try {
        await dispatchCaptureForTabId(browser, caseTabId);
      } catch {
        // Browser shutdown below terminates a capture that could not be toggled.
      }
    }

    if (browser) {
      await browser.close();
    }

    if (server) {
      await server.close();
    }

    if (profileDirectory) {
      try {
        rmSync(profileDirectory, {
          force: true,
          recursive: true,
        });
      } catch (error) {
        console.error(
          `[bench] temporary profile cleanup failed: ${error.message}`,
        );
      }
    }
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));

  if (options.help) {
    printUsage();
    return 0;
  }

  const caseDefinition = loadCase(options.caseName);

  if (caseDefinition.missingLocalMedia) {
    return 2;
  }

  await runBench(options, caseDefinition);
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof ArgumentError) {
    console.error(error.message);
  } else {
    console.error(error instanceof Error ? error.stack : String(error));
  }

  process.exitCode = error?.exitCode ?? 1;
}
