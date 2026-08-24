import {
  createProbeRequestId,
  getProbeEnvironment,
  isMessageOfType,
  nowIso,
  toProbeError,
  type AdapterInfo,
  type OptionsPageProbeResult,
  type OptionsPageProbeResultMessage,
  type ProbeSnapshot,
  type SwRecognitionMessage,
  type TranslatorProbeResult,
  type WebGpuProbeResult,
} from "../shared/messages";
import {
  isWhisperModel,
  readSettings,
  SETTINGS_STORAGE_KEY,
  writeSettings,
} from "../shared/settings";
import type {
  CaptureState,
  CaptureStatus,
} from "../shared/state";

interface GpuLike {
  requestAdapter(): Promise<GpuAdapterLike | null>;
}

interface GpuAdapterLike {
  readonly info?: unknown;
}

type TranslatorScope = typeof globalThis & {
  Translator?: TranslatorFactory;
};

type TableValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | object;

const OPTIONS_PORT_NAME = "options";
const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 4_000;
const MAX_RECOGNITION_LINES = 50;

const runDiagnosticsButton =
  requireElement<HTMLButtonElement>(
    "run-diagnostics",
  );
const runTranslatorButton =
  requireElement<HTMLButtonElement>(
    "run-translator",
  );
const fetchLastButton =
  requireElement<HTMLButtonElement>(
    "fetch-last",
  );
const statusElement =
  requireElement<HTMLElement>(
    "probe-status",
  );
const captureStateDot =
  requireElement<HTMLElement>(
    "capture-state-dot",
  );
const captureStateName =
  requireElement<HTMLElement>(
    "capture-state-name",
  );
const levelMeter =
  requireElement<HTMLElement>(
    "level-meter",
  );
const levelFill =
  requireElement<HTMLElement>(
    "level-fill",
  );
const levelValue =
  requireElement<HTMLOutputElement>(
    "level-value",
  );
const modelProgressContainer =
  requireElement<HTMLElement>(
    "model-progress-container",
  );
const modelProgress =
  requireElement<HTMLProgressElement>(
    "model-progress",
  );
const modelProgressValue =
  requireElement<HTMLOutputElement>(
    "model-progress-value",
  );
const activeModel =
  requireElement<HTMLElement>(
    "active-model",
  );
const activeDevice =
  requireElement<HTMLElement>(
    "active-device",
  );
const recognitionLog =
  requireElement<HTMLOListElement>(
    "recognition-log",
  );
const modelSelect =
  requireElement<HTMLSelectElement>(
    "model-select",
  );
const settingsStatus =
  requireElement<HTMLElement>(
    "settings-status",
  );
const environmentResults =
  requireElement<HTMLTableSectionElement>(
    "environment-results",
  );
const webGpuResults =
  requireElement<HTMLTableSectionElement>(
    "webgpu-results",
  );
const translatorResults =
  requireElement<HTMLTableSectionElement>(
    "translator-results",
  );
const storedResults =
  requireElement<HTMLTableSectionElement>(
    "stored-results",
  );

const optionsWebGpuPromise = probeWebGpu();
const recognitionElements =
  new Map<number, HTMLLIElement>();

let optionsPort:
  | chrome.runtime.Port
  | null = null;
let reconnectTimerId: number | null = null;
let reconnectDelayMs =
  INITIAL_RECONNECT_DELAY_MS;
let meterTarget = 0;
let meterCurrent = 0;
let meterAnimationPending = false;
let renderedCaptureRequestId:
  | string
  | null = null;

console.log(
  "[options]",
  "diagnostics page loaded",
);

renderRows(environmentResults, [
  [
    "Extension version",
    chrome.runtime.getManifest().version,
  ],
  ["User agent", navigator.userAgent],
  [
    "Chrome version",
    getProbeEnvironment().chromeVersion ??
      "不明",
  ],
]);

renderRows(translatorResults, [
  ["状態", "未実行"],
]);

renderRows(storedResults, [
  ["状態", "未取得"],
]);

renderCaptureState({
  status: "idle",
  updatedAt: nowIso(),
});

connectOptionsPort();
void initializeSettings();

void optionsWebGpuPromise.then((result) => {
  console.log(
    "[options]",
    "WebGPU probe complete",
    result,
  );
  renderWebGpu(result);
});

runDiagnosticsButton.addEventListener(
  "click",
  () => {
    void runBackgroundDiagnostics();
  },
);

runTranslatorButton.addEventListener(
  "click",
  () => {
    void runOptionsTranslatorProbe();
  },
);

fetchLastButton.addEventListener(
  "click",
  () => {
    void fetchLastProbeResults();
  },
);

