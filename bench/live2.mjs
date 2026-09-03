// Unattended live2 capture: real translation quality, no human in the loop.
//
// Chrome for Testing has no built-in AI, so translation quality could only ever be
// measured in a real Chrome - which until now meant a person clicking the extension's
// reload button and keeping the fixture tab in front. Neither is needed any more:
//   - the extension is installed over CDP (Extensions.loadUnpacked), so every run
//     picks up the current dist/ build with no reload button;
//   - --autoplay-policy lets the fixture play without a click, and the tab stays the
//     only tab so Chrome never suspends its muted media.
//
// Requires a Chrome whose profile already has the on-device model, and a pipe
// connection: the CDP Extensions domain is not served over --remote-debugging-port.
// Branded Chrome dropped --load-extension in 137 (Chromium and Chrome for Testing
// still accept it), so on Canary the flag is silently ignored and loadUnpacked is
// the only way in.
import puppeteer from "puppeteer-core";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBenchServer } from "./serve.mjs";
import {
  parseArgs,
  resolveDisplayRuns,
  argvForDisplayRun,
  parseChildReport,
  combineDisplayReports,
  annotateDisplayMeta,
  coverageNote,
} from "./live2-config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

// The overlay can take a while to reach the running state when the on-device
// model is cold, and a fresh checkout has no bench/results directory.
const READY_TIMEOUT_MS = 120000;
const DRAIN_TIMEOUT_MS = 30000;
const DRAIN_QUIET_MS = 6000;
const STOP_DRAIN_TIMEOUT_MS = 45000;
// Same sets run-bench.mjs validates against. An unvalidated typo is silently
// rejected by the extension, which keeps its previous setting while the result
// JSON claims the one that was asked for.
const ALLOWED_MODELS = ["tiny", "base", "small", "turbo"];
const ALLOWED_BACKENDS = ["auto", "translator", "prompt-api"];

const CASES = {
  tts: { mediaFile: path.join(here, "refs", "tts-speech.wav"), contextTerms: [] },
  tts2: {
    mediaFile: path.join(here, "refs", "tts2-speech.wav"),
    contextTerms: ["Roman", "NASA Goddard", "Kennedy Space Center", "coronagraph"],
  },
  // Real speech from an X post, kept because it reproduces recognizer
  // repetition loops that the synthetic fixtures never trigger.
  theo: {
    mediaFile: path.join(here, "refs", "theo-speech.wav"),
    contextTerms: ["Anthropic", "Claude", "Opus", "Theo"],
  },
  theo2: {
    mediaFile: path.join(here, "refs", "theo2-speech.wav"),
    contextTerms: ["Anthropic", "Claude", "Opus", "Theo"],
  },
  // Real speech with 35s of digital silence spliced into the middle, to
  // exercise the recognizer's behaviour when a stream goes quiet.
  theosil: {
    mediaFile: path.join(here, "refs", "theosil-speech.wav"),
    contextTerms: ["Anthropic", "Claude", "Opus", "Theo"],
  },
};

function loadKeepLatinEntries() {
  const source = readFileSync(
    path.join(root, "src", "offscreen", "glossary.data.ts"),
    "utf8",
  );
  const start = source.indexOf("export const KEEP_LATIN_TERMS");
  const end = source.indexOf("export const GLOSSARY_TERMS");
  if (start < 0 || end <= start) {
    throw new Error("KEEP_LATIN_TERMS block was not found");
  }
  const block = source.slice(start, end);
  return [...block.matchAll(/term:\s*"([^"]+)"/gu)].map((match) => {
    const lineEnd = block.indexOf("\n", match.index);
    const line = block.slice(
      match.index,
      lineEnd < 0 ? block.length : lineEnd,
    );
    return {
      term: match[1],
      ambiguous: line.includes("ambiguous: true"),
    };
  });
}

function loadKeepLatinTerms() {
  return loadKeepLatinEntries().map((entry) => entry.term);
}

function keepLatinPattern(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9'])`, "iu");
}

function keepLatinTermsIn(text, terms) {
  return terms.filter((term) => keepLatinPattern(term).test(text));
}

function countMatches(text, pattern) {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  return [...text.matchAll(new RegExp(pattern.source, flags))].length;
}

// A LOWER BOUND, not a count. This can only find spellings someone has already
// seen, and a survey of every result file turned up nine more than the list
// held - ゴッドガード and ゴッダード for Goddard, オペウス and オーパス for Opus,
// クローク for Clerk, フェブル for Fable. A model that mangles a name mangles it
// a new way each time, so a number from this list is the floor and never the
// total. The real measure compares against the English source, which needs the
// full source text recorded per cue; until that exists, read this as "at least".
const KATAKANA_NAME_RENDERINGS = [
  { term: "Opus", rendering: "オプス" },
  { term: "Opus", rendering: "オパウス" },
  { term: "Opus", rendering: "オピュス" },
  { term: "Opus", rendering: "オペウス" },
  { term: "Opus", rendering: "オーパス" },
  { term: "Clerk", rendering: "クラーク" },
  { term: "Clerk", rendering: "クローク" },
  { term: "Claude", rendering: "クロード" },
  { term: "Anthropic", rendering: "アンソロピック" },
  { term: "Hugging Face", rendering: "ハルキング" },
  { term: "Goddard", rendering: "ゴダード" },
  { term: "Goddard", rendering: "ゴッダード" },
  { term: "Goddard", rendering: "ゴッドガード" },
  { term: "Fable", rendering: "ファブル" },
  { term: "Fable", rendering: "フェブル" },
];

function countKatakanaNameHits(text, entries, renderings) {
  const ambiguousTerms = new Set(
    entries.filter((entry) => entry.ambiguous).map((entry) => entry.term),
  );
  let ambiguous = 0;
  let plain = 0;
  for (const { term, rendering } of renderings) {
    const hits = text.split(rendering).length - 1;
    if (ambiguousTerms.has(term)) {
      ambiguous += hits;
    } else {
      plain += hits;
    }
  }
  return { ambiguous, plain };
}

function splitEnglishClauses(text) {
  return text
    .replace(/\r\n/g, "\n")
    .split(/(?<=[.!?])(?:\s+|$)/u)
    .map((part) => part.trim())
    .filter(Boolean);
}


