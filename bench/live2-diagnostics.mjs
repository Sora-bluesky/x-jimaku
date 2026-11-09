// These probes run before browser teardown, including when readiness throws.
export function readLive2PageState() {
  let overlayChipText = "";
  for (const host of document.querySelectorAll("*")) {
    const chip = host.shadowRoot?.querySelector(".target-chip");
    if (chip) {
      overlayChipText = chip.textContent.trim();
      break;
    }
  }
  const asr = (window.__devLog ?? []).findLast(entry =>
    entry.level !== "error"
    && /whisper|asr|recogniz/iu.test(`${entry.tag} ${entry.message} ${entry.data?.kind}`)
    && /init|load|progress|warm|ready/iu.test(`${entry.message} ${entry.data?.kind}`));
  return {
    path: window.__translationState?.at(-1)?.path,
    loadedBytes: window.__plamoLoadedBytes ?? 0,
    hashedBytes: window.__plamoHashedBytes ?? 0,
    overlayChipText,
    // Exclude arrival/clock fields: repeated log traffic is not forward progress.
    asrProgress: asr ? { tag: asr.tag, message: asr.message, kind: asr.data?.kind,
      progress: asr.data?.progress, phase: asr.data?.phase, loaded: asr.data?.loaded } : null,
    devLog: window.__devLog ?? [],
    translationState: window.__translationState ?? [],
  };
}

export async function createLive2Diagnostics({ browser, extensionId, page, diagnostics }) {
  const prefix = `chrome-extension://${extensionId}/`;
  const attached = new WeakSet();
  const pending = new Set();
  let lastPageLogs = null;
  diagnostics.offscreenConsoleErrors = [];
  diagnostics.offscreenConsoleTargets = [];
  diagnostics.collectionErrors = [];
  diagnostics.captureState = null;
  diagnostics.overlayChipText = null;
  const recordError = (probe, error) => {
    const message = `${probe}: ${String(error)}`;
    if (!diagnostics.collectionErrors.includes(message)) diagnostics.collectionErrors.push(message);
  };
  const attach = async target => {
    if (target.url() !== `${prefix}offscreen.html` || attached.has(target)) return;
    attached.add(target);
    try {
      const session = await target.createCDPSession();
      session.on("Runtime.consoleAPICalled", event => {
        if (event.type !== "error" && event.type !== "assert") return;
        diagnostics.offscreenConsoleErrors.push({
          type: event.type, url: target.url(), arrivedAtMs: Date.now(),
          text: event.args.map(arg => typeof arg.value === "string" ? arg.value
            : arg.description ?? JSON.stringify(arg.value) ?? arg.type).join(" "),
          stackTrace: event.stackTrace,
        });
      });
      session.on("Runtime.exceptionThrown", event => {
        const details = event.exceptionDetails;
        diagnostics.offscreenConsoleErrors.push({ type: "exception", url: target.url(),
          arrivedAtMs: Date.now(), text: details.exception?.description ?? details.text,
          stackTrace: details.stackTrace });
      });
      await session.send("Runtime.enable");
      diagnostics.offscreenConsoleTargets.push(target.url());
    } catch (error) {
      recordError("offscreen console", error);
    }
  };
  const onTarget = target => {
    const job = attach(target);
    pending.add(job);
    void job.finally(() => pending.delete(job));
  };
  browser.on("targetcreated", onTarget);
  browser.on("targetchanged", onTarget);
  await Promise.all(browser.targets().map(attach));

  const readCaptureState = async () => {
    try {
      const target = browser.targets().find(target => target.url().startsWith(prefix)
        && (target.type() === "service_worker" || target.type() === "background_page"));
      if (!target) throw new Error("no-worker-target");
      const worker = await target.worker();
      const state = await worker.evaluate(async () =>
        (await chrome.storage.session.get("m1.captureState"))["m1.captureState"] ?? null);
      diagnostics.captureState = state;
      return state;
    } catch (error) {
      recordError("m1.captureState", error);
      return null;
    }
  };
  const snapshot = async () => {
    const [pageState, captureState] = await Promise.all([page.evaluate(readLive2PageState), readCaptureState()]);
    const { devLog, translationState, ...state } = pageState;
    lastPageLogs = { devLog, translationState };
    diagnostics.overlayChipText = state.overlayChipText;
    diagnostics.readinessSnapshot = { ...state, captureState };
    return diagnostics.readinessSnapshot;
  };
  return {
    snapshot,
    captureState: readCaptureState,
    async saveFailure(replayStartedAtMs) {
      // Each probe survives failure of the others and cannot mask the run error.
      await Promise.all([
        snapshot().catch(error => recordError("readiness snapshot", error)),
        ...browser.targets().map(attach),
      ]);
      if (lastPageLogs) {
        const normalize = entries => entries.map(({ arrivedAtMs, ...entry }) => ({
          ...entry, arrivedAtMs,
          ...(Number.isFinite(replayStartedAtMs) ? { arrivalMs: arrivedAtMs - replayStartedAtMs } : {}),
        }));
        diagnostics.devLog = normalize(lastPageLogs.devLog);
        diagnostics.clauseTimings = diagnostics.devLog.filter(entry => entry.data?.kind === "clause-timing");
        diagnostics.translationState = normalize(lastPageLogs.translationState);
        diagnostics.translationPaths = [...new Set(lastPageLogs.translationState.map(entry => entry.path).filter(Boolean))];
      }
      await Promise.all([...pending]);
    },
    stop() {
      browser.off("targetcreated", onTarget);
      browser.off("targetchanged", onTarget);
    },
  };
}
