import {
  getProbeEnvironment,
  isCapturePortMessage,
  isMessageOfType,
  isWhisperWorkerOutputMessage,
  nowIso,
  toProbeError,
  type AdapterInfo,
  type M1Message,
  type OffscreenProbeResult,
  type OffscreenProbeResultMessage,
  type ProbeFailureMessage,
  type TranslatorProbeResult,
  type WebGpuProbeResult,
  type WhisperInitMessage,
  type WhisperWorkerOutputMessage,
  type WorkerProbeRequest,
} from "../shared/messages";
import {
  createCaptureState,
  type CaptureState,
} from "../shared/state";
import type {
  Settings,
  WhisperDevice,
  WhisperModel,
} from "../shared/settings";
import {
  AudioCapture,
  type AudioCaptureCallbacks,
} from "./audio-capture";
import {
  WhisperSegmenter,
  type RecognitionLine,
} from "./segmenter";

interface GpuLike {
  requestAdapter(): Promise<GpuAdapterLike | null>;
}

interface GpuAdapterLike {
  readonly info?: unknown;
}

type TranslatorScope = typeof globalThis & {
  Translator?: TranslatorFactory;
};

interface WhisperSessionCallbacks {
  onProgress(message: {
    file: string;
    progress: number;
    loaded: number;
    total: number;
  }): void;
  onFatal(error: Error): void;
}

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
let activeWhisperSession:
  | WhisperSession
  | null = null;
let activeSegmenter:
  | WhisperSegmenter
  | null = null;
let activeRecognitionRequestId:
  | string
  | null = null;
let lastModelProgress = 0;