const options = parseArgs(process.argv.slice(2));

if (options.help) {
  console.log(
    "Usage: node bench/live2.mjs [--case tts|tts2] [--model base] [--backend prompt-api]\n" +
      "                           [--duration 95] [--chrome <exe>] [--profile <dir>] [--extension <dir>]\n" +
      "                           [--show-original | --no-show-original]\n" +
      "With neither display flag, both original-off and original-on are captured.",
  );
  process.exit(0);
}

if (options.displayModeError) {
  console.error(`[live2] ${options.displayModeError}`);
  process.exit(2);
}

if (
  !Number.isFinite(options.durationSeconds) ||
  options.durationSeconds <= 0
) {
  console.error("[live2] --duration must be a positive number of seconds");
  process.exit(2);
}
if (!ALLOWED_MODELS.includes(options.model)) {
  console.error(
    `[live2] --model must be one of: ${ALLOWED_MODELS.join(", ")}`,
  );
  process.exit(2);
}
if (!ALLOWED_BACKENDS.includes(options.backend)) {
  console.error(
    `[live2] --backend must be one of: ${ALLOWED_BACKENDS.join(", ")}`,
  );
  process.exit(2);
}

options.chromePath = path.resolve(
  options.chromePath.trim(),
);
options.profile = path.resolve(
  options.profile.trim(),
);
if (!existsSync(options.chromePath)) {
  console.error(
    `[live2] --chrome does not exist: ${options.chromePath}`,
  );
  process.exit(2);
}

const definition = CASES[options.caseName];
if (definition === undefined) {
  console.error(
    `[live2] unknown case: ${options.caseName} (known: ${Object.keys(CASES).join(", ")})`,
  );
  process.exit(2);
}

if (options.displayMode === "both") {
  const reports = [];
  for (const run of resolveDisplayRuns(options)) {
    console.error(`[live2] display config ${run.displayConfig}`);
    const child = spawnSync(
      process.execPath,
      [
        fileURLToPath(import.meta.url),
        ...argvForDisplayRun(
          process.argv.slice(2),
          run.displayConfig,
        ),
      ],
      {
        encoding: "utf8",
        cwd: process.cwd(),
        env: process.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "inherit"],
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    if (child.error) {
      reports.push({
        displayConfig: run.displayConfig,
        showOriginal: run.showOriginal,
        error: String(child.error),
        gates: annotateDisplayMeta(
          {},
          {
            displayConfig: run.displayConfig,
            displayCoverage: "single",
          },
        ),
      });
      continue;
    }
    reports.push(
      parseChildReport(
        child.stdout,
        child.status,
        run.displayConfig,
      ),
    );
  }
  const combined = combineDisplayReports(reports);
  console.log(JSON.stringify(combined, null, 2));
  process.exit(combined.error ? 1 : 0);
}

// Puppeteer's headless defaults (--headless, --mute-audio) leak through
// ignoreDefaultArgs, and its --disable-features list disables the Optimization
// Guide that delivers the on-device model.
// Filled from the extension worker after the capture; see the probe near teardown.
let captionLogEntries = null;
let captionLogDwell = null;

const baseArgs = puppeteer
  .defaultArgs({ headless: false })
  .filter(
    (a) =>
      !a.startsWith("--headless") &&
      !a.startsWith("--disable-features=") &&
      !a.startsWith("--disable-extensions") &&
      a !== "--disable-background-networking" &&
      a !== "--disable-component-update" &&
      a !== "--disable-component-extensions-with-background-pages" &&
      a !== "--enable-automation",
  );

const server = await startBenchServer({
  directory: root,
  mediaFile: definition.mediaFile,
  contextTerms: definition.contextTerms,
});
console.error(`[live2] fixture ${server.caseUrl}`);

mkdirSync(options.profile, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: options.chromePath,
  headless: false,
  pipe: true,
  protocolTimeout: 1800000,
  userDataDir: options.profile,
  ignoreDefaultArgs: true,
  args: [
    ...baseArgs,
    `--user-data-dir=${options.profile}`,
    "--enable-features=AIPromptAPI,OptimizationGuideManifestBroker,OnDeviceModelLitertLmBackend",
    "--enable-unsafe-extension-debugging",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--no-first-run",
    "--no-default-browser-check",
  ],
});

const captureMs = options.durationSeconds * 1000;
const result = {
  schemaVersion: 2,
  case: options.caseName,
  model: options.model,
  backend: options.backend,
  displayConfig: options.displayMode,
  displayCoverage: "single",
  showOriginal: options.showOriginal,
  durationSeconds: options.durationSeconds,
  collection: "live2 unattended (CDP Extensions.loadUnpacked + autoplay)",
  diagnostics: {
    devLog: [],
    clauseTimings: [],
    translationState: [],
    translationPaths: [],
  },
};
let captureRunningAtMs = null;
let replayStartedAtMs = null;

const watchdog = setTimeout(() => {
  console.error("[live2] watchdog fired");
  process.exit(2);
}, READY_TIMEOUT_MS + captureMs + 120000);
watchdog.unref?.();

