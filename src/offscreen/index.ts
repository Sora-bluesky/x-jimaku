import {
  getProbeEnvironment,
  isCapturePortMessage,
  isMessageOfType,
  isWhisperWorkerOutputMessage,
  nowIso,
  toProbeError,
  type AdapterInfo,
  type CsEosMessage,
  type CsPcmMessage,
  type CsTranslateMessage,
  type CsTranslateResultMessage,
  type M1Message,
  type OffDiagnosticMessage,
  type OffRecognitionMessage,
  type OffscreenProbeResult,
  type OffscreenProbeResultMessage,
  type OffStatusMessage,
  type ProbeFailureMessage,
  type TranslatorProbeResult,
  type TranslationPath,
  type WebGpuProbeResult,
  type WhisperInitMessage,
  type WhisperWorkerOutputMessage,
  type WorkerProbeRequest,
} from "../shared/messages";
import {
  createCaptureState,
  type CaptureState,
  type CaptureStatus,
} from "../shared/state";
import {
  CAPTION_DRAIN_WAIT_MS,
} from "../shared/explicit-stop-drain";
import type {
  Settings,
  SourceLanguage,
  WhisperDevice,
  WhisperModel,
} from "../shared/settings";
import {
  AudioCapture,
  type AudioCaptureCallbacks,
} from "./audio-capture";
import {
  describePcmSequenceGap,
} from "./pcm-sequence-log";
import {
  WhisperSegmenter,
  type RecognitionLine,
} from "./segmenter";
import {
  SentenceAssembler,
} from "./sentence-assembler";
import {
  createTerminalLedgerGlue,
  type TerminalLedger,
} from "./terminal-ledger";
import {
  isMostlyJapanese,
  TranslationEngine,
  type ContentTranslationResponse,
} from "./translate";

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

interface PendingContentTranslation {
  requestId: string;
  timeoutId: number;
  resolve(
    response: ContentTranslationResponse,
  ): void;
  reject(error: Error): void;
}

interface PendingCaptionDrain {
  requestId: string;
  timeoutId: number;
  resolve(): void;
}

const OFFSCREEN_PORT_NAME = "offscreen";
const INITIAL_RECONNECT_DELAY_MS = 100;
const MAX_RECONNECT_DELAY_MS = 1_000;
const PCM_GAP_LOG_INTERVAL_MS = 5_000;
const CONTENT_TRANSLATION_TIMEOUT_MS =
  15_000;
const FINAL_RECOGNITION_BUFFER_CAPACITY = 32;

const audioCapture = new AudioCapture();

let backgroundPort:
  | chrome.runtime.Port
  | null = null;
let bufferedOffDiagnostic:
  | OffDiagnosticMessage
  | null = null;
let reconnectTimerId: number | null = null;
let reconnectDelayMs =
  INITIAL_RECONNECT_DELAY_MS;
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
let activeSentenceAssembler:
  | SentenceAssembler
  | null = null;
let activeSentenceAssemblerRequestId:
  | string
  | null = null;
let activeTranslationEngine:
  | TranslationEngine
  | null = null;
let activeTerminalLedger:
  | TerminalLedger
  | null = null;
let activeTranslationRequestId:
  | string
  | null = null;
let stopFlushTranslationRequestId:
  | string
  | null = null;
let activeTranslationPath:
  | TranslationPath
  | null = null;
let activeRecognitionRequestId:
  | string
  | null = null;
let bufferedRecognitionRequestId:
  | string
  | null = null;
let activePcmRequestId:
  | string
  | null = null;
let pendingEosRequestId:
  | string
  | null = null;
let activeContextTerms: string[] = [];
let expectedPcmSequence = 0;
let lastPcmGapLogAt =
  Number.NEGATIVE_INFINITY;
let rejectedPcmChunkCount = 0;
let lastRejectedPcmLogAt =
  Number.NEGATIVE_INFINITY;
let lastModelProgress = 0;
let contentTranslationSequence = 0;

const bufferedFinalRecognitions:
  OffRecognitionMessage[] = [];
const requestedStopIds = new Set<string>();
const drainingStopIds = new Set<string>();
const pendingContentTranslations =
  new Map<
    string,
    PendingContentTranslation
  >();
let pendingCaptionDrain:
  | PendingCaptionDrain
  | null = null;

