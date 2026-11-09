import { cueQueueObservations } from "./cue-queue-observations.mjs";
import { captionDwell, readingSpeed, joinLatency } from "./latency.mjs";
import { computeR1Audio, loadSentenceEnds } from "./r1-audio.mjs";
import puppeteer from "puppeteer-core";
import { jaModel } from "budoux";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  fileURLToPath,
  pathToFileURL,
} from "node:url";
import { startBenchServer } from "./serve.mjs";
import {
  parseArgs,
  resolveDisplayRuns,
  argvForDisplayRun,
  parseChildReport,
  combineDisplayReports,
  annotateDisplayMeta,
  finalizeGates,
  coverageNote,
  assertCaseMedia,
  countPageLineReuse,
  checkBuildInfo,
  cutCaptionLog,
  selectGatePages,
  countQualityGates,
  soakSentences,
  ALLOWED_BACKENDS,
  ALLOWED_PLAMO_MODELS,
  live2ProfilePolicy,
  live2BuildAction,
  createPlamoReadiness,
} from "./live2-config.mjs";
import { createLive2Diagnostics } from "./live2-diagnostics.mjs";
import { cleanupTempProfiles } from "./temp-profiles.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

// The overlay can take a while to reach the running state when the on-device
// model is cold, and a fresh checkout has no bench/results directory.
const READY_TIMEOUT_MS = 120000;
const DRAIN_TIMEOUT_MS = 60000;
const DRAIN_QUIET_MS = 12000;
const STOP_DRAIN_TIMEOUT_MS = 45000;
// Same sets run-bench.mjs validates against. An unvalidated typo is silently
// rejected by the extension, which keeps its previous setting while the result
// JSON claims the one that was asked for.
const ALLOWED_MODELS = ["tiny", "base", "small", "turbo"];
// Must match src/content/index.ts's DEV_ORIGIN. handleOffscreenDevLog only
// relays a dev-log entry (postMessage + console) when the page's own origin
// equals this value (src/content/index.ts:432), so the dev-log relay
// invariant below only applies when the fixture is actually serving it.
const DEV_ORIGIN = "http://127.0.0.1:8123";
const SERVICE_WORKER_START_TIMEOUT_MS =
  20000;
const SERVICE_WORKER_WAKE_INTERVAL_MS =
  3000;
const SERVICE_WORKER_POLL_INTERVAL_MS =
  250;

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
    localOnly: true,
  },
  theo2: {
    mediaFile: path.join(here, "refs", "theo2-speech.wav"),
    contextTerms: ["Anthropic", "Claude", "Opus", "Theo"],
    localOnly: true,
  },
  // Real speech with 35s of digital silence spliced into the middle, to
  // exercise the recognizer's behaviour when a stream goes quiet.
  theosil: {
    mediaFile: path.join(here, "refs", "theosil-speech.wav"),
    contextTerms: ["Anthropic", "Claude", "Opus", "Theo"],
    localOnly: true,
  },
};

async function loadKeepLatinEntries() {
  const sourcePath = path.join(
    root,
    "src",
    "offscreen",
    "glossary.data.ts",
  );
  const copyPath = path.join(
    here,
    "work",
    "name-table.mts",
  );
  mkdirSync(path.dirname(copyPath), {
    recursive: true,
  });
  copyFileSync(sourcePath, copyPath);

  const sourceBytes = readFileSync(sourcePath);
  const copiedBytes = readFileSync(copyPath);
  if (!sourceBytes.equals(copiedBytes)) {
    throw new Error(
      "name table copy check failed: copied bytes differ",
    );
  }

  const nameTableHash = createHash("sha256")
    .update(sourceBytes)
    .digest("hex");
  const [major, minor] =
    process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 18)) {
    throw new Error(
      `live2 needs Node 22.18 or newer to import the name table copy (running ${process.versions.node})`,
    );
  }

  const tableModule = await import(
    `${pathToFileURL(copyPath).href}?sha256=${nameTableHash}`,
  );
  const rows = tableModule.NAME_TERMS;
  if (!Array.isArray(rows)) {
    throw new Error(
      "name table copy check failed: NAME_TERMS is required",
    );
  }

  return rows.map((entry) => {
    if (
      typeof entry.term !== "string" ||
      (
        entry.render !== "latin" &&
        entry.render !== "ja"
      )
    ) {
      throw new Error(
        "name table copy contains an invalid row",
      );
    }

    return {
      term: entry.term,
      render: entry.render,
      ambiguous: entry.ambiguous === true,
    };
  }).filter(
    (entry) => entry.render === "latin",
  );
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