modelSelect.addEventListener(
  "change",
  () => {
    void saveSelectedModel();
  },
);

chrome.storage.onChanged.addListener(
  (changes, areaName) => {
    if (
      areaName !== "sync" ||
      changes[SETTINGS_STORAGE_KEY] ===
        undefined
    ) {
      return;
    }

    const next =
      changes[SETTINGS_STORAGE_KEY]
        .newValue as unknown;

    if (
      typeof next === "object" &&
      next !== null &&
      "model" in next &&
      isWhisperModel(next.model)
    ) {
      modelSelect.value = next.model;
    }
  },
);

function connectOptionsPort(): void {
  if (optionsPort !== null) {
    return;
  }

  if (reconnectTimerId !== null) {
    globalThis.clearTimeout(
      reconnectTimerId,
    );
    reconnectTimerId = null;
  }

  try {
    const port = chrome.runtime.connect({
      name: OPTIONS_PORT_NAME,
    });

    optionsPort = port;
    reconnectDelayMs =
      INITIAL_RECONNECT_DELAY_MS;

    port.onMessage.addListener(
      (message: unknown) => {
        if (
          isMessageOfType(
            message,
            "OFF_STATE",
          )
        ) {
          renderCaptureState(message.state);
          return;
        }

        if (
          isMessageOfType(
            message,
            "OFF_LEVEL",
          )
        ) {
          updateMeter(message.rms);
          return;
        }

        if (
          isMessageOfType(
            message,
            "SW_RECOG",
          )
        ) {
          renderRecognitionLine(message);
        }
      },
    );

    port.onDisconnect.addListener(() => {
      if (optionsPort === port) {
        optionsPort = null;
      }

      const disconnectError =
        chrome.runtime.lastError?.message;

      console.warn(
        "[options]",
        "background port disconnected",
        disconnectError ?? "",
      );

      schedulePortReconnect();
    });

    console.log(
      "[options]",
      "background port connected",
    );
  } catch (error) {
    console.warn(
      "[options]",
      "could not connect background port",
      error,
    );
    schedulePortReconnect();
  }
}

function schedulePortReconnect(): void {
  if (reconnectTimerId !== null) {
    return;
  }

  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(
    reconnectDelayMs * 2,
    MAX_RECONNECT_DELAY_MS,
  );

  reconnectTimerId =
    window.setTimeout(() => {
      reconnectTimerId = null;
      connectOptionsPort();
    }, delay);
}

async function initializeSettings(): Promise<void> {
  try {
    const settings = await readSettings();
    modelSelect.value = settings.model;
  } catch (error) {
    console.error(
      "[options]",
      "could not read settings",
      error,
    );
    settingsStatus.textContent =
      `設定の読込に失敗しました: ${toProbeError(error).message}`;
  }
}

async function saveSelectedModel(): Promise<void> {
  const selected = modelSelect.value;

  if (!isWhisperModel(selected)) {
    settingsStatus.textContent =
      "選択されたモデルが不正です。";
    return;
  }

  modelSelect.disabled = true;
  settingsStatus.textContent =
    "設定を保存しています…";

  try {
    await writeSettings({
      model: selected,
    });

    settingsStatus.textContent =
      `${selected}を保存しました。次回のキャプチャ開始時に適用します。`;
  } catch (error) {
    console.error(
      "[options]",
      "could not save settings",
      error,
    );
    settingsStatus.textContent =
      `設定の保存に失敗しました: ${toProbeError(error).message}`;
  } finally {
    modelSelect.disabled = false;
  }
}

async function runBackgroundDiagnostics(): Promise<void> {
  setBusy(runDiagnosticsButton, true);
  setStatus(
    "Offscreen documentとWorkerの診断を実行しています…",
  );

  const requestId =
    createProbeRequestId(
      "options-diagnostics",
    );

  try {
    const response =
      (await chrome.runtime.sendMessage({
        t: "RUN_DIAGNOSTICS",
        requestId,
      })) as unknown;

    if (
      isMessageOfType(
        response,
        "DIAGNOSTICS_RESULT",
      ) &&
      response.requestId === requestId
    ) {
      renderSnapshot(response.snapshot);
      setStatus(
        "Offscreen documentとWorkerの診断が完了しました。",
      );
      console.log(
        "[options]",
        "background diagnostics complete",
        response.snapshot,
      );
      return;
    }

    if (
      isMessageOfType(
        response,
        "PROBE_ERROR",
      ) &&
      response.requestId === requestId
    ) {
      throw new Error(
        response.error.message,
      );
    }

    throw new Error(
      "Background returned an invalid diagnostics response",
    );
  } catch (error) {
    console.error(
      "[options]",
      "background diagnostics failed",
      error,
    );
    setStatus(
      `診断に失敗しました: ${toProbeError(error).message}`,
    );
  } finally {
    setBusy(
      runDiagnosticsButton,
      false,
    );
  }
}