self.addEventListener(
  "error",
  (event: ErrorEvent) => {
    try {
      reportOffscreenDiagnostic(
        "unhandled-error",
        event.error,
        event.message ||
          "Unhandled offscreen error",
      );
    } catch {
      return;
    }
  },
);

self.addEventListener(
  "unhandledrejection",
  (event: PromiseRejectionEvent) => {
    try {
      reportOffscreenDiagnostic(
        "unhandled-rejection",
        event.reason,
        "Unhandled offscreen promise rejection",
      );
    } catch {
      return;
    }
  },
);

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

    void runOffscreenProbe(message.requestId)
      .then((result) => {
        sendResponse({
          t: "OFFSCREEN_PROBE_RESULT",
          requestId: message.requestId,
          result,
        });
      })
      .catch((error: unknown) => {
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
    globalThis.clearTimeout(
      reconnectTimerId,
    );
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
          isMessageOfType(
            message,
            "OFF_QUERY",
          )
        ) {
          postOffscreenStatus(
            message.queryId,
          );
          return;
        }

        if (
          isMessageOfType(
            message,
            "OFF_FLUSH_RECOG",
          )
        ) {
          flushBufferedRecognitions(
            message.requestId,
          );
          return;
        }

        if (
          isMessageOfType(message, "CS_PCM")
        ) {
          handlePcm(message);
          return;
        }

        if (
          isMessageOfType(message, "CS_EOS")
        ) {
          handleEndOfStream(message);
          return;
        }

        if (
          isMessageOfType(
            message,
            "CS_TRANSLATE_RESULT",
          )
        ) {
          handleContentTranslationResult(
            message,
          );
          return;
        }

        if (
          isMessageOfType(
            message,
            "CS_DRAIN_COMPLETE",
          )
        ) {
          handleContentDrainComplete(
            message.requestId,
          );
          return;
        }

        if (
          isMessageOfType(
            message,
            "OFF_START",
          )
        ) {
          requestedStopIds.delete(
            message.requestId,
          );
          drainingStopIds.delete(
            message.requestId,
          );

          void enqueueCaptureOperation(() =>
            handleCaptureStart(
              message.requestId,
              message.settings,
            ),
          );
          return;
        }

        if (
          isMessageOfType(
            message,
            "OFF_STOP",
          )
        ) {
          const drain =
            message.drain === true;

          if (drain) {
            requestedStopIds.delete(
              message.requestId,
            );
            drainingStopIds.add(
              message.requestId,
            );
            beginRecognitionDrain(
              message.requestId,
            );
          } else {
            drainingStopIds.delete(
              message.requestId,
            );
            requestedStopIds.add(
              message.requestId,
            );
            clearRecognitionBuffer();
            terminateRecognition(
              message.requestId,
            );
          }

          void enqueueCaptureOperation(() =>
            handleCaptureStop(
              message.requestId,
              drain,
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

      rejectPendingContentTranslations(
        undefined,
        new Error(
          disconnectError ??
          "Background port disconnected",
        ),
      );
      scheduleReconnect();
    });

    flushBufferedOffDiagnostic(port);
    postState();
    postLevel();
    postTranslationState();
  } catch (error) {
    console.warn(
      "[offscreen]",
      "could not connect background port",
      error,
    );
    scheduleReconnect();
  }
}

function reportOffscreenDiagnostic(
  kind: OffDiagnosticMessage["kind"],
  error: unknown,
  fallbackMessage: string,
): void {
  const normalized =
    error === undefined || error === null
      ? {
          name: "Error",
          message: fallbackMessage,
        }
      : toProbeError(error);
  const message =
    normalized.message === ""
      ? fallbackMessage
      : normalized.message;
  const stack =
    normalized.stack?.slice(0, 500);

  const diagnostic: OffDiagnosticMessage = {
    t: "OFF_DIAGNOSTIC",
    kind,
    at: new Date().toISOString(),
    context: "offscreen",
    message,
    ...(stack === undefined
      ? {}
      : { stack }),
  };

  postOffDiagnostic(diagnostic);
}

function postOffDiagnostic(
  message: OffDiagnosticMessage,
): void {
  const port = backgroundPort;

  if (port === null) {
    bufferedOffDiagnostic = message;
    scheduleReconnect();
    return;
  }

  try {
    port.postMessage(message);
  } catch {
    bufferedOffDiagnostic = message;

    if (backgroundPort === port) {
      backgroundPort = null;
    }

    scheduleReconnect();
  }
}