async function readServiceWorkerBuild(
  browser,
  extensionId,
) {
  const extensionOrigin =
    `chrome-extension://${extensionId}`;
  const deadlineAt =
    Date.now()
    + SERVICE_WORKER_START_TIMEOUT_MS;
  let nextWakeAt =
    Date.now()
    + SERVICE_WORKER_WAKE_INTERVAL_MS;
  let wakePage = null;
  let started = false;

  try {
    while (Date.now() < deadlineAt) {
      const target = browser.targets().find(
        (candidate) =>
          candidate.type() === "service_worker"
          && candidate.url().startsWith(
            extensionOrigin,
          ),
      );

      if (target) {
        started = true;
        try {
          const worker =
            await target.worker();
          if (worker) {
            const build =
              await worker.evaluate(
                () =>
                  globalThis
                    .__xJimakuBuild,
              );
            // The module may not have evaluated yet; keep polling until it has.
            if (typeof build === "string") {
              return { started, build };
            }
          }
        } catch {
          // The worker can stop between target discovery and evaluation.
        }
      }

      if (Date.now() >= nextWakeAt) {
        wakePage ??=
          await browser.newPage();
        try {
          await wakePage.goto(
            `${extensionOrigin}/options.html`,
            {
              waitUntil:
                "domcontentloaded",
              timeout:
                SERVICE_WORKER_WAKE_INTERVAL_MS,
            },
          );
        } catch {
          // A blocked extension page is retried until the shared deadline.
        }
        nextWakeAt =
          Date.now()
          + SERVICE_WORKER_WAKE_INTERVAL_MS;
      }

      await new Promise((resolvePoll) =>
        setTimeout(
          resolvePoll,
          SERVICE_WORKER_POLL_INTERVAL_MS,
        ),
      );
    }
  } finally {
    if (wakePage) {
      await wakePage
        .close()
        .catch(() => undefined);
    }
  }

  return {
    started,
    build: undefined,
  };
}

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  console.log(
    "Usage: node bench/live2.mjs [--case tts|tts2] [--model base] [--backend plamo]\n" +
      "                           [--plamo-soak <count>] (translate tts2 without audio/Whisper)\n" +
      "                           [--plamo-model 0.8b|2b|8b] (default: 0.8b)\n" +
      "                           [--duration 95] [--chrome <exe>] [--profile <dir>] [--extension <dir>]\n" +
      "                           [--show-original | --no-show-original]\n" +
      "                           [--dwell-rate <chars/s>] [--dwell-floor-ms <ms>]\n" +
      "                           [--dwell-accel-rate <chars/s>] [--dwell-accel-floor-ms <ms>]\n" +
      "Dwell defaults: normal floor 1500 ms, accelerated floor 1000 ms; rates 0 (flat).\n" +
      "Long dwell can outlast the stop-drain cap; check observations.stopDrainLeftCues.\n" +
      "With neither display flag, both original-off and original-on are captured.\n" +
      "PLaMo downloads its model on first use; progress extends the readiness wait.\n" +
      "PLaMo is the only translation backend.",
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
if (!ALLOWED_PLAMO_MODELS.includes(options.plamoModel)) {
  console.error(`[live2] --plamo-model must be one of: ${ALLOWED_PLAMO_MODELS.join(", ")}`);
  process.exit(2);
}

options.chromePath = path.resolve(
  options.chromePath.trim(),
);
options.profile = path.resolve(
  options.profile.trim(),
);
cleanupTempProfiles({ protectedPaths: [options.profile] });
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

try {
  if (options.plamoSoak !== null) soakSentences(readFileSync(path.join(here, "refs/tts2-script.txt"), "utf8"), options.plamoSoak);
  else assertCaseMedia(definition);
} catch (error) {
  console.error(`[live2] ${error.message}`);
  process.exit(2);
}

if (options.plamoSoak === null && options.displayMode === "both") {
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

// Filled from the extension worker after the capture; see the probe near teardown.
let captionLogEntries = null;
let captionLogDwell = null;
let captionLog = null;

const baseArgs = (await puppeteer
  .defaultArgs({ headless: false }))
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

const server = options.plamoSoak !== null ? { close() {} } : await startBenchServer({
  directory: root,
  mediaFile: definition.mediaFile,
  contextTerms: definition.contextTerms,
});
console.error(`[live2] fixture ${server.caseUrl}`);

mkdirSync(options.profile, {
  recursive: true,
});

// PLaMo's OPFS cache belongs to the profile; a stale worker triggers one reset before measurement.
const profilePolicy = live2ProfilePolicy(options);
let profileDirectoryName = profilePolicy.directoryName;
const profileDirectoryPath = path.resolve(
  options.profile,
  profilePolicy.directoryName,
);
function resetProfileDirectory() {
  const relativeProfileDirectory =
    path.relative(
      options.profile,
      profileDirectoryPath,
    );
  if (
    path.basename(profileDirectoryPath)
      !== profilePolicy.directoryName
    || relativeProfileDirectory
      !== profilePolicy.directoryName
  ) {
    throw new Error(
      `refusing to reset profile directory: ${profileDirectoryPath}`,
    );
  }
  try {
    rmSync(profileDirectoryPath, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 400,
    });
    console.error(
      `[live2] profile directory reset: ${profileDirectoryPath}`,
    );
  } catch (error) {
    const stamp = new Date()
      .toISOString()
      .replace(/[-:.]/g, "");
    profileDirectoryName =
      `${profilePolicy.directoryName}-${stamp}`;
    console.error(
      `[live2] profile directory ${profileDirectoryPath} could not be removed (${error.code ?? error.message}); using ${profileDirectoryName} instead`,
    );
  }
}

if (profilePolicy.reset) resetProfileDirectory();

const launchBrowser = () => puppeteer.launch({
  executablePath: options.chromePath,
  headless: false,
  pipe: true,
  protocolTimeout: 1800000,
  userDataDir: options.profile,
  ignoreDefaultArgs: true,
  args: [
    ...baseArgs,
    `--user-data-dir=${options.profile}`,
    `--profile-directory=${profileDirectoryName}`,
    "--enable-unsafe-extension-debugging",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--no-first-run",
    "--no-default-browser-check",
  ],
});

let browser = await launchBrowser();

const captureMs = options.durationSeconds * 1000;
const result = {
  schemaVersion: 2,
  case: options.caseName,
  model: options.model,
  backend: options.backend,
  plamoModel: options.plamoModel,
  meta: { backend: options.backend, plamoModel: options.plamoModel, dwellPolicy: options.dwellPolicy },
  displayConfig: options.displayMode,
  displayCoverage: "single",
  showOriginal: options.showOriginal,
  durationSeconds: options.durationSeconds,
  profileDirectory:
    profileDirectoryName,
  serviceWorkerBuild: null,
  collection: "live2 unattended (CDP Extensions.loadUnpacked + autoplay)",
  diagnostics: {
    devLog: [],
    clauseTimings: [],
    translationState: [],
    translationPaths: [],
  },
};
let runDiagnostics = null;
let captureRunningAtMs = null;
let replayStartedAtMs = null;

const watchdog = setTimeout(() => {
  console.error("[live2] watchdog fired");
  process.exit(2);
}, READY_TIMEOUT_MS + captureMs + 120000);
watchdog.unref?.();

try {
  let manifest;
  let profileReset = false;
  for (;;) {
    const client = await browser.target().createCDPSession();
    const installed = await client.send("Extensions.loadUnpacked", {
      path: options.extension,
    });
    result.extensionId = installed.id;
    console.error(`[live2] installed extension ${installed.id}`);

    const manifestPath = path.join(
      options.extension,
      "manifest.json",
    );
    manifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    );
    if (
      typeof manifest !== "object"
      || manifest === null
      || Array.isArray(manifest)
      || typeof manifest.version_name
        !== "string"
    ) {
      throw new Error(
        `dist/manifest.json has no string version_name: ${manifestPath}`,
      );
    }

    const workerProbe =
      await readServiceWorkerBuild(
        browser,
        installed.id,
      );
    if (!workerProbe.started) {
      throw new Error(
        "service worker never started",
      );
    }

    result.serviceWorkerBuild =
      typeof workerProbe.build === "string"
        ? workerProbe.build
        : String(workerProbe.build);
    const action = live2BuildAction({
      backend: options.backend,
      workerBuild: result.serviceWorkerBuild,
      expectedBuild: manifest.version_name,
      profileReset,
    });
    if (action === "reuse") break;
    if (action === "fail") {
      throw new Error(
        "service worker build "
        + `${JSON.stringify(result.serviceWorkerBuild)} `
        + "does not match dist/manifest.json "
        + JSON.stringify(manifest.version_name),
      );
    }
    await browser.close();
    resetProfileDirectory();
    profileReset = true;
    result.profileDirectory = profileDirectoryName;
    console.error(`[live2] profile reset because of a stale build: ${profileDirectoryName}`);
    browser = await launchBrowser();
  }
  console.error(
    `[live2] service worker build verified: ${result.serviceWorkerBuild}`,
  );

  let buildInfo;
  try {
    buildInfo = JSON.parse(readFileSync(
      path.join(options.extension, "build-info.json"),
      "utf8",
    ));
  } catch {
    throw new Error(
      "dist/build-info.json is missing; run npm run build",
    );
  }
  const sourceHash = createHash("sha256")
    .update(readFileSync(path.join(root, "src/offscreen/glossary.data.ts")))
    .digest("hex");
  const buildInfoCheck = checkBuildInfo({
    buildInfo,
    sourceHash,
    versionName: manifest.version_name,
  });
  if (!buildInfoCheck.ok) {
    throw new Error(buildInfoCheck.reason);
  }
  const { revision, dirty, builtAt, versionName, nameTableHash } = buildInfo;
  result.build = { revision, dirty, builtAt, versionName };
  result.nameTableHash = nameTableHash;

  if (options.plamoSoak !== null) {
    const target = browser.targets().find(t => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${result.extensionId}/`));
    const worker = await target.worker();
    await worker.evaluate(async () => {
      if (!await chrome.offscreen.hasDocument()) await chrome.offscreen.createDocument({
        url: "offscreen.html", reasons: ["USER_MEDIA"], justification: "Development PLaMo translate-only soak",
      });
    });
    const driver = await browser.newPage();
    await driver.goto(`chrome-extension://${result.extensionId}/options.html`, { waitUntil: "domcontentloaded" });
    const send = message => driver.evaluate(message => chrome.runtime.sendMessage(message), message);
    const check = response => {
      if (!response || response.error) throw new Error(response?.error ?? "PLaMo soak did not answer");
      return response;
    };
    const ready = check(await send({ t: "OFF_DEV_PLAMO_SOAK", action: "start", model: options.plamoModel, contextTerms: CASES.tts2.contextTerms }));
    result.soak = { count: options.plamoSoak, calls: [], timeouts: 0 };
    result.soak.ready = ready.ready;
    watchdog.refresh();
    const sentences = soakSentences(readFileSync(path.join(here, "refs/tts2-script.txt"), "utf8"), options.plamoSoak);
    try {
      for (const [id, text] of sentences.entries()) {
        const call = check(await send({ t: "OFF_DEV_PLAMO_SOAK", action: "translate", id, text }));
        result.soak.calls.push(call);
        result.soak.timeouts += Number(call.timeout);
        watchdog.refresh();
        console.error(`[live2] soak ${id + 1}/${sentences.length}: ${Math.round(call.wallMs)} ms, timeout=${call.timeout}`);
      }
    } finally {
      result.diagnostics.devLog = check(await send({ t: "OFF_DEV_PLAMO_SOAK", action: "stop" })).devLog;
      await driver.close();
    }
  } else {
  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());


  await page.goto(server.caseUrl, { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 1500));
  console.error("[live2] fixture loaded");

  await page.evaluate(() => {
    window.__devLog = [];
    window.__translationState = [];
    window.__plamoLoadedBytes = 0;
    window.__plamoHashedBytes = 0;
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
          const progress = /^PLaMo (download|sha256): (\d+)\/(\d+) bytes$/u.exec(event.data.message ?? "");
          if (progress) {
            const key = progress[1] === "download" ? "__plamoLoadedBytes" : "__plamoHashedBytes";
            window[key] = Math.max(window[key], Number(progress[2]));
          }
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
  runDiagnostics = await createLive2Diagnostics({
    browser, extensionId: result.extensionId, page, diagnostics: result.diagnostics,
  });

  await page.evaluate(
    (settings) => {
      window.postMessage({ t: "CS_DEV_SET_SETTINGS", settings }, "*");
    },
    {
      model: options.model,
      sourceLang: "en",
      translationBackend: options.backend,
      plamoModel: options.plamoModel,
      plamoStyle: "standard",
      showOriginal: options.showOriginal,
      showTentative: true,
      ...(options.dwellPolicy ? { devCueDwell: options.dwellPolicy } : {}),
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
    if (!clearWorker) {
      throw new Error("no-worker-target");
    }
    const w = await clearWorker.worker();
    await w.evaluate(async () => {
      await chrome.storage.local.remove("captionDisplayLog");
    });
    result.captionLogCleared = true;
  } catch (error) {
    result.captionLogCleared = false;
    result.captionLogClearError =
      error instanceof Error ? error.message : String(error);
  }
  console.error(`[live2] settings applied; backend=plamo, plamoModel=${options.plamoModel}`);



  // Replicates the handshake in bench/run-bench.mjs:1305-1319. The tap needs a
  // playing video at dispatch, but WhisperSegmenter.start() begins at the oldest
  // available ring-buffer offset (src/offscreen/segmenter.ts:299-307), so any
  // audio that accumulates while the model loads is replayed into the measured
  // window. Pausing as soon as the tap is acquired keeps that backlog empty.
  //
  // Note the status text: while the capture is running with the video paused the
  // overlay shows the silent-input hint, not 字幕ON (src/content/overlay.ts:1851-1879),
  // so running has to be detected from either wording.
  const RUNNING = ["字幕ON", "音声がありません", "音声を取得できません"];
  const waitFor = async (label, timeoutMs) => {
    const observe = createPlamoReadiness({
      timeoutMs, startedAtMs: Date.now(),
    });
    for (;;) {
      const snapshot = await runDiagnostics.snapshot();
      const running = RUNNING.some(text => snapshot.overlayChipText.includes(text));
      const observed = observe({ ...snapshot, running }, Date.now());
      result.diagnostics.readiness = { ...snapshot, ...observed };
      if (observed.progressed || observed.ready) watchdog.refresh();
      if (observed.ready) {
        const observedAtMs = await page.evaluate(() => Date.now());
        console.error(`[live2] ${label}`);
        return observedAtMs;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
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
      READY_TIMEOUT_MS,
    );
  result.readyBeforePlayback = true;
  const captureState = runDiagnostics.captureState;
  // Those warm-up seconds are still in the capture ring, and
  // WhisperSegmenter.start() begins at the oldest available offset
  // (src/offscreen/segmenter.ts:299-307), so they would be emitted inside the
  // measured window. Pause and wait until rendered captions, the ledger,
  // __devLog (clause-timing / passthrough / queue-drop), and
  // __translationState have all been quiet for the translation deadline.
  await page.evaluate(() => {
    document.querySelector("video").pause();
  });

  const drainSnapshot = () =>
    page.evaluate(() => {
      const blocks = [];
      let tentative = "";
      const ledger = [];
      for (const host of document.querySelectorAll("*")) {
        if (!host.shadowRoot) continue;
        const lines = [
          ...host.shadowRoot.querySelectorAll(".caption-primary"),
        ].map((el) => el.textContent.trim());
        if (lines.length === 2) blocks.push(lines);
        const tentativeText =
          host.shadowRoot.querySelector(".caption-tentative")
            ?.textContent.trim() ?? "";
        if (tentativeText) tentative = tentativeText;
        for (const entry of host.shadowRoot.querySelectorAll(
          ".caption-ledger > *",
        )) {
          const text = entry.textContent.trim();
          if (text) ledger.push(text);
        }
      }
      return [
        blocks.map((lines) => lines.join("␟")).join("␞"),
        tentative,
        ledger.join("\n"),
        `log:${(window.__devLog ?? []).length}`,
        `ts:${(window.__translationState ?? []).length}`,
      ].join("␞");
    });

  const drainStartedAt = Date.now();
  let quietSince = drainStartedAt;
  let lastSeen = await drainSnapshot();
  const drainDeadline = drainStartedAt + DRAIN_TIMEOUT_MS;
  let drained = false;
  while (Date.now() < drainDeadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const now = await drainSnapshot();
    if (now !== lastSeen) {
      lastSeen = now;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= DRAIN_QUIET_MS) {
      drained = true;
      break;
    }
  }
  if (!drained) {
    throw new Error(
      `backlog did not drain within ${DRAIN_TIMEOUT_MS}ms`,
    );
  }
  result.drainMs = Date.now() - drainStartedAt;
  result.diagnostics.warmupDevLog = await page.evaluate(() => window.__devLog);
  result.diagnostics.warmupTranslationState = await page.evaluate(() => window.__translationState);
  console.error("[live2] backlog drained; opening the window");


  await page.evaluate(() => {
    window.__samples = [];
    window.__cueQueueEvents = [];
    const queueBaseline = new WeakMap();
    const queueSnapshot = host => ({
      waitingCues: Number(host.dataset.cueWaiting ?? 0),
      cueDrops: Number(host.dataset.cueDrops ?? 0),
      cueMerges: Number(host.dataset.cueMerges ?? 0),
      cueDiscards: Number(host.dataset.cueDiscards ?? 0),
    });
    for (const host of document.querySelectorAll("#xjsub-host")) {
      queueBaseline.set(host, queueSnapshot(host));
    }
    window.__cueQueueObserver = new MutationObserver(records => {
      const hosts = new Set(records.map(record => record.target)
        .filter(host => host.id === "xjsub-host"));
      for (const host of hosts) {
        const current = queueSnapshot(host);
        const baseline = queueBaseline.get(host) ?? { cueDrops: 0, cueMerges: 0, cueDiscards: 0 };
        window.__cueQueueEvents.push({ sampledAtMs: Date.now(), ...current,
          cueDrops: current.cueDrops - baseline.cueDrops,
          cueMerges: current.cueMerges - baseline.cueMerges,
          cueDiscards: current.cueDiscards - baseline.cueDiscards });
      }
    });
    window.__cueQueueObserver.observe(document, { subtree: true, attributes: true,
      attributeFilter: ["data-cue-waiting", "data-cue-drops", "data-cue-merges", "data-cue-discards"] });
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
          waitingCues: Number(host.dataset.cueWaiting ?? 0),
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

  const playback = await page.evaluate(async () => {
    window.__devLog = [];
    window.__translationState = [];
    const video = document.querySelector("video");
    video.currentTime = 0;
    let playing = null;
    const onPlaying = () => {
      playing = { observedAtMs: performance.timeOrigin + performance.now(),
        currentTimeSeconds: video.currentTime, event: "playing" };
    };
    video.addEventListener("playing", onPlaying, { once: true });
    const replayStartedAtMs = Date.now();
    await video.play();
    video.removeEventListener("playing", onPlaying);
    return { replayStartedAtMs, mediaPlayback: playing ?? {
      observedAtMs: performance.timeOrigin + performance.now(),
      currentTimeSeconds: video.currentTime, event: "play-resolved" } };
  });
  replayStartedAtMs = playback.replayStartedAtMs;
  result.mediaPlayback = playback.mediaPlayback;
  result.replayStartedAt = new Date(replayStartedAtMs).toISOString();
  const started = replayStartedAtMs;
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
    if ((await captureState())?.status === "idle") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  result.stopDrainTimedOut = (await captureState())?.status !== "idle";
  await new Promise((r) => setTimeout(r, 1000));

  const captured = await page.evaluate(() => {
    clearInterval(window.__capTimer);
    window.__cueQueueObserver.disconnect();

    return {
      devLog: window.__devLog,
      translationState:
        window.__translationState,
      ledgerClauses: window.__ledger,
      samples: window.__samples,
      cueQueueEvents: window.__cueQueueEvents,
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
    cueQueueEvents: captured.cueQueueEvents,
  };

  if (result.stopDrainTimedOut) {
    throw new Error(
      `capture remained RUNNING after ${STOP_DRAIN_TIMEOUT_MS}ms stop drain`,
    );
  }
  }
} catch (error) {
  result.error = String(error);
  if (error.readiness) result.diagnostics.readiness = error.readiness;
  if (runDiagnostics) {
    await runDiagnostics.saveFailure(replayStartedAtMs).catch(probeError => {
      result.diagnostics.collectionErrors.push(`failure diagnostics: ${String(probeError)}`);
    });
  }
  console.error(`[live2] ${result.error}`);
} finally {
  clearTimeout(watchdog);
  runDiagnostics?.stop();
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

        return {
          entries: pages.length,
          pages,
          lines: Array.isArray(value?.lines) ? value.lines : null,
          drops: Array.isArray(value?.drops) ? value.drops : null,
          ...(value?.linesTruncated !== undefined
            ? { linesTruncated: value.linesTruncated }
            : {}),
          ...(value?.dropsTruncated !== undefined
            ? { dropsTruncated: value.dropsTruncated }
            : {}),
        };
      });
      captionLog = probe;
      captionLogEntries = probe.entries;
    }
  } catch (error) {
    captionLogEntries = `probe-failed: ${String(error).slice(0, 120)}`;
  }
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 15000))]);
  if (proc && proc.exitCode === null) proc.kill("SIGKILL");
  await server.close?.();
}

if (options.plamoSoak !== null) {
  result.generatedAt = new Date().toISOString();
  const outFile = path.join(here, "results", `live2-plamo-soak-${options.plamoModel}-${result.generatedAt.replace(/[:.]/gu, "-")}.json`);
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outFile, calls: result.soak?.calls.length, timeouts: result.soak?.timeouts, error: result.error }, null, 2));
  process.exit(result.error ? 1 : 0);
}