try {
  const client = await browser.target().createCDPSession();
  const installed = await client.send("Extensions.loadUnpacked", {
    path: options.extension,
  });
  result.extensionId = installed.id;
  console.error(`[live2] installed extension ${installed.id}`);

  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());
  await page.goto(server.caseUrl, { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 1500));
  console.error("[live2] fixture loaded");

  // A translator-only profile is a valid environment for --backend translator,
  // so only require the API the selected backend actually uses.
  result.builtinAi = await page.evaluate(async () => {
    const out = {};
    out.languageModel =
      typeof LanguageModel === "undefined"
        ? "missing"
        : await LanguageModel.availability();
    out.translator =
      typeof Translator === "undefined"
        ? "missing"
        : await Translator.availability({
            sourceLanguage: "en",
            targetLanguage: "ja",
          });
    return out;
  });
  const usable = (api) => result.builtinAi[api] === "available";
  const backendReady =
    options.backend === "translator"
      ? usable("translator")
      : options.backend === "prompt-api"
        ? usable("languageModel")
        : // auto still needs somewhere to go: with neither API available
          // selectBestPath falls through to "none" and the overlay emits the
          // English source, which the capture guard cannot tell from a translation.
          usable("translator") || usable("languageModel");
  if (!backendReady) {
    throw new Error(
      `no translation API available for --backend ${options.backend}: ${JSON.stringify(result.builtinAi)}`,
    );
  }

  await page.evaluate(
    (settings) => {
      window.postMessage({ t: "CS_DEV_SET_SETTINGS", settings }, "*");
    },
    {
      model: options.model,
      sourceLang: "en",
      translationBackend: options.backend,
      showOriginal: options.showOriginal,
      showTentative: true,
    },
  );
  // Settings reach the capture path through storage, which is read independently
  // of this message, so give it a beat before toggling.
  await new Promise((r) => setTimeout(r, 2500));
  // The caption log persists across runs in the profile, so a run that does not
  // clear it reports the pages of every run before it as its own.
  try {
    const clearTargets = await browser.targets();
    const clearWorker = clearTargets.find(
      (t) =>
        t.url().startsWith(`chrome-extension://${result.extensionId}`)
        && (t.type() === "service_worker" || t.type() === "background_page"),
    );
    if (clearWorker) {
      const w = await clearWorker.worker();
      await w.evaluate(async () => {
        await chrome.storage.local.remove("captionDisplayLog");
      });
    }
  } catch {
    // A run that could not clear still reports its own count honestly enough;
    // the number is a floor, and the probe says how many pages closed.
  }
  console.error(`[live2] settings applied; ${JSON.stringify(result.builtinAi)}`);

  await page.evaluate(() => {
    window.__devLog = [];
    window.__translationState = [];
    window.addEventListener(
      "message",
      (event) => {
        if (
          event.source !== window
          || event.origin !== location.origin
        ) {
          return;
        }

        const arrivedAtMs = Date.now();

        if (event.data?.t === "OFF_DEV_LOG") {
          window.__devLog.push({
            ...event.data,
            arrivedAtMs,
          });
          return;
        }

        if (event.data?.t === "SW_TRANSLATION_STATE") {
          window.__translationState.push({
            ...event.data,
            arrivedAtMs,
          });
        }
      },
    );
  });

  // Replicates the handshake in bench/run-bench.mjs:1305-1319. The tap needs a
  // playing video at dispatch, but WhisperSegmenter.start() begins at the oldest
  // available ring-buffer offset (src/offscreen/segmenter.ts:299-307), so any
  // audio that accumulates while the model loads is replayed into the measured
  // window. Pausing as soon as the tap is acquired keeps that backlog empty.
  //
  // Note the status text: while the capture is running with the video paused the
  // overlay shows the silent-input hint, not 字幕ON (src/content/overlay.ts:1851-1879),
  // so running has to be detected from either wording.
  const chipSays = (needles) =>
    page.evaluate(
      (list) =>
        [...document.querySelectorAll("*")].some((host) => {
          const text = host.shadowRoot?.textContent;
          return text ? list.some((n) => text.includes(n)) : false;
        }),
      needles,
    );
  const RUNNING = ["字幕ON", "音声がありません", "音声を取得できません"];
  const ACQUIRED = ["字幕 準備中", ...RUNNING];

  const waitFor = async (label, needles, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await chipSays(needles)) {
        const observedAtMs =
          await page.evaluate(() => Date.now());
        console.error(`[live2] ${label}`);
        return observedAtMs;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  };

  await page.evaluate(async () => {
    const video = document.querySelector("video");
    video.loop = true;
    video.currentTime = 0;
    window.postMessage({ t: "CS_DEV_TOGGLE" }, "*");
    await video.play();
  });
  console.error("[live2] toggled on; waiting for warm-up");

  // Warm-up only completes while audio is flowing (measured: 字幕 準備中 until
  // ~4s of playback, then 字幕ON; paused, it never leaves 準備中), so the clip has
  // to run through it.
  captureRunningAtMs =
    await waitFor(
      "capture running",
      RUNNING,
      READY_TIMEOUT_MS,
    );
  if (captureRunningAtMs === null) {
    // Opening the window anyway would give a truncated capture that still claims
    // the full durationSeconds, and a non-empty line list would slip past the
    // empty-capture guard.
    throw new Error(
      `capture never reached the running state within ${READY_TIMEOUT_MS}ms`,
    );
  }
  result.readyBeforePlayback = true;

  // Those warm-up seconds are still in the capture ring, and
  // WhisperSegmenter.start() begins at the oldest available offset
  // (src/offscreen/segmenter.ts:299-307), so they would be emitted inside the
  // measured window. Pause and let the backlog drain: the overlay stops changing
  // once the recognizer has caught up with what it already holds.
  await page.evaluate(() => {
    document.querySelector("video").pause();
  });

  const overlayState = () =>
    page.evaluate(() => {
      const blocks = [];
      for (const host of document.querySelectorAll("*")) {
        if (!host.shadowRoot) continue;
        const lines = [
          ...host.shadowRoot.querySelectorAll(".caption-primary"),
        ].map((el) => el.textContent.trim());
        if (lines.length === 2) blocks.push(lines);
      }
      return blocks.map((lines) => lines.join("␟")).join("␞");
    });

  let quietSince = Date.now();
  let lastSeen = await overlayState();
  const drainDeadline = Date.now() + DRAIN_TIMEOUT_MS;
  while (Date.now() < drainDeadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const now = await overlayState();
    if (now !== lastSeen) {
      lastSeen = now;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= DRAIN_QUIET_MS) {
      break;
    }
  }
  result.drainMs = Date.now() - (quietSince - DRAIN_QUIET_MS);
  console.error("[live2] backlog drained; opening the window");

  replayStartedAtMs =
    await page.evaluate(async () => {
      window.__devLog = [];

      const video = document.querySelector("video");
      video.currentTime = 0;
      await video.play();
      return Date.now();
    });

  await page.evaluate(() => {
    window.__samples = [];
    window.__ledger = [];
    window.__ledgerSeen = new WeakSet();

    for (const host of document.querySelectorAll("*")) {
      const root = host.shadowRoot;
      if (!root) continue;

      for (const entry of root.querySelectorAll(".caption-ledger > *")) {
        window.__ledgerSeen.add(entry);
      }
    }

    // Page mode keeps two fixed slots and replaces both when the page changes.
    // Record page identity, stack state, and time on every sample.
    window.__capTimer = setInterval(() => {
      let sample = null;

      for (const host of document.querySelectorAll("*")) {
        const root = host.shadowRoot;
        if (!root) continue;
        const captionStack =
          root.querySelector(".caption-stack");
        const cue =
          root.querySelector(".caption-cue");
        if (!captionStack || !cue) continue;

        const primaryElements = [
          ...cue.querySelectorAll(":scope > .caption-primary"),
        ];
        const lines = primaryElements.map(
          (el) => el.textContent.trim(),
        );
        let primaryClippedVertical = 0;
        let primaryClippedHorizontal = 0;
        let primaryClippedExample = null;
        for (const el of primaryElements) {
          if (el.textContent.trim() === "") continue;
          const vertical =
            el.scrollHeight > el.clientHeight + 1;
          const horizontal =
            el.scrollWidth > el.clientWidth + 1;
          if (vertical) {
            primaryClippedVertical += 1;
          }
          if (horizontal) {
            primaryClippedHorizontal += 1;
          }
          if (
            (vertical || horizontal) &&
            primaryClippedExample === null
          ) {
            primaryClippedExample = {
              text: el.textContent.trim(),
              scrollWidth: el.scrollWidth,
              clientWidth: el.clientWidth,
              scrollHeight: el.scrollHeight,
              clientHeight: el.clientHeight,
            };
          }
        }
        const primaryClipped =
          primaryClippedVertical +
          primaryClippedHorizontal;
        const original =
          cue
            .querySelector(":scope > .caption-original")
            ?.textContent.trim() ?? "";
        const tentative =
          root
            .querySelector(".caption-tentative")
            ?.textContent.trim() ?? "";
        const hasPrimaryText =
          lines.some((line) => line !== "");
        const hasTentativeText =
          tentative !== "";
        const firstPrimary =
          cue.querySelector(":scope > .caption-primary");
        const captionTop =
          firstPrimary
            ? Math.round(
                firstPrimary.getBoundingClientRect().top,
              )
            : null;
        const stackHeight = Math.round(
          captionStack.getBoundingClientRect().height,
        );
        sample = {
          sampledAtMs: Date.now(),
          cueId: cue.dataset.cueId ?? "",
          pageId: cue.dataset.pageId ?? "",
          line0: lines[0] ?? "",
          line1: lines[1] ?? "",
          original,
          hasPrimaryText,
          hasTentativeText,
          captionTop,
          stackHeight,
          slotCountViolation: lines.length !== 2,
          stackDisplayed:
            getComputedStyle(captionStack)
              .display !== "none",
          blank:
            !hasPrimaryText
            && !hasTentativeText,
          primaryClipped,
          primaryClippedVertical,
          primaryClippedHorizontal,
          primaryClippedExample,
          captionMeasure:
            captionStack.dataset.captionMeasure
            ?? "",
          captionLineMeasure:
            captionStack.dataset.captionLineMeasure
            ?? "",
        };
        break;
      }

      if (sample !== null) {
        window.__samples.push(sample);
      }

      // Mirror the ledger as it grows. Reading it once at the end loses
      // everything, because stopping the capture destroys the overlay and the
      // ledger element with it.
      for (const host of document.querySelectorAll("*")) {
        const root = host.shadowRoot;
        if (!root) continue;
        for (const entry of root.querySelectorAll(".caption-ledger > *")) {
          if (window.__ledgerSeen.has(entry)) continue;
          window.__ledgerSeen.add(entry);
          const text = entry.textContent.trim();
          if (text) window.__ledger.push(text);
        }
      }
    }, 300);
  });

  const started = Date.now();
  const deadline = started + captureMs;
  while (Date.now() < deadline) {
    // Sleeping a fixed step overshoots any duration that is not a multiple of
    // it, which would silently record more audio than durationSeconds claims.
    await new Promise((r) =>
      setTimeout(r, Math.min(10000, deadline - Date.now())),
    );
    const count = await page.evaluate(() => window.__samples.length);
    console.error(
      `[live2] t+${Math.round((Date.now() - started) / 1000)}s samples=${count}`,
    );
  }

  // Stopping runs the explicit-stop drain, and the clauses it flushes are real
  // output for audio inside the window. Leave the sampler running until the
  // capture actually goes idle before taking the snapshot.
  await page.evaluate(() => {
    window.postMessage({ t: "CS_DEV_TOGGLE" }, "*");
  });
  const stopDeadline = Date.now() + STOP_DRAIN_TIMEOUT_MS;
  while (Date.now() < stopDeadline) {
    if (!(await chipSays(RUNNING))) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  result.stopDrainTimedOut = await chipSays(RUNNING);
  await new Promise((r) => setTimeout(r, 1000));

  const captured = await page.evaluate(() => {
    clearInterval(window.__capTimer);

    return {
      devLog: window.__devLog,
      translationState:
        window.__translationState,
      ledgerClauses: window.__ledger,
      samples: window.__samples,
    };
  });
  result.diagnostics.devLog =
    captured.devLog.map(
      ({ arrivedAtMs, ...entry }) => ({
        ...entry,
        arrivalMs:
          arrivedAtMs - replayStartedAtMs,
      }),
    );
  result.diagnostics.clauseTimings =
    result.diagnostics.devLog.filter(
      (entry) =>
        entry.data?.kind ===
        "clause-timing",
    );
  result.diagnostics.translationState =
    captured.translationState.map(
      ({ arrivedAtMs, ...entry }) => ({
        ...entry,
        arrivalMs:
          arrivedAtMs - replayStartedAtMs,
      }),
    );
  result.diagnostics.translationPaths = [
    ...new Set(
      result.diagnostics.translationState
        .map((entry) => entry.path)
        .filter((path) => typeof path === "string"),
    ),
  ];
  result.recognition = {
    jaClauses: captured.ledgerClauses,
  };
  result.display = {
    samples: captured.samples,
  };

  if (result.stopDrainTimedOut) {
    throw new Error(
      `capture remained RUNNING after ${STOP_DRAIN_TIMEOUT_MS}ms stop drain`,
    );
  }
} catch (error) {
  result.error = String(error);
  console.error(`[live2] ${result.error}`);
} finally {
  clearTimeout(watchdog);
  const proc = browser.process();
  try {
    const targets = await browser.targets();
    const worker = targets.find(
      (t) =>
        t.url().startsWith(`chrome-extension://${result.extensionId}`)
        && (t.type() === "service_worker" || t.type() === "background_page"),
    );
    if (!worker) {
      captionLogEntries = "no-worker-target";
    } else {
      const w = await worker.worker();
        // The log lives in the extension's storage, which the fixture page cannot
      // read. Ask the worker, so a run says whether recording actually fired
      // rather than only that the code shipped.
      const probe = await w.evaluate(async () => {
        const all = await chrome.storage.local.get(null);
        const value = all.captionDisplayLog;
        const pages = Array.isArray(value)
          ? value
          : Array.isArray(value?.pages)
            ? value.pages
            : null;
        if (pages === null) {
          return {
            entries: `unexpected-shape: ${typeof value}`,
          };
        }

        // Dwell is the whole point of the log: a well-wrapped page replaced
        // after 400ms is unreadable, and nothing measured that before.
        const closed = pages.filter(
          (page) => page.appearedAt && page.replacedAt,
        );
        const rows = closed.map((page) => {
          const ms =
            Date.parse(page.replacedAt) - Date.parse(page.appearedAt);
          const chars =
            (page.line0 ?? "").length + (page.line1 ?? "").length;
          return { ms, chars };
        }).filter((row) => Number.isFinite(row.ms) && row.ms > 0);
        const at = (list, q) =>
          list.length === 0
            ? null
            : list[Math.min(list.length - 1, Math.floor(list.length * q))];
        const dwell = rows.map((row) => row.ms).sort((a, b) => a - b);
        const speed = rows
          .filter((row) => row.chars > 0)
          .map((row) => row.chars / (row.ms / 1000))
          .sort((a, b) => a - b);

        return {
          entries: pages.length,
          closed: rows.length,
          dwellMsP10: at(dwell, 0.1),
          dwellMsP50: at(dwell, 0.5),
          dwellMsP90: at(dwell, 0.9),
          charsPerSecondP50: at(speed, 0.5),
          charsPerSecondP90: at(speed, 0.9),
        };
      });
      captionLogEntries = probe.entries;
      captionLogDwell = probe.closed === undefined
        ? null
        : {
            closedPages: probe.closed,
            dwellMsP10: probe.dwellMsP10,
            dwellMsP50: probe.dwellMsP50,
            dwellMsP90: probe.dwellMsP90,
            charsPerSecondP50: probe.charsPerSecondP50,
            charsPerSecondP90: probe.charsPerSecondP90,
          };
    }
  } catch (error) {
    captionLogEntries = `probe-failed: ${String(error).slice(0, 120)}`;
  }
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 15000))]);
  if (proc && proc.exitCode === null) proc.kill("SIGKILL");
  await server.close?.();
}

