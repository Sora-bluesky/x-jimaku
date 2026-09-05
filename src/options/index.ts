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
  type TranslationPath,
  type TranslatorProbeResult,
  type WebGpuProbeResult,
} from "../shared/messages";
import {
  isSettings,
  isSourceLanguage,
  isTranslationBackend,
  isWhisperModel,
  readSettings,
  SETTINGS_STORAGE_KEY,
  writeSettings,
  type WhisperModel,
} from "../shared/settings";
import {
  CAPTION_DISPLAY_LOG_ENABLED_KEY,
  clearCaptionDisplayLog,
  formatCaptionDisplayLogExport,
  readCaptionDisplayLogEnabled,
  readCaptionDisplayLogDocument,
  writeCaptionDisplayLogEnabled,
} from "../shared/caption-display-log";
import type {
  CaptureState,
  CaptureStatus,
} from "../shared/state";
import {
  recommendModel,
} from "./model-recommendation";

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
const prepareTranslationButton =
  requireElement<HTMLButtonElement>(
    "prepare-translation",
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
const activeTranslationPath =
  requireElement<HTMLElement>(
    "active-translation-path",
  );
const recognitionLog =
  requireElement<HTMLOListElement>(
    "recognition-log",
  );
const modelSelect =
  requireElement<HTMLSelectElement>(
    "model-select",
  );
const modelRecommendationElement =
  requireElement<HTMLElement>(
    "model-recommendation",
  );
const sourceLanguageSelect =
  requireElement<HTMLSelectElement>(
    "source-language-select",
  );
const translationBackendSelect =
  requireElement<HTMLSelectElement>(
    "translation-backend-select",
  );
const showOriginalInput =
  requireElement<HTMLInputElement>(
    "show-original",
  );
const showTentativeInput =
  requireElement<HTMLInputElement>(
    "show-tentative",
  );
const recordCaptionDisplayInput =
  requireElement<HTMLInputElement>(
    "record-caption-display",
  );
const copyCaptionLogButton =
  requireElement<HTMLButtonElement>(
    "copy-caption-log",
  );
const downloadCaptionLogButton =
  requireElement<HTMLButtonElement>(
    "download-caption-log",
  );
const clearCaptionLogButton =
  requireElement<HTMLButtonElement>(
    "clear-caption-log",
  );
const captionLogStatus =
  requireElement<HTMLElement>(
    "caption-log-status",
  );
const settingsStatus =
  requireElement<HTMLElement>(
    "settings-status",
  );
const translationAvailability =
  requireElement<HTMLElement>(
    "translation-availability",
  );
const translationProgressContainer =
  requireElement<HTMLElement>(
    "translation-progress-container",
  );
const translationProgress =
  requireElement<HTMLProgressElement>(
    "translation-progress",
  );
const translationProgressValue =
  requireElement<HTMLOutputElement>(
    "translation-progress-value",
  );
const translationStatus =
  requireElement<HTMLElement>(
    "translation-status",
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
let currentCaptureRequestId:
  | string
  | null = null;
let modelRecommendation:
  | WhisperModel
  | null = null;
let settingsInitialized = false;

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
void initializeCaptionDisplayLogControls();
void refreshTranslationAvailability();

void optionsWebGpuPromise.then((result) => {
  console.log(
    "[options]",
    "WebGPU probe complete",
    result,
  );
  renderWebGpu(result);

  modelRecommendation = recommendModel(
    result.adapterInfo,
    result.adapterAvailable
      ? "webgpu"
      : "wasm",
  );
  renderModelRecommendation();
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

prepareTranslationButton.addEventListener(
  "click",
  () => {
    prepareTranslationModel();
  },
);

recordCaptionDisplayInput.addEventListener(
  "change",
  () => {
    void saveCaptionDisplayLogEnabled();
  },
);

copyCaptionLogButton.addEventListener(
  "click",
  () => {
    void copyCaptionDisplayLog();
  },
);

downloadCaptionLogButton.addEventListener(
  "click",
  () => {
    void downloadCaptionDisplayLog();
  },
);

clearCaptionLogButton.addEventListener(
  "click",
  () => {
    void clearCaptionDisplayLogFromPage();
  },
);

modelSelect.addEventListener(
  "change",
  () => {
    renderModelRecommendation();
  },
);

for (const control of [
  modelSelect,
  sourceLanguageSelect,
  translationBackendSelect,
  showOriginalInput,
  showTentativeInput,
]) {
  control.addEventListener(
    "change",
    () => {
      void saveSelectedSettings();
    },
  );
}

chrome.storage.onChanged.addListener(
  (changes, areaName) => {
    if (areaName === "local") {
      if (
        changes[
          CAPTION_DISPLAY_LOG_ENABLED_KEY
        ] !== undefined
      ) {
        recordCaptionDisplayInput.checked =
          changes[
            CAPTION_DISPLAY_LOG_ENABLED_KEY
          ].newValue !== false;
      }

      return;
    }

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

    if (isSettings(next)) {
      applySettingsToControls(next);
      return;
    }

    void initializeSettings();
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
            "SW_TRANSLATION_STATE",
          )
        ) {
          if (
            currentCaptureRequestId !== null &&
            message.requestId !==
              currentCaptureRequestId
          ) {
            return;
          }

          activeTranslationPath.textContent =
            translationPathDescription(
              message.path,
            );
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

      console.info(
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
    applySettingsToControls(settings);
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

function applySettingsToControls(
  settings: {
    model: string;
    sourceLang: string;
    translationBackend: string;
    showOriginal: boolean;
    showTentative: boolean;
  },
): void {
  modelSelect.value = settings.model;
  sourceLanguageSelect.value =
    settings.sourceLang;
  translationBackendSelect.value =
    settings.translationBackend;
  showOriginalInput.checked =
    settings.showOriginal;
  showTentativeInput.checked =
    settings.showTentative;
  settingsInitialized = true;
  renderModelRecommendation();
}

function renderModelRecommendation(): void {
  const visible =
    settingsInitialized &&
    modelRecommendation !== null &&
    modelSelect.value !==
      modelRecommendation;

  modelRecommendationElement.hidden =
    !visible;
  modelRecommendationElement.textContent =
    visible
      ? `この環境では ${modelRecommendation} を推奨`
      : "";
}

async function saveSelectedSettings(): Promise<void> {
  const selectedModel = modelSelect.value;
  const selectedSourceLanguage =
    sourceLanguageSelect.value;
  const selectedTranslationBackend =
    translationBackendSelect.value;

  if (!isWhisperModel(selectedModel)) {
    settingsStatus.textContent =
      "選択されたモデルが不正です。";
    return;
  }

  if (
    !isSourceLanguage(
      selectedSourceLanguage,
    )
  ) {
    settingsStatus.textContent =
      "選択された音声言語が不正です。";
    return;
  }

  if (
    !isTranslationBackend(
      selectedTranslationBackend,
    )
  ) {
    settingsStatus.textContent =
      "選択された翻訳エンジンが不正です。";
    return;
  }

  setSettingsControlsDisabled(true);
  settingsStatus.textContent =
    "設定を保存しています…";

  try {
    await writeSettings({
      model: selectedModel,
      sourceLang:
        selectedSourceLanguage,
      translationBackend:
        selectedTranslationBackend,
      showOriginal:
        showOriginalInput.checked,
      showTentative:
        showTentativeInput.checked,
    });

    settingsStatus.textContent =
      "設定を保存しました。次回のキャプチャ開始時に適用します。";
  } catch (error) {
    console.error(
      "[options]",
      "could not save settings",
      error,
    );
    settingsStatus.textContent =
      `設定の保存に失敗しました: ${toProbeError(error).message}`;
  } finally {
    setSettingsControlsDisabled(false);
  }
}

function setSettingsControlsDisabled(
  disabled: boolean,
): void {
  modelSelect.disabled = disabled;
  sourceLanguageSelect.disabled = disabled;
  translationBackendSelect.disabled =
    disabled;
  showOriginalInput.disabled = disabled;
  showTentativeInput.disabled = disabled;
}

async function initializeCaptionDisplayLogControls():
  Promise<void> {
  try {
    recordCaptionDisplayInput.checked =
      await readCaptionDisplayLogEnabled();
  } catch (error) {
    captionLogStatus.textContent =
      `表示ログ設定の読込に失敗しました: ${toProbeError(error).message}`;
  }
}

async function saveCaptionDisplayLogEnabled():
  Promise<void> {
  try {
    await writeCaptionDisplayLogEnabled(
      recordCaptionDisplayInput.checked,
    );
    captionLogStatus.textContent =
      recordCaptionDisplayInput.checked
        ? "表示ログの記録を開始します。"
        : "表示ログの記録を止めました。";
  } catch (error) {
    captionLogStatus.textContent =
      `表示ログ設定の保存に失敗しました: ${toProbeError(error).message}`;
  }
}

async function copyCaptionDisplayLog():
  Promise<void> {
  try {
    const text =
      await buildCaptionDisplayLogExport();
    await navigator.clipboard.writeText(
      text,
    );
    captionLogStatus.textContent =
      "表示ログをコピーしました。";
  } catch (error) {
    captionLogStatus.textContent =
      `表示ログのコピーに失敗しました: ${toProbeError(error).message}`;
  }
}

async function downloadCaptionDisplayLog():
  Promise<void> {
  try {
    const text =
      await buildCaptionDisplayLogExport();
    const stamp = nowIso().replaceAll(
      /[:.]/g,
      "",
    );
    const blob = new Blob(
      [text],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const anchor =
      document.createElement("a");
    anchor.href = url;
    anchor.download =
      `x-jimaku-caption-log-${stamp}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    captionLogStatus.textContent =
      "表示ログをダウンロードしました。";
  } catch (error) {
    captionLogStatus.textContent =
      `表示ログのダウンロードに失敗しました: ${toProbeError(error).message}`;
  }
}

async function clearCaptionDisplayLogFromPage():
  Promise<void> {
  try {
    await clearCaptionDisplayLog();
    captionLogStatus.textContent =
      "表示ログを消しました。";
  } catch (error) {
    captionLogStatus.textContent =
      `表示ログの削除に失敗しました: ${toProbeError(error).message}`;
  }
}

async function buildCaptionDisplayLogExport():
  Promise<string> {
  const document =
    await readCaptionDisplayLogDocument();

  return formatCaptionDisplayLogExport(
    document,
    nowIso(),
  );
}

async function refreshTranslationAvailability(): Promise<void> {
  const result = await probeTranslator();

  renderTranslationAvailability(
    result.availability,
    result.exposed,
  );

  if (result.error !== undefined) {
    translationStatus.textContent =
      `Translatorの確認に失敗しました: ${result.error.message}`;
  }
}

function prepareTranslationModel(): void {
  const scope =
    globalThis as TranslatorScope;
  const factory = scope.Translator;

  if (
    factory === undefined ||
    typeof factory.create !== "function"
  ) {
    translationStatus.textContent =
      "このChromeではTranslator APIを利用できません。";
    return;
  }

  setBusy(
    prepareTranslationButton,
    true,
  );
  translationProgressContainer.hidden =
    false;
  updateTranslationProgress(0);
  translationStatus.textContent =
    "翻訳モデルを準備しています…";

  let creation:
    Promise<TranslatorInstance>;

  try {
    creation = factory.create({
      sourceLanguage: "en",
      targetLanguage: "ja",
      monitor(monitor) {
        monitor.addEventListener(
          "downloadprogress",
          (event) => {
            updateTranslationProgress(
              normalizeDownloadProgress(
                event,
              ),
            );
          },
        );
      },
    });
  } catch (error) {
    finishTranslationPreparationFailure(
      error,
    );
    return;
  }

  void creation
    .then((translator) => {
      try {
        translator.destroy();
      } finally {
        updateTranslationProgress(100);
        translationStatus.textContent =
          "翻訳モデルの準備が完了しました。";
      }
    })
    .catch((error: unknown) => {
      finishTranslationPreparationFailure(
        error,
      );
    })
    .finally(() => {
      void refreshTranslationAvailability()
        .finally(() => {
          setBusy(
            prepareTranslationButton,
            false,
          );
        });
    });
}

function finishTranslationPreparationFailure(
  error: unknown,
): void {
  console.error(
    "[options]",
    "translation model preparation failed",
    error,
  );
  translationStatus.textContent =
    `翻訳モデルの準備に失敗しました: ${toProbeError(error).message}`;
  setBusy(
    prepareTranslationButton,
    false,
  );
}

function normalizeDownloadProgress(
  event: BuiltinAiDownloadProgressEvent,
): number {
  if (
    event.total !== undefined &&
    Number.isFinite(event.total) &&
    event.total > 0
  ) {
    return Math.max(
      0,
      Math.min(
        100,
        event.loaded /
          event.total *
          100,
      ),
    );
  }

  return Math.max(
    0,
    Math.min(100, event.loaded * 100),
  );
}

function updateTranslationProgress(
  progress: number,
): void {
  const safeProgress = Math.max(
    0,
    Math.min(100, progress),
  );
  const rounded =
    Math.round(safeProgress);

  translationProgress.value =
    safeProgress;
  translationProgressValue.value =
    `${rounded}%`;
  translationProgressValue.textContent =
    `${rounded}%`;
}

function renderTranslationAvailability(
  availability:
    | BuiltinTranslatorAvailability
    | null,
  exposed: boolean,
): void {
  translationAvailability.textContent =
    exposed
      ? translatorAvailabilityDescription(
          availability,
        )
      : "API未対応";

  prepareTranslationButton.disabled =
    !exposed ||
    availability === null ||
    availability === "unavailable" ||
    availability === "available";

  prepareTranslationButton.textContent =
    availability === "available"
      ? "翻訳モデル準備済み"
      : "翻訳モデルを準備する";
}

function translatorAvailabilityDescription(
  availability:
    | BuiltinTranslatorAvailability
    | null,
): string {
  switch (availability) {
    case "available":
      return "利用可能";
    case "downloadable":
      return "ダウンロード可能";
    case "downloading":
      return "ダウンロード中";
    case "unavailable":
      return "利用不可";
    case null:
      return "確認失敗";
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
    renderTranslationAvailability(
      translator.availability,
      translator.exposed,
    );

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
    activeTranslationPath.textContent =
      "選択中…";
  }

  currentCaptureRequestId =
    state.requestId ?? null;

  captureStateName.textContent =
    captureStatusDescription(state.status);
  captureStateDot.dataset.state =
    state.status;
  captureStateDot.title =
    captureStatusDescription(state.status);

  if (state.status === "loadingModel") {
    const progress = Math.max(
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
    activeTranslationPath.textContent =
      "—";
  }

  if (
    state.status === "idle" ||
    state.status === "stopping"
  ) {
    activeTranslationPath.textContent =
      "—";
  }

  if (
    state.status === "idle" &&
    state.requestId === undefined
  ) {
    activeModel.textContent = "—";
    activeDevice.textContent = "—";
    currentCaptureRequestId = null;
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

function translationPathDescription(
  path: TranslationPath,
): string {
  switch (path) {
    case "offscreen-translator":
      return "翻訳API（Offscreen Chrome Translator）";
    case "content-translator":
      return "翻訳API（Content Script Chrome Translator）";
    case "language-model":
      return "AIモデル（ブラウザ内蔵 LanguageModel）";
    case "none":
      return "翻訳なし（英語原文）";
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

  const body =
    document.createElement("span");
  body.className = "recognition-body";

  if (
    message.ja !== undefined &&
    message.ja.trim() !== ""
  ) {
    const japanese =
      document.createElement("span");
    japanese.className =
      "recognition-ja";
    japanese.textContent = message.ja;

    const original =
      document.createElement("span");
    original.className =
      "recognition-original";
    original.textContent = message.text;

    body.append(japanese, original);
  } else {
    const source =
      document.createElement("span");
    source.textContent = message.text;
    body.append(source);
  }

  item.dataset.final =
    String(message.final);
  item.replaceChildren(time, body);

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