const lines = result.recognition?.jaClauses ?? [];
if (!result.error && lines.length === 0) {
  // A missed toggle, a failed capture or a renamed overlay selector all end here
  // with no exception, and the file would be unusable to score-ja.
  result.error = "capture produced no caption lines";
  console.error(`[live2] ${result.error}`);
}
// clause-timing fires once per terminal (ledger) line, so terminal lines with
// zero clause-timing entries means the devLog relay broke somewhere between
// handleOffscreenDevLog's postMessage and this bench's listener, even though
// the overlay still rendered captions through the independent DOM path this
// bench also drains. Gated to the fixture origin because the relay is
// deliberately limited to it (src/content/index.ts:432); elsewhere, a
// clause-timing-less run is expected, not a bug.
if (
  !result.error
  && lines.length > 0
  && result.diagnostics.clauseTimings.length === 0
  && new URL(server.caseUrl).origin === DEV_ORIGIN
) {
  result.error =
    "terminal lines present but devLog has no clause-timing entries";
  console.error(`[live2] ${result.error}`);
}
const joined = lines.join("\n");
const japanese = /[\u3040-\u30ff\u4e00-\u9fff]/u;
const gateWindow = selectGatePages({
  pages: captionLog?.pages, lines: captionLog?.lines, replayStartedAtMs,
});
result.gateWindow = { ...gateWindow, pages: undefined, mode: "asr-finalized-after-replay" };
result.latency = joinLatency({ devLog: [...(result.diagnostics.warmupDevLog ?? []), ...result.diagnostics.devLog], pages: captionLog?.pages, replayStartedAtMs });
captionLogDwell = captionDwell(gateWindow.pages);
result.latency.r1Audio = computeR1Audio({ pages: captionLog?.pages,
  shownPages: captionLogDwell.pages, replayStartedAtMs,
  mediaPlayback: result.mediaPlayback, fixture: loadSentenceEnds(result.case) });