const lines = result.recognition?.jaClauses ?? [];
if (!result.error && lines.length === 0) {
  // A missed toggle, a failed capture or a renamed overlay selector all end here
  // with no exception, and the file would be unusable to score-ja.
  result.error = "capture produced no caption lines";
  console.error(`[live2] ${result.error}`);
}
const joined = lines.join("\n");
const japanese = /[\u3040-\u30ff\u4e00-\u9fff]/u;
const samples = result.display?.samples ?? [];
const displayBlocks = [];
const pageBlocks = [];
let slotCountViolations = 0;
let cueIdMissing = 0;
let pageIdMissing = 0;
let primaryClipped = 0;
let primaryClippedVertical = 0;
let primaryClippedHorizontal = 0;
let primaryClippedExample = null;

for (const sample of samples) {
  const hasPageText =
    sample.line0 !== ""
    || sample.line1 !== "";

  if (sample.slotCountViolation) {
    slotCountViolations += 1;
  }
  if (sample.primaryClipped) {
    primaryClipped += sample.primaryClipped;
  }
  primaryClippedVertical +=
    sample.primaryClippedVertical ?? 0;
  primaryClippedHorizontal +=
    sample.primaryClippedHorizontal ?? 0;
  if (
    primaryClippedExample === null &&
    sample.primaryClippedExample
  ) {
    primaryClippedExample =
      sample.primaryClippedExample;
  }
  if (
    (hasPageText || sample.slotCountViolation)
    && sample.cueId === ""
  ) {
    cueIdMissing += 1;
  }
  if (
    (hasPageText || sample.slotCountViolation)
    && sample.pageId === ""
  ) {
    pageIdMissing += 1;
  }

  const previousDisplay =
    displayBlocks[displayBlocks.length - 1];
  if (
    !previousDisplay
    || previousDisplay.cueId !== sample.cueId
    || previousDisplay.pageId !== sample.pageId
    || previousDisplay.line0 !== sample.line0
    || previousDisplay.line1 !== sample.line1
    || previousDisplay.original !== sample.original
    || previousDisplay.slotCountViolation
      !== sample.slotCountViolation
    || previousDisplay.stackDisplayed
      !== sample.stackDisplayed
    || previousDisplay.blank !== sample.blank
  ) {
    displayBlocks.push({
      sampledAtMs: sample.sampledAtMs,
      cueId: sample.cueId,
      pageId: sample.pageId,
      line0: sample.line0,
      line1: sample.line1,
      original: sample.original,
      slotCountViolation:
        sample.slotCountViolation,
      stackDisplayed: sample.stackDisplayed,
      blank: sample.blank,
    });
  }

  if (
    !sample.stackDisplayed
    || (!hasPageText && !sample.slotCountViolation)
  ) {
    continue;
  }

  const previous =
    pageBlocks[pageBlocks.length - 1];
  if (
    previous
    && previous.cueId === sample.cueId
    && previous.pageId === sample.pageId
    && previous.line0 === sample.line0
    && previous.line1 === sample.line1
  ) {
    continue;
  }

  pageBlocks.push({
    sampledAtMs: sample.sampledAtMs,
    cueId: sample.cueId,
    pageId: sample.pageId,
    line0: sample.line0,
    line1: sample.line1,
    lines: [sample.line0, sample.line1].filter(
      (line) => line !== "",
    ),
  });
}