const requestedStopIds = new Set<string>();

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
        const response:
          OffscreenProbeResultMessage = {
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
    reconnectDelayMs =
      INITIAL_RECONNECT_DELAY_MS;

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
          requestedStopIds.delete(
            message.requestId,
          );

          void enqueueCaptureOperation(() =>
            handleCaptureStart(
              message.streamId,
              message.requestId,
              message.settings,
            ),
          );
          return;
        }

        if (
          isMessageOfType(message, "OFF_STOP")
        ) {
          requestedStopIds.add(
            message.requestId,
          );
          terminateRecognition(
            message.requestId,
          );

          void enqueueCaptureOperation(() =>
            handleCaptureStop(
              message.requestId,
            ),
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

  reconnectTimerId = self.setTimeout(
    () => {
      reconnectTimerId = null;
      connectBackgroundPort();
    },
    delay,
  );
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
  settings: Settings,
): Promise<void> {
  if (audioCapture.isActive()) {
    if (
      localCaptureState.requestId === requestId &&
      (
        localCaptureState.status === "starting" ||
        localCaptureState.status ===
          "loadingModel" ||
        localCaptureState.status === "running"
      )
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
      requestedStopIds.add(endedRequestId);
      terminateRecognition(endedRequestId);

      void enqueueCaptureOperation(async () => {
        if (
          localCaptureState.requestId !==
          endedRequestId
        ) {
          requestedStopIds.delete(
            endedRequestId,
          );
          return;
        }

        publishState(
          createCaptureState("stopping", {
            requestId: endedRequestId,
            ...(localCaptureState.model ===
            undefined
              ? {}
              : {
                  model:
                    localCaptureState.model,
                }),
            ...(localCaptureState.device ===
            undefined
              ? {}
              : {
                  device:
                    localCaptureState.device,
                }),
          }),
        );

        latestRms = 0;
        postLevel();

        publishState(
          createCaptureState("idle", {
            requestId: endedRequestId,
          }),
        );

        requestedStopIds.delete(
          endedRequestId,
        );
      });
    },
  };

  let model: WhisperModel | undefined;

  try {
    await audioCapture.start(
      streamId,
      requestId,
      callbacks,
    );

    if (requestedStopIds.has(requestId)) {
      return;
    }

    model = settings.model;

    if (requestedStopIds.has(requestId)) {
      return;
    }

    lastModelProgress = 0;

    publishState(
      createCaptureState("loadingModel", {
        requestId,
        model,
        progress: 0,
      }),
    );

    const ortBaseUrl =
      chrome.runtime.getURL("ort/");

    const createSession = (
      sessionWorker: Worker,
    ): WhisperSession => {
      let session: WhisperSession;

      session = new WhisperSession(
        sessionWorker,
        {
          onProgress(message) {
            if (
              activeWhisperSession !== session ||
              requestedStopIds.has(requestId)
            ) {
              return;
            }

            const progress = Math.max(
              lastModelProgress,
              Math.round(message.progress),
            );

            if (
              progress === lastModelProgress &&
              localCaptureState.status ===
                "loadingModel"
            ) {
              return;
            }

            lastModelProgress = progress;

            publishState(
              createCaptureState(
                "loadingModel",
                {
                  requestId,
                  model,
                  progress,
                },
              ),
            );
          },

          onFatal(error) {
            if (
              activeWhisperSession !== session
            ) {
              return;
            }

            void handleRecognitionFatal(
              requestId,
              error,
            );
          },
        },
      );

      return session;
    };

    let worker = createWhisperWorker();
    let session = createSession(worker);

    activeWhisperSession = session;
    activeRecognitionRequestId = requestId;

    let device: WhisperDevice;

    try {
      device = await session.initialize(
        model,
        ortBaseUrl,
      );
    } catch (webGpuError) {
      if (
        !isWebGpuInitializationFailure(
          webGpuError,
        )
      ) {
        throw webGpuError;
      }

      console.warn(
        "[offscreen]",
        "WebGPU initialization failed; retrying in a fresh worker with WASM",
        webGpuError,
      );

      session.terminate();

      if (activeWhisperSession === session) {
        activeWhisperSession = null;
      }

      if (requestedStopIds.has(requestId)) {
        return;
      }

      lastModelProgress = 0;

      publishState(
        createCaptureState("loadingModel", {
          requestId,
          model,
          progress: 0,
        }),
      );

      try {
        worker = createWhisperWorker();
        session = createSession(worker);

        activeWhisperSession = session;
        activeRecognitionRequestId =
          requestId;

        device = await session.initialize(
          model,
          ortBaseUrl,
          "wasm",
        );
      } catch (wasmError) {
        throw combineInitializationErrors(
          webGpuError,
          wasmError,
        );
      }
    }

    if (
      requestedStopIds.has(requestId) ||
      activeWhisperSession !== session
    ) {
      return;
    }

    activeSegmenter =
      new WhisperSegmenter({
        worker,
        getWriteOffset: () =>
          audioCapture.getWriteOffset(),
        getCapacitySamples: () =>
          audioCapture.getCapacitySamples(),
        copySamples: (
          startOffset,
          endOffset,
        ) =>
          audioCapture.copySamples(
            startOffset,
            endOffset,
          ),
        getEnergyHistory: () =>
          audioCapture.getEnergyHistory(),
        onLine: postRecognition,
        onError(message) {
          console.warn(
            "[offscreen]",
            "non-fatal recognition failure",
            message,
          );
        },
      });

    activeSegmenter.start();

    publishState(
      createCaptureState("running", {
        requestId,
        model,
        device,
        progress: 100,
      }),
    );

    console.log("[offscreen]", "capture running", {
      requestId,
      model,
      device,
    });
  } catch (error) {
    if (
      requestedStopIds.has(requestId) ||
      isAbortError(error)
    ) {
      return;
    }

    console.error(
      "[offscreen]",
      "capture start failed",
      error,
    );

    terminateRecognition(requestId);

    try {
      await audioCapture.stop();
    } catch (cleanupError) {
      console.error(
        "[offscreen]",
        "capture cleanup after startup failure failed",
        cleanupError,
      );
    }

    latestRms = 0;
    postLevel();

    publishState(
      createCaptureState("error", {
        requestId,
        ...(model === undefined
          ? {}
          : { model }),
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
      ...(localCaptureState.model === undefined
        ? {}
        : { model: localCaptureState.model }),
      ...(localCaptureState.device === undefined
        ? {}
        : {
            device:
              localCaptureState.device,
          }),
    }),
  );

  terminateRecognition(requestId);

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
  } finally {
    requestedStopIds.delete(requestId);
  }
}

async function handleRecognitionFatal(
  requestId: string,
  error: Error,
): Promise<void> {
  if (
    activeRecognitionRequestId !== requestId ||
    localCaptureState.requestId !== requestId
  ) {
    return;
  }

  terminateRecognition(requestId);

  await enqueueCaptureOperation(async () => {
    if (
      localCaptureState.requestId !== requestId ||
      requestedStopIds.has(requestId)
    ) {
      return;
    }

    try {
      await audioCapture.stop();
    } catch (cleanupError) {
      console.error(
        "[offscreen]",
        "audio cleanup after fatal recognition failure failed",
        cleanupError,
      );
    }

    latestRms = 0;
    postLevel();

    publishState(
      createCaptureState("error", {
        requestId,
        ...(localCaptureState.model === undefined
          ? {}
          : {
              model:
                localCaptureState.model,
            }),
        ...(localCaptureState.device === undefined
          ? {}
          : {
              device:
                localCaptureState.device,
            }),
        error: toProbeError(error),
      }),
    );
  });
}

function terminateRecognition(
  requestId?: string,
): void {
  if (
    requestId !== undefined &&
    activeRecognitionRequestId !== null &&
    activeRecognitionRequestId !== requestId
  ) {
    return;
  }

  activeSegmenter?.stop();
  activeSegmenter = null;

  activeWhisperSession?.terminate();
  activeWhisperSession = null;
  activeRecognitionRequestId = null;
  lastModelProgress = 0;
}

function createWhisperWorker(): Worker {
  return new Worker(
    new URL(
      "../worker/whisper.worker.ts",
      import.meta.url,
    ),
    { type: "module" },
  );
}

function postRecognition(
  line: RecognitionLine,
): void {
  postToBackground({
    t: "OFF_RECOG",
    id: line.id,
    text: line.text,
    final: line.final,
    at: line.at,
  });
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

class WhisperSession {
  private readonly worker: Worker;
  private readonly callbacks:
    WhisperSessionCallbacks;

  private initialized = false;
  private terminated = false;
  private initializationResolve:
    | ((device: WhisperDevice) => void)
    | null = null;
  private initializationReject:
    | ((error: Error) => void)
    | null = null;

  constructor(
    worker: Worker,
    callbacks: WhisperSessionCallbacks,
  ) {
    this.worker = worker;
    this.callbacks = callbacks;

    worker.addEventListener(
      "message",
      this.handleMessage,
    );
    worker.addEventListener(
      "error",
      this.handleError,
    );
  }

  initialize(
    model: WhisperModel,
    ortBaseUrl: string,
    forceDevice?: WhisperDevice,
  ): Promise<WhisperDevice> {
    if (this.terminated) {
      return Promise.reject(
        new DOMException(
          "Whisper worker was terminated",
          "AbortError",
        ),
      );
    }

    if (
      this.initializationResolve !== null ||
      this.initialized
    ) {
      return Promise.reject(
        new DOMException(
          "Whisper initialization has already started",
          "InvalidStateError",
        ),
      );
    }

    const promise =
      new Promise<WhisperDevice>(
        (resolve, reject) => {
          this.initializationResolve = resolve;
          this.initializationReject = reject;
        },
      );

    const message: WhisperInitMessage = {
      t: "WHISPER_INIT",
      model,
      ortBaseUrl,
      ...(forceDevice === undefined
        ? {}
        : { forceDevice }),
    };

    try {
      this.worker.postMessage(message);
    } catch (error) {
      this.rejectInitialization(
        errorToError(error),
      );
    }

    return promise;
  }

  terminate(): void {
    if (this.terminated) {
      return;
    }

    this.terminated = true;

    this.worker.removeEventListener(
      "message",
      this.handleMessage,
    );
    this.worker.removeEventListener(
      "error",
      this.handleError,
    );

    this.rejectInitialization(
      new DOMException(
        "Whisper worker was terminated",
        "AbortError",
      ),
    );

    this.worker.terminate();
  }

  private readonly handleMessage = (
    event: MessageEvent<unknown>,
  ): void => {
    if (
      this.terminated ||
      !isWhisperWorkerOutputMessage(event.data)
    ) {
      return;
    }

    this.processMessage(event.data);
  };

  private processMessage(
    message: WhisperWorkerOutputMessage,
  ): void {
    switch (message.t) {
      case "WHISPER_PROGRESS":
        this.callbacks.onProgress(message);
        return;

      case "WHISPER_READY":
        this.initialized = true;
        this.resolveInitialization(
          message.device,
        );
        return;

      case "WHISPER_ERROR": {
        const error =
          new WhisperMessageError(
            message.message,
            message.fatal,
            message.attemptedDevice,
          );

        if (!this.initialized) {
          this.rejectInitialization(error);
          return;
        }

        if (message.fatal) {
          this.callbacks.onFatal(error);
        }
        return;
      }

      case "WHISPER_RESULT":
        return;
    }
  }

  private readonly handleError = (
    event: ErrorEvent,
  ): void => {
    event.preventDefault();

    const error = new Error(
      event.message ||
      "Whisper worker execution failed",
    );
    error.name = "WhisperWorkerError";

    if (!this.initialized) {
      this.rejectInitialization(error);
      return;
    }

    this.callbacks.onFatal(error);
  };

  private resolveInitialization(
    device: WhisperDevice,
  ): void {
    const resolve =
      this.initializationResolve;

    this.initializationResolve = null;
    this.initializationReject = null;
    resolve?.(device);
  }

  private rejectInitialization(
    error: Error,
  ): void {
    const reject =
      this.initializationReject;

    this.initializationResolve = null;
    this.initializationReject = null;
    reject?.(error);
  }
}

class WhisperMessageError extends Error {
  readonly detail: string;
  readonly fatal: boolean;
  readonly attemptedDevice:
    | WhisperDevice
    | undefined;

  constructor(
    detail: string,
    fatal: boolean,
    attemptedDevice?: WhisperDevice,
  ) {
    super(
      attemptedDevice === undefined
        ? detail
        : `Whisper initialization failed on ${formatWhisperDevice(attemptedDevice)} (${detail})`,
    );

    this.name = "WhisperError";
    this.detail = detail;
    this.fatal = fatal;
    this.attemptedDevice = attemptedDevice;
  }
}

function isWebGpuInitializationFailure(
  error: unknown,
): error is WhisperMessageError {
  return (
    error instanceof WhisperMessageError &&
    error.fatal &&
    error.attemptedDevice === "webgpu"
  );
}

function combineInitializationErrors(
  webGpuError: unknown,
  wasmError: unknown,
): Error {
  const error = new Error(
    `Whisper initialization failed on WebGPU (${initializationErrorDetail(webGpuError)}) and WASM (${initializationErrorDetail(wasmError)})`,
  );

  error.name = "WhisperError";
  return error;
}

function initializationErrorDetail(
  error: unknown,
): string {
  if (error instanceof WhisperMessageError) {
    return error.detail;
  }

  return errorToError(error).message;
}

function formatWhisperDevice(
  device: WhisperDevice,
): string {
  return device === "webgpu"
    ? "WebGPU"
    : "WASM";
}

async function runOffscreenProbe(
  requestId: string,
): Promise<OffscreenProbeResult> {
  const startedAt = nowIso();

  const [
    documentWebGpu,
    translator,
    workerWebGpu,
  ] = await Promise.all([
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
            adapterInfo:
              readAdapterInfo(adapter),
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
    typeof scope.Translator?.availability !==
      "function"
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
    return createWorkerFailure(
      startedAt,
      error,
    );
  }

  return new Promise<WebGpuProbeResult>(
    (resolve) => {
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
              event.message ||
              "Dedicated worker failed",
            ),
          ),
        );
      };

      worker.addEventListener(
        "message",
        handleMessage,
      );
      worker.addEventListener(
        "error",
        handleError,
      );

      const request: WorkerProbeRequest = {
        t: "WORKER_PROBE",
        requestId,
      };

      worker.postMessage(request);
    },
  );
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

function errorToError(
  error: unknown,
): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

function isAbortError(
  error: unknown,
): boolean {
  return (
    error instanceof DOMException &&
    error.name === "AbortError"
  );
}