async function runOptionsTranslatorProbe(): Promise<void> {
  setBusy(runTranslatorButton, true);
  setStatus(
    "Translator availabilityを確認しています…",
  );

  const requestId =
    createProbeRequestId(
      "options-translator",
    );
  const startedAt = nowIso();

  try {
    const translatorPromise =
      probeTranslator();
    const [translator, webgpu] =
      await Promise.all([
        translatorPromise,
        optionsWebGpuPromise,
      ]);

    const result:
      OptionsPageProbeResult = {
        context: "options-page",
        requestId,
        startedAt,
        completedAt: nowIso(),
        environment: getProbeEnvironment(),
        webgpu,
        translator,
      };

    renderTranslator(translator);
    console.log(
      "[options]",
      "Translator probe complete",
      result,
    );

    const message:
      OptionsPageProbeResultMessage = {
        t: "OPTIONS_PROBE_RESULT",
        requestId,
        result,
      };

    const response =
      (await chrome.runtime.sendMessage(
        message,
      )) as unknown;

    if (
      isMessageOfType(
        response,
        "PROBE_STORED",
      ) &&
      response.requestId === requestId
    ) {
      setStatus(
        `Translator診断完了。結果を保存しました（${response.storedAt}）。`,
      );
      return;
    }

    if (
      isMessageOfType(
        response,
        "PROBE_ERROR",
      ) &&
      response.requestId === requestId
    ) {
      setStatus(
        `診断は完了しましたが保存に失敗しました: ${response.error.message}`,
      );
      return;
    }

    setStatus(
      "診断は完了しましたが、保存応答を確認できませんでした。",
    );
  } catch (error) {
    console.error(
      "[options]",
      "Translator probe failed",
      error,
    );
    setStatus(
      `Translator診断に失敗しました: ${toProbeError(error).message}`,
    );
  } finally {
    setBusy(
      runTranslatorButton,
      false,
    );
  }
}

async function fetchLastProbeResults(): Promise<void> {
  setBusy(fetchLastButton, true);
  setStatus(
    "保存済みプローブ結果を取得しています…",
  );

  try {
    const response =
      (await chrome.runtime.sendMessage({
        t: "GET_LAST_PROBE",
      })) as unknown;

    if (
      isMessageOfType(
        response,
        "LAST_PROBE_RESULT",
      )
    ) {
      renderSnapshot(response.snapshot);
      setStatus(
        response.snapshot === null
          ? "保存済みプローブ結果はありません。"
          : "保存済みプローブ結果を取得しました。",
      );
      console.log(
        "[options]",
        "stored probe results fetched",
        response.snapshot,
      );
      return;
    }

    if (
      isMessageOfType(
        response,
        "PROBE_ERROR",
      )
    ) {
      throw new Error(
        response.error.message,
      );
    }

    throw new Error(
      "Background returned an invalid response",
    );
  } catch (error) {
    console.error(
      "[options]",
      "could not fetch stored probe results",
      error,
    );
    setStatus(
      `保存済み結果の取得に失敗しました: ${toProbeError(error).message}`,
    );
  } finally {
    setBusy(fetchLastButton, false);
  }
}

async function probeWebGpu(): Promise<WebGpuProbeResult> {
  const startedAt = nowIso();
  const gpu = (
    navigator as Navigator & {
      gpu?: GpuLike;
    }
  ).gpu;

  if (gpu === undefined) {
    return {
      context: "options-page",
      apiAvailable: false,
      adapterAvailable: false,
      startedAt,
      completedAt: nowIso(),
      environment: getProbeEnvironment(),
    };
  }

  try {
    const adapter =
      await gpu.requestAdapter();

    return {
      context: "options-page",
      apiAvailable: true,
      adapterAvailable: adapter !== null,
      ...(adapter === null
        ? {}
        : {
            adapterInfo:
              readAdapterInfo(adapter),
          }),
      startedAt,
      completedAt: nowIso(),
      environment: getProbeEnvironment(),
    };
  } catch (error) {
    return {
      context: "options-page",
      apiAvailable: true,
      adapterAvailable: false,
      startedAt,
      completedAt: nowIso(),
      environment: getProbeEnvironment(),
      error: toProbeError(error),
    };
  }
}