result.display = {
  ...(result.display ?? {}),
  blocks: pageBlocks,
};

let pageLineReuse = 0;
let nonEmptyPageTransitions = 0;
const pageIdsByCue = new Map();

for (let index = 0; index < pageBlocks.length; index += 1) {
  const block = pageBlocks[index];
  const previous = pageBlocks[index - 1];

  if (block.cueId !== "") {
    const pageIds =
      pageIdsByCue.get(block.cueId)
      ?? new Set();
    pageIds.add(block.pageId);
    pageIdsByCue.set(block.cueId, pageIds);
  }

  if (!previous) {
    continue;
  }

  const previousLines = new Set(previous.lines);
  if (
    block.lines.some(
      (line) => previousLines.has(line),
    )
  ) {
    pageLineReuse += 1;
  }

  if (
    previous.cueId !== block.cueId
    && previous.lines.length > 0
    && block.lines.length > 0
  ) {
    nonEmptyPageTransitions += 1;
  }
}

const twoPageCuesObserved =
  [...pageIdsByCue.values()].filter(
    (pageIds) =>
      pageIds.has("0")
      && pageIds.has("1"),
  ).length;
const captionedCueCount = pageIdsByCue.size;
const onePageCueCount = [...pageIdsByCue.values()].filter(
  (pageIds) =>
    pageIds.size === 1
    && pageIds.has("0"),
).length;
const sentenceFitRate =
  captionedCueCount === 0
    ? null
    : onePageCueCount / captionedCueCount;

