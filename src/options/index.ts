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
  type TranslatorProbeResult,
  type WebGpuProbeResult,
} from "../shared/messages";

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

const runTranslatorButton =
  requireElement<HTMLButtonElement>("run-translator");
const fetchLastButton =
  requireElement<HTMLButtonElement>("fetch-last");
const statusElement =
  requireElement<HTMLElement>("status");
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

console.log("[options]", "diagnostics page loaded");

renderRows(environmentResults, [
  ["Extension version", chrome.runtime.getManifest().version],
  ["User agent", navigator.userAgent],
  [
    "Chrome version",
    getProbeEnvironment().chromeVersion ?? "不明",
  ],
]);

renderRows(translatorResults, [
  ["状態", "未実行"],
]);

renderRows(storedResults, [
  ["状態", "未取得"],
]);

void optionsWebGpuPromise.then((result) => {
  console.log("[options]", "WebGPU probe complete", result);
  renderWebGpu(result);
});

runTranslatorButton.addEventListener("click", () => {
  void runOptionsTranslatorProbe();
});

fetchLastButton.addEventListener("click", () => {
  void fetchLastProbeResults();
});

async function runOptionsTranslatorProbe(): Promise<void> {
  setBusy(runTranslatorButton, true);
  setStatus("Translator availabilityを確認しています…");

  const requestId =
    createProbeRequestId("options-translator");
  const startedAt = nowIso();

  try {
    const translatorPromise = probeTranslator();
    const [translator, webgpu] = await Promise.all([
      translatorPromise,
      optionsWebGpuPromise,
    ]);

    const result: OptionsPageProbeResult = {
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

    const message: OptionsPageProbeResultMessage = {
      t: "OPTIONS_PROBE_RESULT",
      requestId,
      result,
    };

    const response = (await chrome.runtime.sendMessage(
      message,
    )) as unknown;

    if (
      isMessageOfType(response, "PROBE_STORED") &&
      response.requestId === requestId
    ) {
      setStatus(
        `Translator probe完了。結果を保存しました（${response.storedAt}）。`,
      );
      return;
    }

    if (
      isMessageOfType(response, "PROBE_ERROR") &&
      response.requestId === requestId
    ) {
      setStatus(
        `プローブは完了しましたが保存に失敗しました: ${response.error.message}`,
      );
      return;
    }

    setStatus(
      "プローブは完了しましたが、保存応答を確認できませんでした。",
    );
  } catch (error) {
    console.error(
      "[options]",
      "Translator probe failed",
      error,
    );
    setStatus(
      `Translator probeに失敗しました: ${toProbeError(error).message}`,
    );
  } finally {
    setBusy(runTranslatorButton, false);
  }
}

async function fetchLastProbeResults(): Promise<void> {
  setBusy(fetchLastButton, true);
  setStatus("保存済みプローブ結果を取得しています…");

  try {
    const response = (await chrome.runtime.sendMessage({
      t: "GET_LAST_PROBE",
    })) as unknown;

    if (isMessageOfType(response, "LAST_PROBE_RESULT")) {
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

    if (isMessageOfType(response, "PROBE_ERROR")) {
      throw new Error(response.error.message);
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
    const adapter = await gpu.requestAdapter();

    return {
      context: "options-page",
      apiAvailable: true,
      adapterAvailable: adapter !== null,
      ...(adapter === null
        ? {}
        : {
            adapterInfo: readAdapterInfo(adapter),
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
  const scope = globalThis as TranslatorScope;
  const exposed = "Translator" in scope;

  if (
    !exposed ||
    typeof scope.Translator?.availability !== "function"
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

function renderWebGpu(result: WebGpuProbeResult): void {
  renderRows(webGpuResults, [
    ["navigator.gpu", result.apiAvailable],
    ["Adapter available", result.adapterAvailable],
    ["Adapter info", result.adapterInfo],
    ["Started", result.startedAt],
    ["Completed", result.completedAt],
    ["Error", result.error],
  ]);
}

function renderTranslator(
  result: TranslatorProbeResult,
): void {
  renderRows(translatorResults, [
    ["Translator exposed", result.exposed],
    ["Availability", result.availability],
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
    readonly [label: string, value: TableValue]
  >,
): void {
  container.replaceChildren(
    ...rows.map(([label, value]) => {
      const row = document.createElement("tr");
      const heading = document.createElement("th");
      const cell = document.createElement("td");

      heading.scope = "row";
      heading.textContent = label;
      cell.textContent = formatValue(value);
      row.append(heading, cell);

      return row;
    }),
  );
}

function formatValue(value: TableValue): string {
  if (value === undefined || value === null) {
    return "—";
  }

  if (typeof value === "object") {
    return JSON.stringify(value, null, 2);
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

  const record = rawInfo as Record<string, unknown>;
  const vendor = nonEmptyString(record.vendor);
  const architecture = nonEmptyString(
    record.architecture,
  );

  if (
    vendor === undefined &&
    architecture === undefined
  ) {
    return undefined;
  }

  return {
    ...(vendor === undefined ? {} : { vendor }),
    ...(architecture === undefined
      ? {}
      : { architecture }),
  };
}

function nonEmptyString(
  value: unknown,
): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value
    : undefined;
}

function setBusy(
  button: HTMLButtonElement,
  busy: boolean,
): void {
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
}

function setStatus(message: string): void {
  statusElement.textContent = message;
}

function requireElement<T extends HTMLElement>(
  id: string,
): T {
  const element = document.getElementById(id);

  if (element === null) {
    throw new Error(`Missing required element #${id}`);
  }

  return element as T;
}