if (!result.error && (!captionLog?.pages || gateWindow.missing > 0 || gateWindow.pages.length === 0)) {
  result.error = "capture-time gate evidence missing or no eligible pages";
}
const gatePageIds = new Set(gateWindow.pages.map(page => `${page.cueId}\0${page.pageId}`));
const samples = (result.display?.samples ?? []).filter(sample =>
  !sample.hasPrimaryText || sample.slotCountViolation || sample.cueId === "" || sample.pageId === ""
  || gatePageIds.has(`${sample.cueId}\0${sample.pageId}`));
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

const captionCut = cutCaptionLog({
  ...(typeof captionLogEntries === "number"
    && Number.isFinite(replayStartedAtMs) ? captionLog : {}),
  replayStartedAtMs,
});
result.pagesUnparsed = captionCut.pagesUnparsed;
result.linesUnparsed = captionCut.linesUnparsed;
result.dropsUnparsed = captionCut.dropsUnparsed;
if (captionLog?.linesTruncated !== undefined) {
  result.linesTruncated = captionLog.linesTruncated;
}
if (captionLog?.dropsTruncated !== undefined) {
  result.dropsTruncated = captionLog.dropsTruncated;
}
result.display = {
  ...(result.display ?? {}),
  pages: captionCut.pages,
  lines: captionCut.lines,
  drops: captionCut.drops,
  blocks: pageBlocks,
};