const blankBarSamples =
  displayBlocks.filter(
    (block) =>
      block.stackDisplayed
      && block.blank,
  ).length;
const originalRowBlocks =
  displayBlocks.filter(
    (block) =>
      block.stackDisplayed
      && block.original !== "",
  );
const primaryTextFor = (block) =>
  [block.line0, block.line1]
    .filter((line) => line !== "")
    .join(" ")
    .trim();
const originalRowShown =
  originalRowBlocks.length;
const bothRowsEnglish =
  originalRowBlocks.filter(
    (block) => {
      const primaryText =
        primaryTextFor(block);
      return (
        primaryText !== ""
        && !japanese.test(primaryText)
      );
    },
  ).length;
const rowsIdentical =
  originalRowBlocks.filter(
    (block) =>
      primaryTextFor(block)
        === block.original.trim(),
  ).length;
const originalWithoutPrimary =
  originalRowBlocks.filter(
    (block) =>
      block.line0 === ""
      && block.line1 === "",
  ).length;
const captureToReplayMs =
  captureRunningAtMs !== null
  && replayStartedAtMs !== null
    ? Math.max(
        0,
        replayStartedAtMs
          - captureRunningAtMs,
      )
    : null;

function sampleDelayMs(sample) {
  if (
    replayStartedAtMs === null
    || sample === undefined
  ) {
    return null;
  }

  return Math.max(
    0,
    sample.sampledAtMs
      - replayStartedAtMs,
  );
}

const firstCaptionSample =
  samples.find(
    (sample) =>
      sample.stackDisplayed
      && !sample.blank,
  );
const firstTentativeSample =
  samples.find(
    (sample) =>
      sample.stackDisplayed
      && sample.hasTentativeText,
  );
const firstFinalSample =
  samples.find(
    (sample) =>
      sample.stackDisplayed
      && sample.hasPrimaryText,
  );
const firstJapaneseSample =
  samples.find(
    (sample) =>
      sample.stackDisplayed
      && (
        japanese.test(sample.line0)
        || japanese.test(sample.line1)
      ),
  );
const firstCaptionMs =
  sampleDelayMs(firstCaptionSample);
const firstTentativeMs =
  sampleDelayMs(firstTentativeSample);
const firstFinalMs =
  sampleDelayMs(firstFinalSample);
const firstJapaneseMs =
  sampleDelayMs(firstJapaneseSample);
const translationState =
  result.diagnostics.translationState;
const pathFirstReportedMs =
  translationState[0]?.arrivalMs ?? null;
const pathReadyMs =
  translationState.find(
    (entry) =>
      typeof entry.path === "string"
      && entry.path !== "none",
  )?.arrivalMs ?? null;
const pathReadyToFirstJapaneseMs =
  pathReadyMs !== null
  && firstJapaneseMs !== null
    ? firstJapaneseMs - pathReadyMs
    : null;
const tentativeToFinalMs =
  firstTentativeMs !== null
  && firstFinalMs !== null
    ? firstFinalMs - firstTentativeMs
    : null;
const nonEmptyPageBlocks =
  pageBlocks.filter(
    (block) => block.lines.length > 0,
  );
const captionGapMs =
  nonEmptyPageBlocks
    .slice(1)
    .map(
      (block, index) =>
        Math.max(
          0,
          block.sampledAtMs
            - nonEmptyPageBlocks[index]
              .sampledAtMs,
        ),
    );

function percentileMs(values, quantile) {
  if (values.length === 0) {
    return null;
  }

  const sorted =
    [...values].sort((left, right) =>
      left - right
    );
  const position =
    (sorted.length - 1) * quantile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];

  return Math.round(
    lower
      + (upper - lower)
        * (position - lowerIndex),
  );
}

const finalIntervalMsP50 =
  percentileMs(captionGapMs, 0.5);
const finalIntervalMsP90 =
  percentileMs(captionGapMs, 0.9);
const clauseTranslateMs =
  result.diagnostics.clauseTimings
    .map(
      (entry) =>
        entry.data?.enqueueToTerminalMs,
    )
    .filter(
      (value) =>
        Number.isFinite(value) &&
        value >= 0,
    );
const clauseTranslateMsP50 =
  percentileMs(clauseTranslateMs, 0.5);
const clauseTranslateMsP90 =
  percentileMs(clauseTranslateMs, 0.9);
const clauseDeadlineHits =
  result.diagnostics.clauseTimings
    .filter(
      (entry) =>
        entry.data?.outcome ===
          "fallback" &&
        entry.data?.deadlineExpired ===
          true,
    )
    .length;