function flushBufferedOffDiagnostic(
  port: chrome.runtime.Port,
): void {
  const message = bufferedOffDiagnostic;

  if (message === null) {
    return;
  }

  try {
    port.postMessage(message);
    bufferedOffDiagnostic = null;
  } catch {
    if (backgroundPort === port) {
      backgroundPort = null;
    }

    scheduleReconnect();
  }
}

function postOffscreenStatus(
  queryId: string,
): void {
  const message: OffStatusMessage = {
    t: "OFF_STATUS",
    queryId,
    state: localCaptureState,
    sessionActive:
      isLocalCaptureSessionActive(),
  };

  postToBackground(message);
}

function isLocalCaptureSessionActive(): boolean {
  return (
    isCaptureActiveStatus(
      localCaptureState.status,
    ) &&
    localCaptureState.requestId !==
      undefined &&
    activePcmRequestId ===
      localCaptureState.requestId &&
    audioCapture.isActive()
  );
}

function isCaptureActiveStatus(
  status: CaptureStatus,
): boolean {
  return (
    status === "starting" ||
    status === "loadingModel" ||
    status === "running"
  );
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

function handlePcm(
  message: CsPcmMessage,
): void {
  if (
    activePcmRequestId !==
      message.requestId ||
    isStopRequested(message.requestId) ||
    !audioCapture.isActive()
  ) {
    return;
  }

  pendingEosRequestId = null;

  if (message.contextTerms !== undefined) {
    activeContextTerms = [
      ...message.contextTerms,
    ];
    activeSegmenter
      ?.setProperNounDictionary(
        activeContextTerms,
      );

    console.info(
      "[offscreen]",
      "post context dictionary received",
      {
        requestId: message.requestId,
        termCount:
          activeContextTerms.length,
      },
    );
  }

  detectPcmSequenceGap(message.seq);

  try {
    const samples =
      decodeFloat32Base64(message.b64);

    audioCapture.acceptPcm(
      message.requestId,
      samples,
    );
  } catch (error) {
    recordRejectedPcmChunk(
      message,
      error,
    );
  }
}

function recordRejectedPcmChunk(
  message: CsPcmMessage,
  error: unknown,
): void {
  rejectedPcmChunkCount += 1;

  const now = performance.now();

  if (
    now - lastRejectedPcmLogAt <
    PCM_GAP_LOG_INTERVAL_MS
  ) {
    return;
  }

  lastRejectedPcmLogAt = now;

  console.warn(
    "[offscreen]",
    "ignored invalid PCM chunks",
    {
      requestId: message.requestId,
      seq: message.seq,
      rejected: rejectedPcmChunkCount,
      error,
    },
  );
}

function flushRejectedPcmChunks(
  requestId: string,
): void {
  if (rejectedPcmChunkCount > 0) {
    console.warn(
      "[offscreen]",
      "ignored invalid PCM chunks",
      {
        requestId,
        rejected: rejectedPcmChunkCount,
      },
    );
  }

  rejectedPcmChunkCount = 0;
  lastRejectedPcmLogAt =
    Number.NEGATIVE_INFINITY;
}

function handleEndOfStream(
  message: CsEosMessage,
): void {
  if (
    activePcmRequestId !==
      message.requestId ||
    isStopRequested(message.requestId) ||
    !audioCapture.isActive()
  ) {
    return;
  }

  pendingEosRequestId = message.requestId;

  const segmenter = activeSegmenter;

  if (
    segmenter === null ||
    activeRecognitionRequestId !==
      message.requestId
  ) {
    return;
  }

  pendingEosRequestId = null;
  segmenter.flushPendingAudio();
}

function handleContentTranslationResult(
  message: CsTranslateResultMessage,
): void {
  const pending =
    pendingContentTranslations.get(
      message.id,
    );

  if (
    pending === undefined ||
    pending.requestId !==
      message.requestId
  ) {
    return;
  }

  pendingContentTranslations.delete(
    message.id,
  );
  globalThis.clearTimeout(
    pending.timeoutId,
  );

  if (message.error !== undefined) {
    const error = new Error(
      message.error.message,
    );
    error.name = message.error.name;
    pending.reject(error);
    return;
  }

  pending.resolve({
    available: message.available,
    ja: message.ja,
  });
}

function handleContentDrainComplete(
  requestId: string,
): void {
  if (!drainingStopIds.has(requestId)) {
    return;
  }

  finishPendingCaptionDrain(requestId);
}

function detectPcmSequenceGap(
  receivedSequence: number,
): void {
  const expected = expectedPcmSequence;

  if (receivedSequence !== expected) {
    const now = performance.now();

    if (
      now - lastPcmGapLogAt >=
      PCM_GAP_LOG_INTERVAL_MS
    ) {
      lastPcmGapLogAt = now;

      const gapLog =
        describePcmSequenceGap(
          expected,
          receivedSequence,
        );

      if (gapLog.level === "info") {
        console.info(
          gapLog.message,
          gapLog.payload,
        );
      } else {
        console.warn(
          gapLog.message,
          gapLog.payload,
        );
      }
    }
  }

  expectedPcmSequence =
    receivedSequence + 1;
}

async function handleCaptureStart(
  requestId: string,
  settings: Settings,
): Promise<void> {
  if (audioCapture.isActive()) {
    if (
      localCaptureState.requestId ===
        requestId &&
      isCaptureActiveStatus(
        localCaptureState.status,
      )
    ) {
      postState();
      postTranslationState();
      return;
    }

    publishState(
      createCaptureState("error", {
        requestId,
        error: {
          name: "InvalidStateError",
          message:
            "A PCM capture session is already active",
        },
      }),
    );
    return;
  }

  activeSentenceAssembler?.destroy();

  const sentenceAssembler =
    new SentenceAssembler({
      onLine(
        outputRequestId,
        line,
      ) {
        postRecognition(
          outputRequestId,
          line,
          settings.showTentative,
        );
      },
    });

  sentenceAssembler.startCapture(
    requestId,
  );
  activeSentenceAssembler =
    sentenceAssembler;
  activeSentenceAssemblerRequestId =
    requestId;

  prepareRecognitionBuffer(requestId);
  pendingEosRequestId = null;
  activeContextTerms = [];

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
  };

  let model: WhisperModel | undefined;

  try {
    activePcmRequestId = requestId;
    expectedPcmSequence = 0;
    lastPcmGapLogAt =
      Number.NEGATIVE_INFINITY;
    rejectedPcmChunkCount = 0;
    lastRejectedPcmLogAt =
      Number.NEGATIVE_INFINITY;

    await audioCapture.start(
      requestId,
      callbacks,
    );

    if (isStopRequested(requestId)) {
      return;
    }

    model = settings.model;
    lastModelProgress = 0;

    publishState(
      createCaptureState("loadingModel", {
        requestId,
        model,
        progress: 0,
      }),
    );

    const terminalLedgerGlue =
      createTerminalLedgerGlue(
        requestId,
        postFinalRecognition,
      );
    const terminalLedger =
      terminalLedgerGlue.ledger;
    const translationEngine =
      new TranslationEngine({
        backend:
          settings.translationBackend,
        requestId,
        getContext() {
          return {
            recentPairs: [],
            properNouns: [
              ...activeContextTerms,
            ],
          };
        },
        requestContentTranslation(text) {
          return requestContentTranslation(
            requestId,
            text,
          );
        },

        onDevLog(message) {
          postToBackground(message);
        },

        onTranslated(line, ja, rung) {
          if (
            activeTranslationEngine !==
              translationEngine ||
            activeTranslationRequestId !==
              requestId ||
            requestedStopIds.has(requestId)
          ) {
            return;
          }

          terminalLedgerGlue
            .engineCallbacks
            .onTranslated(
              line,
              ja,
              rung,
            );
        },

        onSettled(ids) {
          if (
            activeTranslationEngine !==
              translationEngine ||
            activeTranslationRequestId !==
              requestId ||
            activeTerminalLedger !==
              terminalLedger
          ) {
            return;
          }

          terminalLedgerGlue
            .engineCallbacks
            .onSettled(ids);
        },

        onPathChanged(path) {
          if (
            activeTranslationEngine !==
              translationEngine ||
            activeTranslationRequestId !==
              requestId
          ) {
            return;
          }

          activeTranslationPath = path;
          postTranslationState();
        },
      });

    activeTranslationEngine =
      translationEngine;
    activeTerminalLedger =
      terminalLedger;
    activeTranslationRequestId =
      requestId;
    activeTranslationPath = null;

    void translationEngine
      .initialize()
      .catch((error: unknown) => {
        if (
          activeTranslationEngine ===
            translationEngine &&
          activeTranslationRequestId ===
            requestId
        ) {
          console.warn(
            "[translate]",
            "translation initialization failed; recognition continues without blocking",
            error,
          );
        }
      });

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
              activeWhisperSession !==
                session ||
              isStopRequested(requestId)
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
              activeWhisperSession !==
                session
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
        settings.sourceLang,
      );
    } catch (webGpuError) {
      if (
        !isWebGpuInitializationFailure(
          webGpuError,
        )
      ) {
        throw webGpuError;
      }

      session.terminate();

      if (activeWhisperSession === session) {
        activeWhisperSession = null;
      }

      if (isStopRequested(requestId)) {
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
          settings.sourceLang,
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
      isStopRequested(requestId) ||
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
        properNouns: activeContextTerms,
        showTentative:
          settings.showTentative,
        onLine(line) {
          sentenceAssembler.accept(
            requestId,
            line,
          );
        },
        onFlushCompleted() {
          sentenceAssembler.flush(
            requestId,
          );
        },
        onError(message) {
          console.warn(
            "[offscreen]",
            "non-fatal recognition failure",
            message,
          );
        },
      });

    activeSegmenter.start();

    if (pendingEosRequestId === requestId) {
      pendingEosRequestId = null;
      activeSegmenter.flushPendingAudio();
    }

    publishState(
      createCaptureState("running", {
        requestId,
        model,
        device,
        progress: 100,
      }),
    );
  } catch (error) {
    if (
      isStopRequested(requestId) ||
      isAbortError(error)
    ) {
      return;
    }

    terminateRecognition(requestId);
    activePcmRequestId = null;

    try {
      await audioCapture.stop();
    } catch (cleanupError) {
      console.error(
        "[offscreen]",
        "PCM sink cleanup after startup failure failed",
        cleanupError,
      );
    }

    flushRejectedPcmChunks(requestId);
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
  drain: boolean,
): Promise<void> {
  pendingEosRequestId = null;

  publishState(
    createCaptureState("stopping", {
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
    }),
  );

  if (drain) {
    beginRecognitionDrain(requestId);
  } else {
    terminateRecognition(requestId);
  }

  const translationEngine =
    activeTranslationRequestId ===
      requestId
      ? activeTranslationEngine
      : null;
  const drainPromise =
    drain && translationEngine !== null
      ? translationEngine.drain()
      : Promise.resolve(true);

  if (activePcmRequestId === requestId) {
    activePcmRequestId = null;
  }

  try {
    await audioCapture.stop();

    await drainPromise;

    if (drain) {
      if (
        activeTranslationRequestId ===
          requestId
      ) {
        activeTerminalLedger
          ?.settlePendingAsFallback();
      }

      await waitForCaptionDrain(requestId);
    }

    terminateRecognition(requestId);

    latestRms = 0;
    postLevel();

    publishState(
      createCaptureState("idle", {
        requestId,
      }),
    );
  } catch (error) {
    terminateRecognition(requestId);

    publishState(
      createCaptureState("error", {
        requestId,
        error: toProbeError(error),
      }),
    );
  } finally {
    finishPendingCaptionDrain(requestId);
    flushRejectedPcmChunks(requestId);
    requestedStopIds.delete(requestId);
    drainingStopIds.delete(requestId);
    clearRecognitionBuffer();
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
      isStopRequested(requestId)
    ) {
      return;
    }

    activePcmRequestId = null;

    try {
      await audioCapture.stop();
    } catch (cleanupError) {
      console.error(
        "[offscreen]",
        "PCM sink cleanup after fatal recognition failure failed",
        cleanupError,
      );
    }

    flushRejectedPcmChunks(requestId);
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

function beginRecognitionDrain(
  requestId?: string,
): void {
  if (
    !canStopRecognitionResources(requestId)
  ) {
    return;
  }

  const segmenter = activeSegmenter;

  stopFlushTranslationRequestId =
    segmenter === null
      ? null
      : activeRecognitionRequestId;

  try {
    segmenter?.stop();
  } finally {
    stopFlushTranslationRequestId = null;
    activeSegmenter = null;
  }

  activeWhisperSession?.terminate();
  activeWhisperSession = null;
  activeRecognitionRequestId = null;
}

function terminateRecognition(
  requestId?: string,
): void {
  if (
    !canStopRecognitionResources(requestId)
  ) {
    return;
  }

  beginRecognitionDrain(requestId);

  if (
    requestId === undefined ||
    activeSentenceAssemblerRequestId ===
      requestId
  ) {
    activeSentenceAssembler?.destroy();
    activeSentenceAssembler = null;
    activeSentenceAssemblerRequestId =
      null;
  }

  finishPendingCaptionDrain(requestId);

  activeTranslationEngine?.destroy();
  activeTerminalLedger
    ?.settlePendingAsFallback();
  activeTranslationEngine = null;
  activeTerminalLedger = null;

  const translationRequestId =
    activeTranslationRequestId;
  activeTranslationRequestId = null;
  activeTranslationPath = null;
  activeContextTerms = [];

  rejectPendingContentTranslations(
    translationRequestId ?? requestId,
    new DOMException(
      "Translation session was stopped",
      "AbortError",
    ),
  );

  lastModelProgress = 0;
}

function canStopRecognitionResources(
  requestId: string | undefined,
): boolean {
  if (requestId === undefined) {
    return true;
  }

  return (
    (
      activeRecognitionRequestId === null ||
      activeRecognitionRequestId ===
        requestId
    ) &&
    (
      activeTranslationRequestId === null ||
      activeTranslationRequestId ===
        requestId
    )
  );
}

function isStopRequested(
  requestId: string,
): boolean {
  return (
    requestedStopIds.has(requestId) ||
    drainingStopIds.has(requestId)
  );
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

function decodeFloat32Base64(
  b64: string,
): Float32Array {
  const binary = atob(b64);

  if (
    binary.length %
    Float32Array.BYTES_PER_ELEMENT !==
    0
  ) {
    throw new RangeError(
      "PCM byte length is not aligned to Float32 samples",
    );
  }

  const bytes =
    new Uint8Array(binary.length);

  for (
    let index = 0;
    index < binary.length;
    index += 1
  ) {
    bytes[index] =
      binary.charCodeAt(index);
  }

  return new Float32Array(bytes.buffer);
}

function postRecognition(
  requestId: string,
  line: RecognitionLine,
  showTentative: boolean,
): void {
  const text = line.text.trim();

  if (
    text === "" ||
    (!line.final && !showTentative)
  ) {
    return;
  }

  const skipTranslation =
    isMostlyJapanese(text);

  if (!line.final) {
    postToBackground({
      t: "OFF_RECOG",
      requestId,
      id: line.id,
      text,
      final: false,
      at: line.at,
      ...(skipTranslation
        ? { ja: text }
        : {}),
    });
    return;
  }

  const original: OffRecognitionMessage = {
    t: "OFF_RECOG",
    id: line.id,
    text,
    final: true,
    at: line.at,
  };

  if (
    activeTranslationRequestId ===
      requestId
  ) {
    activeTerminalLedger?.register(
      original,
    );
  }

  postFinalRecognition(
    requestId,
    original,
  );

  activeTranslationEngine?.enqueue(
    {
      id: line.id,
      text,
      final: true,
      at: line.at,
      skipTranslation,
    },
    {
      // A stop flush is bounded by max_new_tokens: 96 and the
      // segmenter's 10-word clause target, so bypassing the
      // live cap adds no more than about 10 clauses.
      stopFlush:
        stopFlushTranslationRequestId ===
        requestId,
    },
  );
}

function prepareRecognitionBuffer(
  requestId: string,
): void {
  if (
    bufferedRecognitionRequestId ===
    requestId
  ) {
    return;
  }

  bufferedRecognitionRequestId =
    requestId;
  bufferedFinalRecognitions.length = 0;
}

function clearRecognitionBuffer(): void {
  bufferedRecognitionRequestId = null;
  bufferedFinalRecognitions.length = 0;
}

function bufferFinalRecognition(
  requestId: string,
  message: OffRecognitionMessage,
): void {
  if (
    bufferedRecognitionRequestId !==
    requestId
  ) {
    bufferedRecognitionRequestId =
      requestId;
    bufferedFinalRecognitions.length = 0;
  }

  if (
    bufferedFinalRecognitions.length >=
    FINAL_RECOGNITION_BUFFER_CAPACITY
  ) {
    bufferedFinalRecognitions.shift();
  }

  bufferedFinalRecognitions.push(message);
}

function postFinalRecognition(
  requestId: string,
  message: OffRecognitionMessage,
): void {
  const identified:
    OffRecognitionMessage = {
      ...message,
      requestId,
    };

  if (postToBackground(identified)) {
    return;
  }

  bufferFinalRecognition(
    requestId,
    identified,
  );
}

function flushBufferedRecognitions(
  requestId: string,
): void {
  if (
    bufferedRecognitionRequestId !== null &&
    bufferedRecognitionRequestId !==
      requestId
  ) {
    clearRecognitionBuffer();
    return;
  }

  if (
    activeRecognitionRequestId !==
      requestId &&
    bufferedRecognitionRequestId !==
      requestId
  ) {
    clearRecognitionBuffer();
    return;
  }

  while (
    bufferedFinalRecognitions.length > 0
  ) {
    const message =
      bufferedFinalRecognitions[0];

    if (
      message === undefined ||
      !postToBackground(message)
    ) {
      return;
    }

    bufferedFinalRecognitions.shift();
  }

  clearRecognitionBuffer();
}

function requestContentTranslation(
  requestId: string,
  text: string,
): Promise<ContentTranslationResponse> {
  const port = backgroundPort;

  if (port === null) {
    return Promise.reject(
      new Error(
        "Background port is unavailable",
      ),
    );
  }

  contentTranslationSequence += 1;

  const id =
    `${requestId}:translation:${contentTranslationSequence}`;

  return new Promise<
    ContentTranslationResponse
  >((resolve, reject) => {
    const timeoutId = self.setTimeout(
      () => {
        const pending =
          pendingContentTranslations.get(
            id,
          );

        if (pending === undefined) {
          return;
        }

        pendingContentTranslations.delete(
          id,
        );

        const error = new Error(
          `Content translation timed out after ${CONTENT_TRANSLATION_TIMEOUT_MS} ms`,
        );
        error.name = "TimeoutError";
        pending.reject(error);
      },
      CONTENT_TRANSLATION_TIMEOUT_MS,
    );

    pendingContentTranslations.set(id, {
      requestId,
      timeoutId,
      resolve,
      reject,
    });

    const message: CsTranslateMessage = {
      t: "CS_TRANSLATE",
      requestId,
      id,
      text,
    };

    try {
      port.postMessage(message);
    } catch (error) {
      pendingContentTranslations.delete(
        id,
      );
      globalThis.clearTimeout(timeoutId);
      reject(errorToError(error));
    }
  });
}

function rejectPendingContentTranslations(
  requestId: string | undefined,
  error: Error,
): void {
  for (
    const [id, pending]
    of pendingContentTranslations
  ) {
    if (
      requestId !== undefined &&
      pending.requestId !== requestId
    ) {
      continue;
    }

    pendingContentTranslations.delete(id);
    globalThis.clearTimeout(
      pending.timeoutId,
    );
    pending.reject(error);
  }
}

function waitForCaptionDrain(
  requestId: string,
): Promise<void> {
  finishPendingCaptionDrain();

  return new Promise<void>((resolve) => {
    const timeoutId = self.setTimeout(
      () => {
        finishPendingCaptionDrain(
          requestId,
        );
      },
      CAPTION_DRAIN_WAIT_MS,
    );

    pendingCaptionDrain = {
      requestId,
      timeoutId,
      resolve,
    };

    postToBackground({
      t: "OFF_DRAIN_READY",
      requestId,
    });
  });
}

function finishPendingCaptionDrain(
  requestId?: string,
): void {
  const pending = pendingCaptionDrain;

  if (
    pending === null ||
    (
      requestId !== undefined &&
      pending.requestId !== requestId
    )
  ) {
    return;
  }

  pendingCaptionDrain = null;
  globalThis.clearTimeout(
    pending.timeoutId,
  );
  pending.resolve();
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

function postTranslationState(): void {
  if (
    activeTranslationRequestId === null ||
    activeTranslationPath === null
  ) {
    return;
  }

  postToBackground({
    t: "OFF_TRANSLATION_STATE",
    requestId:
      activeTranslationRequestId,
    path: activeTranslationPath,
  });
}

function postToBackground(
  message: M1Message,
): boolean {
  if (backgroundPort === null) {
    scheduleReconnect();
    return false;
  }

  try {
    backgroundPort.postMessage(message);
    return true;
  } catch (error) {
    console.warn(
      "[offscreen]",
      "could not post background message",
      error,
    );
    return false;
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
    sourceLang: SourceLanguage,
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
      sourceLang,
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