async function probeTranslator(): Promise<TranslatorProbeResult> {
  const startedAt = nowIso();
  const scope =
    globalThis as TranslatorScope;
  const exposed = "Translator" in scope;

  if (
    !exposed ||
    typeof scope.Translator?.availability !==
      "function"
  ) {
    return {
      context: "options-page",
      exposed,
      availability: null,
      startedAt,
      completedAt: nowIso(),
      environment: getProbeEnvironment(),
      ...(exposed
        ? {
            error: {
              name: "TypeError",
              message:
                "Translator exists but availability() is not callable",
            },
          }
        : {}),
    };
  }

  try {
    const availability =
      await scope.Translator.availability({
        sourceLanguage: "en",
        targetLanguage: "ja",
      });

    return {
      context: "options-page",
      exposed: true,
      availability,
      startedAt,
      completedAt: nowIso(),
      environment: getProbeEnvironment(),
    };
  } catch (error) {
    return {
      context: "options-page",
      exposed: true,
      availability: null,
      startedAt,
      completedAt: nowIso(),
      environment: getProbeEnvironment(),
      error: toProbeError(error),
    };
  }
}

function renderCaptureState(
  state: CaptureState,
): void {
  if (
    state.requestId !== undefined &&
    state.requestId !==
      renderedCaptureRequestId &&
    (
      state.status === "starting" ||
      state.status === "loadingModel" ||
      state.status === "running"
    )
  ) {
    clearRecognitionLog();
    renderedCaptureRequestId =
      state.requestId;
  }

  captureStateName.textContent =
    captureStatusDescription(state.status);
  captureStateDot.dataset.state =
    state.status;
  captureStateDot.title =
    captureStatusDescription(state.status);

  if (state.status === "loadingModel") {
    const progress =
      Math.max(
        0,
        Math.min(100, state.progress ?? 0),
      );

    captureStateName.textContent =
      `モデル読込中（${Math.round(progress)}%）`;
    modelProgressContainer.hidden = false;
    modelProgress.value = progress;
    modelProgressValue.value =
      `${Math.round(progress)}%`;
    modelProgressValue.textContent =
      `${Math.round(progress)}%`;
  } else {
    modelProgressContainer.hidden = true;
  }

  activeModel.textContent =
    state.model ?? "—";
  activeDevice.textContent =
    state.device ?? "—";

  if (state.status !== "running") {
    updateMeter(0);
  }

  if (
    state.status === "error" &&
    state.error !== undefined
  ) {
    captureStateName.textContent =
      `エラー: ${state.error.message}`;
  }

  if (
    state.status === "idle" &&
    state.requestId === undefined
  ) {
    activeModel.textContent = "—";
    activeDevice.textContent = "—";
  }
}

function captureStatusDescription(
  status: CaptureStatus,
): string {
  switch (status) {
    case "idle":
      return "停止中";
    case "starting":
      return "開始処理中";
    case "loadingModel":
      return "モデル読込中";
    case "running":
      return "音声認識中";
    case "stopping":
      return "停止処理中";
    case "error":
      return "エラー";
  }
}

function renderRecognitionLine(
  message: SwRecognitionMessage,
): void {
  let item =
    recognitionElements.get(message.id);

  if (item === undefined) {
    item = document.createElement("li");
    item.className = "recognition-line";
    item.dataset.id = String(message.id);
    recognitionElements.set(
      message.id,
      item,
    );
    recognitionLog.append(item);
  }

  const time =
    document.createElement("time");
  time.dateTime = message.at;
  time.textContent =
    formatRecognitionTime(message.at);

  const text =
    document.createElement("span");
  text.textContent = message.text;

  item.dataset.final =
    String(message.final);
  item.replaceChildren(time, text);

  trimRecognitionLog();
  recognitionLog.scrollTop =
    recognitionLog.scrollHeight;
}

function clearRecognitionLog(): void {
  recognitionElements.clear();
  recognitionLog.replaceChildren();
}

function trimRecognitionLog(): void {
  while (
    recognitionLog.children.length >
    MAX_RECOGNITION_LINES
  ) {
    const first =
      recognitionLog.firstElementChild;

    if (!(first instanceof HTMLLIElement)) {
      first?.remove();
      continue;
    }

    const id = Number(first.dataset.id);

    if (Number.isSafeInteger(id)) {
      recognitionElements.delete(id);
    }

    first.remove();
  }
}

function formatRecognitionTime(
  timestamp: string,
): string {
  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleTimeString(
    "ja-JP",
    {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    },
  );
}

