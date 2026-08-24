import {
  getProbeEnvironment,
  isCapturePortMessage,
  isMessageOfType,
  nowIso,
  toProbeError,
  type AdapterInfo,
  type M1Message,
  type OffscreenProbeResult,
  type OffscreenProbeResultMessage,
  type ProbeFailureMessage,
  type TranslatorProbeResult,
  type WebGpuProbeResult,
  type WorkerProbeRequest,
} from "../shared/messages";
import {
  createCaptureState,
  type CaptureState,
} from "../shared/state";
import {
  AudioCapture,
  type AudioCaptureCallbacks,
} from "./audio-capture";

interface GpuLike {
  requestAdapter(): Promise<GpuAdapterLike | null>;
}

interface GpuAdapterLike {
  readonly info?: unknown;
}

type TranslatorScope = typeof globalThis & {
  Translator?: TranslatorFactory;
};

const OFFSCREEN_PORT_NAME = "offscreen";
const INITIAL_RECONNECT_DELAY_MS = 100;
const MAX_RECONNECT_DELAY_MS = 1_000;

const audioCapture = new AudioCapture();

let backgroundPort: chrome.runtime.Port | null = null;
let reconnectTimerId: number | null = null;
let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
let localCaptureState =
  createCaptureState("idle");
let latestRms = 0;
let captureOperationTail: Promise<void> =
  Promise.resolve();

console.log("[offscreen]", "document ready");

chrome.runtime.onMessage.addListener(
  (
    message: unknown,
    _sender,
    sendResponse: (
      response:
        | OffscreenProbeResultMessage
        | ProbeFailureMessage,
    ) => void,
  ): boolean => {
    if (!isMessageOfType(message, "PROBE")) {
      return false;
    }

    console.log(
      "[offscreen]",
      "probe request received",
      message.requestId,
    );

    void runOffscreenProbe(message.requestId)
      .then((result) => {
        const response: OffscreenProbeResultMessage = {
          t: "OFFSCREEN_PROBE_RESULT",
          requestId: message.requestId,
          result,
        };

        console.log(
          "[offscreen]",
          "probe complete",
          result,
        );
        sendResponse(response);
      })
      .catch((error: unknown) => {
        console.error(
          "[offscreen]",
          "probe failed",
          error,
        );

        sendResponse({
          t: "PROBE_ERROR",
          requestId: message.requestId,
          source: "offscreen",
          error: toProbeError(error),
          at: nowIso(),
        });
      });

    return true;
  },
);

connectBackgroundPort();

