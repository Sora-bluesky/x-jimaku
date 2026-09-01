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
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBenchServer } from "./serve.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

// The overlay can take a while to reach the running state when the on-device
// model is cold, and a fresh checkout has no bench/results directory.
const READY_TIMEOUT_MS = 120000;
const DRAIN_TIMEOUT_MS = 30000;
const DRAIN_QUIET_MS = 6000;
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
};

function parseArgs(argv) {
  const options = {
    caseName: "tts2",
    model: "base",
    backend: "prompt-api",
    durationSeconds: 95,
    chromePath:
      "C:\\Users\\sorab\\AppData\\Local\\Google\\Chrome SxS\\Application\\chrome.exe",
    profile: "C:\\Users\\sorab\\AppData\\Local\\Temp\\x-jimaku-builtin-ai-nano",
    extension: path.join(root, "dist"),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--case") { options.caseName = value; i += 1; }
    else if (flag === "--model") { options.model = value; i += 1; }
    else if (flag === "--backend") { options.backend = value; i += 1; }
    else if (flag === "--duration") { options.durationSeconds = Number(value); i += 1; }
    else if (flag === "--chrome") { options.chromePath = value; i += 1; }
    else if (flag === "--profile") { options.profile = value; i += 1; }
    else if (flag === "--extension") { options.extension = path.resolve(value); i += 1; }
    else if (flag === "--help") { options.help = true; }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  console.log(
    "Usage: node bench/live2.mjs [--case tts|tts2] [--model base] [--backend prompt-api]\n" +
      "                           [--duration 95] [--chrome <exe>] [--profile <dir>] [--extension <dir>]",
  );
  process.exit(0);
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

const definition = CASES[options.caseName];
if (definition === undefined) {
  console.error(
    `[live2] unknown case: ${options.caseName} (known: ${Object.keys(CASES).join(", ")})`,
  );
  process.exit(2);
}

// Puppeteer's headless defaults (--headless, --mute-audio) leak through
// ignoreDefaultArgs, and its --disable-features list disables the Optimization
// Guide that delivers the on-device model.
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
  schemaVersion: 1,
  case: options.caseName,
  model: options.model,
  backend: options.backend,
  durationSeconds: options.durationSeconds,
  collection: "live2 unattended (CDP Extensions.loadUnpacked + autoplay)",
};

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
  const requiredApi =
    options.backend === "translator"
      ? "translator"
      : options.backend === "prompt-api"
        ? "languageModel"
        : null;
  if (requiredApi && result.builtinAi[requiredApi] !== "available") {
    throw new Error(
      `${requiredApi} not ready for --backend ${options.backend}: ${JSON.stringify(result.builtinAi)}`,
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
      showOriginal: false,
      showTentative: false,
    },
  );
  // Settings reach the capture path through storage, which is read independently
  // of this message, so give it a beat before toggling.
  await new Promise((r) => setTimeout(r, 2500));
  console.error(`[live2] settings applied; ${JSON.stringify(result.builtinAi)}`);

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
        console.error(`[live2] ${label}`);
        return true;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
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
  if (!(await waitFor("capture running", RUNNING, READY_TIMEOUT_MS))) {
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
      const texts = [];
      for (const host of document.querySelectorAll("*")) {
        if (!host.shadowRoot) continue;
        for (const el of host.shadowRoot.querySelectorAll(".caption-primary")) {
          const text = el.textContent.trim();
          if (text) texts.push(text);
        }
      }
      return texts.join("␟");
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

  await page.evaluate(async () => {
    const video = document.querySelector("video");
    video.currentTime = 0;
    await video.play();
  });

  // Whatever the drain left on screen predates the window.
  const seedState = lastSeen;



  await page.evaluate((initialState) => {
    window.__caps = [];
    window.__lastState = initialState;
    // A cue occupies two .caption-primary elements, so comparing each element
    // against the previously pushed one lets the pair alternate and records the
    // same cue on every tick. Compare the whole overlay state instead, and push
    // only when it actually changes; a cue that recurs on a later loop pass is a
    // genuine new state and is still recorded.
    window.__capTimer = setInterval(() => {
      const texts = [];
      for (const host of document.querySelectorAll("*")) {
        if (!host.shadowRoot) continue;
        for (const el of host.shadowRoot.querySelectorAll(".caption-primary")) {
          const text = el.textContent.trim();
          if (text) texts.push(text);
        }
      }
      if (texts.length === 0) return;
      const state = texts.join("␟");
      if (state === window.__lastState) return;
      window.__lastState = state;
      window.__caps.push(...texts);
    }, 300);
  }, seedState);

  const started = Date.now();
  const deadline = started + captureMs;
  while (Date.now() < deadline) {
    // Sleeping a fixed step overshoots any duration that is not a multiple of
    // it, which would silently record more audio than durationSeconds claims.
    await new Promise((r) =>
      setTimeout(r, Math.min(10000, deadline - Date.now())),
    );
    const count = await page.evaluate(() => window.__caps.length);
    console.error(
      `[live2] t+${Math.round((Date.now() - started) / 1000)}s lines=${count}`,
    );
  }

  const captured = await page.evaluate(() => {
    clearInterval(window.__capTimer);
    window.postMessage({ t: "CS_DEV_TOGGLE" }, "*");
    return window.__caps.map((t) => t.replace(/\n/g, ""));
  });
  result.recognition = { jaClauses: captured };
} catch (error) {
  result.error = String(error);
  console.error(`[live2] ${result.error}`);
} finally {
  clearTimeout(watchdog);
  const proc = browser.process();
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
result.gates = {
  lines: lines.length,
  englishPassthrough: lines.filter((l) => !japanese.test(l)).length,
  wrongSenseRoma: (joined.match(/ローマ(?!ン)/gu) ?? []).length,
  unresolvedPlaceholders: (joined.match(/%%/gu) ?? []).length,
  romanKept: (joined.match(/(?<![A-Za-z])Roman(?![A-Za-z])/gu) ?? []).length,
};

const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace("T", "-")
  .slice(0, 15);
result.generatedAt = new Date().toISOString();
const resultsDir = path.join(here, "results");
mkdirSync(resultsDir, { recursive: true });
const outFile = path.join(
  resultsDir,
  `live2-${options.caseName}-${options.model}-${stamp}.json`,
);
writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");

console.log(JSON.stringify({ outFile, gates: result.gates, error: result.error }, null, 2));
process.exit(result.error ? 1 : 0);