const pageLineReuse = countPageLineReuse(pageBlocks);
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
  const model = jaModel;
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

const keepLatinEntries =
  await loadKeepLatinEntries();
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
  englishPassthroughSource: "caption-display-log/asr-finalized-after-replay",
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
  readingSpeed: readingSpeed(captionLogDwell?.pages),
  ...cueQueueObservations({ samples: result.display?.samples,
    events: result.display?.cueQueueEvents, drops: captionCut.drops, replayStartedAtMs }),
  glossaryLatinKept,
  glossaryLatinLost,
  keepLatinSourceHits,
  maskedNameOccurrences,
  katakanaNameHits,
  katakanaNameHitsAmbiguous,
  katakanaNameHitsPlain,
};

result.observations.stopDrainLeftCues = Math.max(0, result.observations.cueQueue.waitingAtStop ?? 0);
if (result.observations.stopDrainLeftCues > 0) {
  console.error(`[live2] warning: ${result.observations.stopDrainLeftCues} captions were still waiting when the stop drain ended`);
}

result.diagnostics.primaryClippedExample =
  primaryClippedExample;

result.gates = annotateDisplayMeta({
  lines: lines.length,
  ...countQualityGates(gateWindow.pages),
  devLogQueueDrop:
    devLogKindCounts["queue-drop"],
  devLogPassthrough:
    devLogKindCounts.passthrough,
  devLogOther:
    devLogKindCounts.other,
  clauseTranslateMsP50,
  clauseTranslateMsP90,
  clauseDeadlineHits,
  clauseTimingSamples:
    clauseTranslateMs.length,
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

Object.assign(result, finalizeGates(result));

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
  meta: result.meta,
  displayConfig: options.displayMode,
  displayCoverage: "single",
  displayCoverageNote: result.displayCoverageNote,
  showOriginal: options.showOriginal,
  gates: result.gates,
  gatesSuppressed: result.gatesSuppressed,
  observations: result.observations,
  error: result.error,
}, null, 2));
process.exit(result.error ? 1 : 0);