function connectBackgroundPort(): void {
  if (backgroundPort !== null) {
    return;
  }

  if (reconnectTimerId !== null) {
    globalThis.clearTimeout(reconnectTimerId);
    reconnectTimerId = null;
  }

  try {
    const port = chrome.runtime.connect({
      name: OFFSCREEN_PORT_NAME,
    });

    backgroundPort = port;
    reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;

    port.onMessage.addListener(
      (message: unknown) => {
        if (!isCapturePortMessage(message)) {
          console.warn(
            "[offscreen]",
            "ignored malformed port message",
            message,
          );
          return;
        }

        if (
          isMessageOfType(message, "OFF_START")
        ) {
          void enqueueCaptureOperation(() =>
            handleCaptureStart(
              message.streamId,
              message.requestId,
            ),
          );
          return;
        }

        if (isMessageOfType(message, "OFF_STOP")) {
          void enqueueCaptureOperation(() =>
            handleCaptureStop(message.requestId),
          );
        }
      },
    );

    port.onDisconnect.addListener(() => {
      if (backgroundPort === port) {
        backgroundPort = null;
      }

      const disconnectError =
        chrome.runtime.lastError?.message;

      console.warn(
        "[offscreen]",
        "background port disconnected",
        disconnectError ?? "",
      );

      scheduleReconnect();
    });

    console.log(
      "[offscreen]",
      "background port connected",
    );

    postState();
    postLevel();
  } catch (error) {
    console.warn(
      "[offscreen]",
      "could not connect background port",
      error,
    );
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (reconnectTimerId !== null) {
    return;
  }

  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(
    reconnectDelayMs * 2,
    MAX_RECONNECT_DELAY_MS,
  );

  reconnectTimerId = globalThis.setTimeout(() => {
    reconnectTimerId = null;
    connectBackgroundPort();
  }, delay);
}

function enqueueCaptureOperation(
  operation: () => Promise<void>,
): Promise<void> {
  const next = captureOperationTail
    .catch(() => undefined)
    .then(operation);

  captureOperationTail = next.catch(
    (error: unknown) => {
      console.error(
        "[offscreen]",
        "capture operation failed",
        error,
      );
    },
  );

  return next;
}

async function handleCaptureStart(
  streamId: string,
  requestId: string,
): Promise<void> {
  if (audioCapture.isActive()) {
    if (
      localCaptureState.requestId === requestId &&
      localCaptureState.status === "running"
    ) {
      postState();
      return;
    }

    publishState(
      createCaptureState("error", {
        requestId,
        error: {
          name: "InvalidStateError",
          message:
            "An audio capture session is already active",
        },
      }),
    );
    return;
  }

  publishState(
    createCaptureState("starting", {
      requestId,
    }),
  );

  const callbacks: AudioCaptureCallbacks = {
    onLevel(rms) {
      latestRms = rms;
      postLevel();
    },

    onEnded(endedRequestId) {
      void enqueueCaptureOperation(async () => {
        if (
          localCaptureState.requestId !==
          endedRequestId
        ) {
          return;
        }

        publishState(
          createCaptureState("stopping", {
            requestId: endedRequestId,
          }),
        );

        latestRms = 0;
        postLevel();

        publishState(
          createCaptureState("idle", {
            requestId: endedRequestId,
          }),
        );
      });
    },
  };

  try {
    await audioCapture.start(
      streamId,
      requestId,
      callbacks,
    );

    publishState(
      createCaptureState("running", {
        requestId,
      }),
    );

    console.log("[offscreen]", "capture running", {
      requestId,
    });
  } catch (error) {
    console.error(
      "[offscreen]",
      "capture start failed",
      error,
    );

    latestRms = 0;
    postLevel();

    publishState(
      createCaptureState("error", {
        requestId,
        error: toProbeError(error),
      }),
    );
  }
}

async function handleCaptureStop(
  requestId: string,
): Promise<void> {
  publishState(
    createCaptureState("stopping", {
      requestId,
    }),
  );

  try {
    await audioCapture.stop();

    latestRms = 0;
    postLevel();

    publishState(
      createCaptureState("idle", {
        requestId,
      }),
    );

    console.log("[offscreen]", "capture stopped", {
      requestId,
    });
  } catch (error) {
    console.error(
      "[offscreen]",
      "capture cleanup failed",
      error,
    );

    publishState(
      createCaptureState("error", {
        requestId,
        error: toProbeError(error),
      }),
    );
  }
}

function publishState(
  state: CaptureState,
): void {
  localCaptureState = state;
  postState();
}

function postState(): void {
  postToBackground({
    t: "OFF_STATE",
    state: localCaptureState,
  });
}

function postLevel(): void {
  postToBackground({
    t: "OFF_LEVEL",
    rms: latestRms,
    at: nowIso(),
  });
}

function postToBackground(
  message: M1Message,
): void {
  if (backgroundPort === null) {
    scheduleReconnect();
    return;
  }

  try {
    backgroundPort.postMessage(message);
  } catch (error) {
    console.warn(
      "[offscreen]",
      "could not post background message",
      error,
    );
  }
}

async function runOffscreenProbe(
  requestId: string,
): Promise<OffscreenProbeResult> {
  const startedAt = nowIso();

  const [documentWebGpu, translator, workerWebGpu] =
    await Promise.all([
      probeWebGpu("offscreen-document"),
      probeTranslator(),
      probeWorkerWebGpu(requestId),
    ]);

  console.log(
    "[offscreen]",
    "document WebGPU result",
    documentWebGpu,
  );
  console.log(
    "[offscreen]",
    "worker WebGPU result",
    workerWebGpu,
  );
  console.log(
    "[offscreen]",
    "Translator result",
    translator,
  );

  return {
    context: "offscreen-document",
    requestId,
    startedAt,
    completedAt: nowIso(),
    environment: getProbeEnvironment(),
    webgpu: {
      document: documentWebGpu,
      worker: workerWebGpu,
    },
    translator,
  };
}

async function probeWebGpu(
  context: WebGpuProbeResult["context"],
): Promise<WebGpuProbeResult> {
  const startedAt = nowIso();
  const gpu = (
    navigator as Navigator & {
      gpu?: GpuLike;
    }
  ).gpu;

  if (gpu === undefined) {
    return {
      context,
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
      context,
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
      context,
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
      context: "offscreen-document",
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
      context: "offscreen-document",
      exposed: true,
      availability,
      startedAt,
      completedAt: nowIso(),
      environment: getProbeEnvironment(),
    };
  } catch (error) {
    return {
      context: "offscreen-document",
      exposed: true,
      availability: null,
      startedAt,
      completedAt: nowIso(),
      environment: getProbeEnvironment(),
      error: toProbeError(error),
    };
  }
}

async function probeWorkerWebGpu(
  requestId: string,
): Promise<WebGpuProbeResult> {
  const startedAt = nowIso();
  let worker: Worker;

  try {
    worker = new Worker(
      new URL(
        "../worker/probe.worker.ts",
        import.meta.url,
      ),
      { type: "module" },
    );
  } catch (error) {
    return createWorkerFailure(startedAt, error);
  }

  return new Promise<WebGpuProbeResult>((resolve) => {
    const finish = (
      result: WebGpuProbeResult,
    ): void => {
      worker.removeEventListener(
        "message",
        handleMessage,
      );
      worker.removeEventListener(
        "error",
        handleError,
      );
      worker.terminate();
      resolve(result);
    };

    const handleMessage = (
      event: MessageEvent<unknown>,
    ): void => {
      if (
        isMessageOfType(
          event.data,
          "WORKER_PROBE_RESULT",
        ) &&
        event.data.requestId === requestId
      ) {
        finish(event.data.result);
      }
    };

    const handleError = (
      event: ErrorEvent,
    ): void => {
      event.preventDefault();

      finish(
        createWorkerFailure(
          startedAt,
          new Error(
            event.message || "Dedicated worker failed",
          ),
        ),
      );
    };

    worker.addEventListener(
      "message",
      handleMessage,
    );
    worker.addEventListener("error", handleError);

    const request: WorkerProbeRequest = {
      t: "WORKER_PROBE",
      requestId,
    };

    worker.postMessage(request);
  });
}

function createWorkerFailure(
  startedAt: string,
  error: unknown,
): WebGpuProbeResult {
  return {
    context: "dedicated-worker",
    apiAvailable: false,
    adapterAvailable: false,
    startedAt,
    completedAt: nowIso(),
    environment: getProbeEnvironment(),
    error: toProbeError(error),
  };
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