const devLogKindCounts = {
  "queue-drop": 0,
  "rescue-failure": 0,
  passthrough: 0,
  "clause-timing": 0,
  other: 0,
};
for (
  const entry
  of result.diagnostics.devLog
) {
  const kind = entry.data?.kind;

  if (
    Object.hasOwn(
      devLogKindCounts,
      kind,
    )
  ) {
    devLogKindCounts[kind] += 1;
  } else {
    devLogKindCounts.other += 1;
  }
}

let captionTopChanges = 0;
let stackHeightChanges = 0;
const captionTopSeen = new Set();
let previousGeometry = null;
for (const sample of samples) {
  if (!sample.stackDisplayed) {
    previousGeometry = null;
    continue;
  }
  const captionTop = sample.captionTop;
  const stackHeight = sample.stackHeight;
  if (Number.isFinite(captionTop)) {
    captionTopSeen.add(captionTop);
  }
  if (previousGeometry !== null) {
    if (
      previousGeometry.line0 === sample.line0
      && previousGeometry.captionTop !== captionTop
    ) {
      captionTopChanges += 1;
    }
    if (
      previousGeometry.stackHeight !== stackHeight
    ) {
      stackHeightChanges += 1;
    }
  }
  previousGeometry = {
    line0: sample.line0,
    captionTop,
    stackHeight,
  };
}
function loadBudouxJapaneseBoundaries() {
  const modelPath = path.join(
    root,
    ".references/budoux/budoux/models/ja.json",
  );
  if (!existsSync(modelPath)) return null;
  const model = JSON.parse(readFileSync(modelPath, "utf8"));
  const groups = new Map(
    Object.entries(model).map(([key, value]) => [
      key,
      new Map(Object.entries(value)),
    ]),
  );
  const baseScore = -0.5 * [...groups.values()]
    .flatMap((group) => [...group.values()])
    .reduce((sum, score) => sum + score, 0);
  const uw1 = groups.get("UW1");
  const uw2 = groups.get("UW2");
  const uw3 = groups.get("UW3");
  const uw4 = groups.get("UW4");
  const uw5 = groups.get("UW5");
  const uw6 = groups.get("UW6");
  const bw1 = groups.get("BW1");
  const bw2 = groups.get("BW2");
  const bw3 = groups.get("BW3");
  const tw1 = groups.get("TW1");
  const tw2 = groups.get("TW2");
  const tw3 = groups.get("TW3");
  const tw4 = groups.get("TW4");
  return (sentence) => {
    const result = [];
    for (let i = 1; i < sentence.length; i += 1) {
      let score = baseScore;
      score += uw1?.get(sentence.substring(i - 3, i - 2)) || 0;
      score += uw2?.get(sentence.substring(i - 2, i - 1)) || 0;
      score += uw3?.get(sentence.substring(i - 1, i)) || 0;
      score += uw4?.get(sentence.substring(i, i + 1)) || 0;
      score += uw5?.get(sentence.substring(i + 1, i + 2)) || 0;
      score += uw6?.get(sentence.substring(i + 2, i + 3)) || 0;
      score += bw1?.get(sentence.substring(i - 2, i)) || 0;
      score += bw2?.get(sentence.substring(i - 1, i + 1)) || 0;
      score += bw3?.get(sentence.substring(i, i + 2)) || 0;
      score += tw1?.get(sentence.substring(i - 3, i)) || 0;
      score += tw2?.get(sentence.substring(i - 2, i + 1)) || 0;
      score += tw3?.get(sentence.substring(i - 1, i + 2)) || 0;
      score += tw4?.get(sentence.substring(i, i + 3)) || 0;
      if (score > 0) result.push(i);
    }
    return result;
  };
}

function phraseBoundaryRate(blocks) {
  const parseBoundaries = loadBudouxJapaneseBoundaries();
  if (parseBoundaries === null) return null;
  const pagesByCue = new Map();
  for (const block of blocks) {
    if (!block.cueId) continue;
    const pages = pagesByCue.get(block.cueId) ?? [];
    pages.push(block);
    pagesByCue.set(block.cueId, pages);
  }
  let lineBreaks = 0;
  let phraseBreaks = 0;
  for (const pages of pagesByCue.values()) {
    const seen = new Set();
    const unique = [...pages]
      .sort((left, right) => Number(left.pageId) - Number(right.pageId))
      .filter((page) => {
        if (seen.has(page.pageId)) return false;
        seen.add(page.pageId);
        return true;
      });
    const lines = [];
    for (const page of unique) {
      if (page.line0) lines.push(page.line0);
      if (page.line1) lines.push(page.line1);
    }
    if (lines.length < 2) continue;
    const text = lines.join("");
    const boundaries = new Set(parseBoundaries(text));
    let offset = 0;
    for (let index = 0; index < lines.length - 1; index += 1) {
      offset += lines[index].length;
      lineBreaks += 1;
      if (boundaries.has(offset)) phraseBreaks += 1;
    }
  }
  return {
    rate: lineBreaks === 0 ? null : phraseBreaks / lineBreaks,
    samples: lineBreaks,
  };
}

const phraseBoundarySummary =
  phraseBoundaryRate(pageBlocks);

const captionMeasureSeen = new Set(
  samples
    .map((sample) => sample.captionMeasure)
    .filter((value) => value === "canvas" || value === "units"),
);
const captionMeasure = captionMeasureSeen.has("canvas")
  ? "canvas"
  : captionMeasureSeen.has("units")
    ? "units"
    : null;

const captionLineMeasureSeen = new Set(
  samples
    .map((sample) => sample.captionLineMeasure)
    .filter((value) => value === "font" || value === "constant"),
);
const captionLineMeasure = captionLineMeasureSeen.has("font")
  ? "font"
  : captionLineMeasureSeen.has("constant")
    ? "constant"
    : null;