function updateMeter(rms: number): void {
  const safeRms = Number.isFinite(rms)
    ? Math.max(0, rms)
    : 0;

  meterTarget = Math.min(
    1,
    Math.sqrt(Math.min(1, safeRms)),
  );
  levelValue.value =
    safeRms.toFixed(4);
  levelValue.textContent =
    safeRms.toFixed(4);

  if (!meterAnimationPending) {
    meterAnimationPending = true;
    requestAnimationFrame(
      animateMeter,
    );
  }
}

function animateMeter(): void {
  meterCurrent +=
    (meterTarget - meterCurrent) * 0.24;

  if (
    Math.abs(
      meterTarget - meterCurrent,
    ) < 0.001
  ) {
    meterCurrent = meterTarget;
  }

  const percentage = Math.max(
    0,
    Math.min(100, meterCurrent * 100),
  );

  levelFill.style.width =
    `${percentage}%`;
  levelMeter.setAttribute(
    "aria-valuenow",
    percentage.toFixed(1),
  );

  if (meterCurrent !== meterTarget) {
    requestAnimationFrame(
      animateMeter,
    );
    return;
  }

  meterAnimationPending = false;
}

function renderWebGpu(
  result: WebGpuProbeResult,
): void {
  renderRows(webGpuResults, [
    [
      "navigator.gpu",
      result.apiAvailable,
    ],
    [
      "Adapter available",
      result.adapterAvailable,
    ],
    [
      "Adapter info",
      result.adapterInfo,
    ],
    ["Started", result.startedAt],
    ["Completed", result.completedAt],
    ["Error", result.error],
  ]);
}

function renderTranslator(
  result: TranslatorProbeResult,
): void {
  renderRows(translatorResults, [
    [
      "Translator exposed",
      result.exposed,
    ],
    [
      "Availability",
      result.availability,
    ],
    ["Started", result.startedAt],
    ["Completed", result.completedAt],
    ["Error", result.error],
  ]);
}

function renderSnapshot(
  snapshot: ProbeSnapshot | null,
): void {
  if (snapshot === null) {
    renderRows(storedResults, [
      ["状態", "保存済み結果なし"],
    ]);
    return;
  }

  renderRows(storedResults, [
    ["Updated", snapshot.updatedAt],
    [
      "Offscreen WebGPU",
      snapshot.offscreen?.webgpu.document,
    ],
    [
      "Worker WebGPU",
      snapshot.offscreen?.webgpu.worker,
    ],
    [
      "Offscreen Translator",
      snapshot.offscreen?.translator,
    ],
    [
      "Content-script Translator",
      snapshot.contentScript,
    ],
    [
      "Options-page Translator",
      snapshot.optionsPage?.translator,
    ],
  ]);
}

function renderRows(
  container: HTMLTableSectionElement,
  rows: ReadonlyArray<
    readonly [
      label: string,
      value: TableValue,
    ]
  >,
): void {
  container.replaceChildren(
    ...rows.map(([label, value]) => {
      const row =
        document.createElement("tr");
      const heading =
        document.createElement("th");
      const cell =
        document.createElement("td");

      heading.scope = "row";
      heading.textContent = label;
      cell.textContent =
        formatValue(value);
      row.append(heading, cell);

      return row;
    }),
  );
}

function formatValue(
  value: TableValue,
): string {
  if (
    value === undefined ||
    value === null
  ) {
    return "—";
  }

  if (typeof value === "object") {
    return JSON.stringify(
      value,
      null,
      2,
    );
  }

  return String(value);
}

function readAdapterInfo(
  adapter: GpuAdapterLike,
): AdapterInfo | undefined {
  const rawInfo = adapter.info;

  if (
    typeof rawInfo !== "object" ||
    rawInfo === null
  ) {
    return undefined;
  }

  const record =
    rawInfo as Record<string, unknown>;
  const vendor =
    nonEmptyString(record.vendor);
  const architecture =
    nonEmptyString(record.architecture);

  if (
    vendor === undefined &&
    architecture === undefined
  ) {
    return undefined;
  }

  return {
    ...(vendor === undefined
      ? {}
      : { vendor }),
    ...(architecture === undefined
      ? {}
      : { architecture }),
  };
}

function nonEmptyString(
  value: unknown,
): string | undefined {
  return (
    typeof value === "string" &&
    value.length > 0
  )
    ? value
    : undefined;
}

function setBusy(
  button: HTMLButtonElement,
  busy: boolean,
): void {
  button.disabled = busy;
  button.setAttribute(
    "aria-busy",
    String(busy),
  );
}

function setStatus(
  message: string,
): void {
  statusElement.textContent = message;
}

function requireElement<
  T extends HTMLElement,
>(
  id: string,
): T {
  const element =
    document.getElementById(id);

  if (element === null) {
    throw new Error(
      `Missing required element #${id}`,
    );
  }

  return element as T;
}