const keepLatinEntries = loadKeepLatinEntries();
const keepLatinTerms = keepLatinEntries.map((entry) => entry.term);
const glossaryScriptFile = path.join(
  here,
  "refs",
  `${options.caseName}-script.txt`,
);
let glossaryEnglishClauses;
let glossaryJapaneseOf;
if (originalRowBlocks.length > 0) {
  glossaryEnglishClauses = originalRowBlocks.map((block) => block.original);
  glossaryJapaneseOf = (index) => primaryTextFor(originalRowBlocks[index]);
} else if (existsSync(glossaryScriptFile)) {
  glossaryEnglishClauses = splitEnglishClauses(
    readFileSync(glossaryScriptFile, "utf8"),
  );
  glossaryJapaneseOf = () => joined;
} else {
  glossaryEnglishClauses = lines;
  glossaryJapaneseOf = (_index, english) => english;
}

let glossaryLatinKept = 0;
let glossaryLatinLost = 0;
for (const [index, english] of glossaryEnglishClauses.entries()) {
  const terms = [...new Set(keepLatinTermsIn(english, keepLatinTerms))];
  if (terms.length === 0) continue;
  const japanese = glossaryJapaneseOf(index, english);
  if (terms.every((term) => keepLatinPattern(term).test(japanese))) {
    glossaryLatinKept += 1;
  } else {
    glossaryLatinLost += 1;
  }
}

let keepLatinSourceHits = 0;
for (const english of glossaryEnglishClauses) {
  for (const entry of keepLatinEntries) {
    keepLatinSourceHits += countMatches(
      english,
      keepLatinPattern(entry.term),
    );
  }
}
let maskedNameOccurrences = 0;
for (const entry of keepLatinEntries) {
  if (entry.ambiguous) continue;
  maskedNameOccurrences += countMatches(
    joined,
    keepLatinPattern(entry.term),
  );
}
const katakanaHits = countKatakanaNameHits(
  joined,
  keepLatinEntries,
  KATAKANA_NAME_RENDERINGS,
);
const katakanaNameHitsAmbiguous = katakanaHits.ambiguous;
const katakanaNameHitsPlain = katakanaHits.plain;
const katakanaNameHits =
  katakanaNameHitsAmbiguous + katakanaNameHitsPlain;

result.observations = {
  captionTopChanges,
  captionTopValues: [...captionTopSeen].sort(
    (left, right) => left - right,
  ),
  stackHeightChanges,
  sentenceFitRate,
  captionMeasure,
  captionLineMeasure,
  primaryClippedVertical,
  primaryClippedHorizontal,
  phraseBoundaryRate:
    phraseBoundarySummary.rate,
  phraseBoundarySamples:
    phraseBoundarySummary.samples,
  captionLogEntries,
  captionLogDwell,
  glossaryLatinKept,
  glossaryLatinLost,
  keepLatinSourceHits,
  maskedNameOccurrences,
  katakanaNameHits,
  katakanaNameHitsAmbiguous,
  katakanaNameHitsPlain,
};

result.diagnostics.primaryClippedExample =
  primaryClippedExample;

result.gates = annotateDisplayMeta({
  lines: lines.length,
  englishPassthrough: lines.filter((l) => !japanese.test(l)).length,
  devLogQueueDrop:
    devLogKindCounts["queue-drop"],
  devLogRescueFailure:
    devLogKindCounts["rescue-failure"],
  devLogPassthrough:
    devLogKindCounts.passthrough,
  devLogOther:
    devLogKindCounts.other,
  clauseTranslateMsP50,
  clauseTranslateMsP90,
  clauseDeadlineHits,
  clauseTimingSamples:
    clauseTranslateMs.length,
  wrongSenseRoma: (joined.match(/ローマ(?!ン)/gu) ?? []).length,
  unresolvedPlaceholders: (joined.match(/%%/gu) ?? []).length,
  romanKept: (joined.match(/(?<![A-Za-z])Roman(?![A-Za-z])/gu) ?? []).length,
  pageLineReuse,
  nonEmptyPageTransitions,
  twoPageCuesObserved,
  blankBarSamples,
  bothRowsEnglish,
  rowsIdentical,
  originalRowShown,
  originalWithoutPrimary,
  captureToReplayMs,
  pathFirstReportedMs,
  pathReadyMs,
  firstCaptionMs,
  firstTentativeMs,
  firstFinalMs,
  firstJapaneseMs,
  pathReadyToFirstJapaneseMs,
  tentativeToFinalMs,
  finalIntervalMsP50,
  finalIntervalMsP90,
  slotCountViolations,
  cueIdMissing,
  pageIdMissing,
  primaryClipped,
  stopDrainTimedOut:
    result.stopDrainTimedOut ?? false,
}, {
  displayConfig: options.displayMode,
  displayCoverage: "single",
});

const failedDisplayGates = [
  pageLineReuse !== 0
    ? "pageLineReuse"
    : null,
  slotCountViolations !== 0
    ? "slotCountViolations"
    : null,
  cueIdMissing !== 0
    ? "cueIdMissing"
    : null,
  pageIdMissing !== 0
    ? "pageIdMissing"
    : null,
  primaryClipped !== 0
    ? "primaryClipped"
    : null,
  result.gates.stopDrainTimedOut
    ? "stopDrainTimedOut"
    : null,
].filter(Boolean);

if (
  !result.error
  && nonEmptyPageTransitions === 0
) {
  result.error =
    "display gate insufficient: no non-empty cue transition observed";
  console.error(`[live2] ${result.error}`);
} else if (
  !result.error
  && failedDisplayGates.length > 0
) {
  result.error =
    `display gate failed: ${failedDisplayGates.join(", ")}`;
  console.error(`[live2] ${result.error}`);
}

const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace("T", "-")
  .slice(0, 15);
result.generatedAt = new Date().toISOString();
result.displayCoverageNote = coverageNote(
  "single",
  options.displayMode,
);
const resultsDir = path.join(here, "results");
mkdirSync(resultsDir, { recursive: true });
const outFile = path.join(
  resultsDir,
  `live2-${options.caseName}-${options.model}-${options.displayMode}-${stamp}.json`,
);
writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  outFile,
  displayConfig: options.displayMode,
  displayCoverage: "single",
  displayCoverageNote: result.displayCoverageNote,
  showOriginal: options.showOriginal,
  gates: result.gates,
  observations: result.observations,
  error: result.error,
}, null, 2));
process.exit(result.error ? 1 : 0);
