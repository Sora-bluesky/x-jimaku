import {
  createProbeRequestId,
  getProbeEnvironment,
  isMessageOfType,
  MAX_CONTEXT_TERMS,
  nowIso,
  toProbeError,
  type ContentScriptProbeResultMessage,
  type CsPcmMessage,
  type CsPongMessage,
  type CsTapStateMessage,
  type CsTranslateMessage,
  type CsTranslateResultMessage,
  type ProbeFailureMessage,
  type SwCaptionMessage,
  type TranslationPath,
  type TranslatorProbeResult,
} from "../shared/messages";
import {
  DEFAULT_SETTINGS,
} from "../shared/settings";
import type {
  CaptureState,
  CaptureStatus,
} from "../shared/state";
import {
  AudioTap,
  getAudioTapErrorDetail,
  getCurrentAudioTapTarget,
} from "./audio-tap";
import {
  CaptionOverlay,
} from "./overlay";

type TranslatorScope = typeof globalThis & {
  Translator?: TranslatorFactory;
};

type ContentInstanceWindow = Window & {
  __xJimakuContentScriptVersion__?:
    string;
};

const CONTENT_PORT_NAME = "content";
const INITIAL_RECONNECT_DELAY_MS = 100;
const MAX_RECONNECT_DELAY_MS = 1_000;
const ERROR_CHIP_VISIBLE_MS = 2_500;
const TRANSLATOR_CREATE_WAIT_MS = 8_000;
const CONTENT_INSTANCE_VERSION =
  chrome.runtime.getManifest().version;

const CONTEXT_TERM_STOPLIST =
  new Set([
    "about",
    "after",
    "again",
    "against",
    "also",
    "another",
    "because",
    "before",
    "being",
    "between",
    "both",
    "could",
    "does",
    "doing",
    "during",
    "each",
    "even",
    "every",
    "first",
    "from",
    "going",
    "great",
    "have",
    "having",
    "here",
    "into",
    "just",
    "know",
    "last",
    "like",
    "little",
    "look",
    "made",
    "make",
    "many",
    "more",
    "most",
    "much",
    "need",
    "never",
    "next",
    "only",
    "other",
    "over",
    "people",
    "really",
    "right",
    "same",
    "should",
    "some",
    "something",
    "still",
    "such",
    "take",
    "than",
    "thank",
    "thanks",
    "that",
    "their",
    "them",
    "then",
    "there",
    "these",
    "they",
    "thing",
    "think",
    "this",
    "those",
    "through",
    "today",
    "under",
    "very",
    "want",
    "watching",
    "well",
    "were",
    "what",
    "when",
    "where",
    "which",
    "while",
    "will",
    "with",
    "would",
    "your",
  ]);

let backgroundPort:
  | chrome.runtime.Port
  | null = null;
let reconnectTimerId: number | null = null;
let reconnectDelayMs =
  INITIAL_RECONNECT_DELAY_MS;
let activeTap: AudioTap | null = null;
let tapOperationTail: Promise<void> =
  Promise.resolve();
let contentTranslationTail: Promise<void> =
  Promise.resolve();
let contentTranslator:
  | TranslatorInstance
  | null = null;
let contentTranslatorCreatePromise:
  | Promise<TranslatorInstance | null>
  | null = null;
let contentTranslatorCreateGeneration:
  | number
  | null = null;
let contentTranslatorCreateAttempted = false;
let contentTranslatorGeneration = 0;
let contentSessionRequestId:
  | string
  | null = null;
let activeCaptureRequestId:
  | string
  | null = null;
let pendingContextTerms:
  | string[]
  | null = null;
let pendingContextTermsRequestId:
  | string
  | null = null;
let captionOverlay:
  | CaptionOverlay
  | null = null;
let overlayDestroyTimerId:
  | number
  | null = null;
let lastCaptureStatus: CaptureStatus =
  "idle";
let activeTranslationPath:
  | TranslationPath
  | null = null;
let activeSilentInputHint = false;
let activeShowOriginal =
  DEFAULT_SETTINGS.showOriginal;
let playbackEventTarget:
  | HTMLVideoElement
  | null = null;
let targetPlaybackPaused = false;

const instanceWindow =
  window as ContentInstanceWindow;

if (
  instanceWindow
    .__xJimakuContentScriptVersion__ !==
  CONTENT_INSTANCE_VERSION
) {
  instanceWindow
    .__xJimakuContentScriptVersion__ =
    CONTENT_INSTANCE_VERSION;
  initializeContentScript();
} else {
  console.info(
    "[cs]",
    "duplicate content-script injection ignored",
  );
}

function initializeContentScript(): void {
  console.log("[cs]", "content script loaded", {
    url: location.href,
    topLevel: window === window.top,
    version: CONTENT_INSTANCE_VERSION,
  });

  installTargetPlaybackListeners();
  connectBackgroundPort();
  void runInitialProbe();

  chrome.runtime.onMessage.addListener(
    (
      message: unknown,
      _sender,
      sendResponse: (
        response:
          | ContentScriptProbeResultMessage
          | ProbeFailureMessage
          | CsPongMessage,
      ) => void,
    ): boolean => {
      if (
        isMessageOfType(
          message,
          "CS_PING",
        )
      ) {
        sendResponse({
          t: "CS_PONG",
        });
        return false;
      }

      if (!isMessageOfType(message, "PROBE")) {
        return false;
      }

      void probeTranslator()
        .then((result) => {
          sendResponse({
            t: "CS_PROBE_RESULT",
            requestId: message.requestId,
            result,
          });
        })
        .catch((error: unknown) => {
          sendResponse({
            t: "PROBE_ERROR",
            requestId: message.requestId,
            source: "content-script",
            error: toProbeError(error),
            at: nowIso(),
          });
        });

      return true;
    },
  );
}

function installTargetPlaybackListeners():
  void {
  document.addEventListener(
    "pause",
    handleTargetPlaybackEvent,
    true,
  );
  document.addEventListener(
    "play",
    handleTargetPlaybackEvent,
    true,
  );
  document.addEventListener(
    "playing",
    handleTargetPlaybackEvent,
    true,
  );
  document.addEventListener(
    "seeking",
    handleTargetPlaybackEvent,
    true,
  );
}

function handleTargetPlaybackEvent(
  event: Event,
): void {
  const target =
    getCurrentAudioTapTarget();

  if (target !== playbackEventTarget) {
    playbackEventTarget = target;
    targetPlaybackPaused = false;
    captionOverlay?.setPlaybackPaused(
      false,
    );
  }

  if (
    target === null ||
    event.target !== target
  ) {
    return;
  }

  if (event.type === "seeking") {
    captionOverlay?.clearPlaybackFreezeOnSeek();
    return;
  }

  targetPlaybackPaused =
    event.type === "pause";
  captionOverlay?.setPlaybackPaused(
    targetPlaybackPaused,
  );
}

function syncOverlayPlaybackGate(
  overlay: CaptionOverlay,
): void {
  const target =
    getCurrentAudioTapTarget();

  if (target !== playbackEventTarget) {
    playbackEventTarget = target;
    targetPlaybackPaused = false;
  }

  overlay.setPlaybackPaused(
    target !== null &&
    targetPlaybackPaused,
  );
}

function clearTargetPlaybackFreeze(): void {
  playbackEventTarget = null;
  targetPlaybackPaused = false;
  captionOverlay?.setPlaybackPaused(false);
}

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
      name: CONTENT_PORT_NAME,
    });

    backgroundPort = port;
    reconnectDelayMs =
      INITIAL_RECONNECT_DELAY_MS;

    port.onMessage.addListener(
      (message: unknown) => {
        if (
          isMessageOfType(
            message,
            "CS_START_TAP",
          )
        ) {
          handleStartTapMessage(message);
          return;
        }

        if (
          isMessageOfType(
            message,
            "CS_STOP_TAP",
          )
        ) {
          clearPendingContextTerms(
            message.requestId,
          );

          if (
            contentSessionRequestId ===
              message.requestId
          ) {
            contentSessionRequestId = null;
            resetContentTranslator();
          }

          void enqueueTapOperation(() =>
            stopTap(
              message.requestId,
              "stop-requested",
            ),
          );
          return;
        }

        if (
          isMessageOfType(
            message,
            "CS_TRANSLATE",
          )
        ) {
          enqueueContentTranslation(message);
          return;
        }

        if (
          isMessageOfType(
            message,
            "OFF_STATE",
          )
        ) {
          handleCaptureState(message.state);
          return;
        }

        if (
          isMessageOfType(
            message,
            "SW_TRANSLATION_STATE",
          )
        ) {
          if (
            !isPresentationMessageCurrent(
              message.requestId,
            )
          ) {
            return;
          }

          activeTranslationPath =
            message.path;
          ensureOverlay().setTranslationPath(
            message.path,
          );
          return;
        }

        if (
          isMessageOfType(
            message,
            "SW_SILENT_INPUT",
          )
        ) {
          if (
            lastCaptureStatus !== "running" ||
            !isPresentationMessageCurrent(
              message.requestId,
            )
          ) {
            return;
          }

          activeSilentInputHint =
            message.showHint;
          ensureOverlay().setSilentInputHint(
            message.showHint,
          );
          return;
        }

        if (
          isMessageOfType(
            message,
            "SW_CAPTION",
          )
        ) {
          handleCaption(message);
          return;
        }

        if (
          isMessageOfType(
            message,
            "SW_CAPTION_CLEAR",
          )
        ) {
          captionOverlay?.clear();

          if (
            lastCaptureStatus === "idle" ||
            lastCaptureStatus === "stopping"
          ) {
            destroyOverlay();
          }
          return;
        }

        console.warn(
          "[cs]",
          "ignored malformed content-port message",
          message,
        );
      },
    );

    port.onDisconnect.addListener(() => {
      if (backgroundPort === port) {
        backgroundPort = null;
      }

      const disconnectError =
        chrome.runtime.lastError?.message;

      if (!isExtensionContextAlive()) {
        console.info(
          "[cs]",
          "extension was updated; this page's script is retiring (reload the page to refresh)",
        );
        lastCaptureStatus = "idle";
        activeCaptureRequestId = null;
        contentSessionRequestId = null;
        clearPendingContextTerms();
        destroyOverlay();
        return;
      }

      const disconnectDuringCapture =
        contentSessionRequestId !== null ||
        activeTap !== null;

      if (disconnectDuringCapture) {
        console.warn(
          "[cs]",
          "background port disconnected during capture",
          disconnectError ?? "",
        );
      } else {
        console.info(
          "[cs]",
          "background port disconnected (routine service-worker suspend)",
          disconnectError ?? "",
        );
      }

      lastCaptureStatus = "idle";
      activeCaptureRequestId = null;
      activeTranslationPath = null;
      activeSilentInputHint = false;
      activeShowOriginal =
        DEFAULT_SETTINGS.showOriginal;
      contentSessionRequestId = null;
      clearPendingContextTerms();
      resetContentTranslator();
      destroyOverlay();

      void enqueueTapOperation(async () => {
        const tap = activeTap;

        if (tap === null) {
          return;
        }

        activeTap = null;

        try {
          await tap.stop();
        } catch (error) {
          console.error(
            "[cs]",
            "tap cleanup after background disconnect failed",
            error,
          );
        }
      });

      scheduleReconnect();
    });
  } catch (error) {
    if (
      !isExtensionContextAlive() ||
      String(error).includes(
        "Extension context invalidated",
      )
    ) {
      console.info(
        "[cs]",
        "extension was updated; this page's script is retiring (reload the page to refresh)",
      );
      return;
    }

    console.warn(
      "[cs]",
      "could not connect background port",
      error,
    );
    scheduleReconnect();
  }
}

function isExtensionContextAlive(): boolean {
  try {
    return chrome.runtime?.id !== undefined;
  } catch {
    return false;
  }
}

function handleStartTapMessage(
  message: Extract<
    import("../shared/messages").M1Message,
    { t: "CS_START_TAP" }
  >,
): void {
  activeShowOriginal =
    message.settings?.showOriginal ??
    DEFAULT_SETTINGS.showOriginal;

  if (
    contentSessionRequestId ===
      message.requestId &&
    activeTap?.getRequestId() ===
      message.requestId
  ) {
    lastCaptureStatus = "starting";
    activeCaptureRequestId =
      message.requestId;
    cancelOverlayDestroy();

    const overlay = ensureOverlay();
    overlay.setTranslationPath(
      activeTranslationPath,
    );
    overlay.setSilentInputHint(
      activeSilentInputHint,
    );
    overlay.setStatus("loadingModel");

    postTapState(
      message.requestId,
      "tapping",
      activeTap.isSuspended()
        ? "audio-context-suspended"
        : "already-tapping",
    );
    return;
  }

  const preservePresentation =
    activeCaptureRequestId ===
    message.requestId;

  contentSessionRequestId =
    message.requestId;
  activeCaptureRequestId =
    message.requestId;
  pendingContextTermsRequestId =
    message.requestId;
  // Extraction must run AFTER the tap target is selected (closest("article")
  // needs the target element); defer to first-PCM attach time.
  pendingContextTerms = null;
  resetContentTranslator();

  if (!preservePresentation) {
    activeTranslationPath = null;
    activeSilentInputHint = false;
  }

  lastCaptureStatus = "starting";

  destroyOverlay();

  const overlay = ensureOverlay();
  overlay.setTranslationPath(
    activeTranslationPath,
  );
  overlay.setSilentInputHint(
    activeSilentInputHint,
  );
  overlay.setStatus("loadingModel");

  void enqueueTapOperation(() =>
    startTap(message.requestId),
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

  reconnectTimerId = window.setTimeout(
    () => {
      reconnectTimerId = null;
      connectBackgroundPort();
    },
    delay,
  );
}

function enqueueTapOperation(
  operation: () => Promise<void>,
): Promise<void> {
  const next = tapOperationTail
    .catch(() => undefined)
    .then(operation);

  tapOperationTail = next.catch(
    (error: unknown) => {
      console.error(
        "[cs]",
        "tap operation failed",
        error,
      );
    },
  );

  return next;
}

function enqueueContentTranslation(
  message: CsTranslateMessage,
): void {
  const operation = contentTranslationTail
    .catch(() => undefined)
    .then(() =>
      handleContentTranslation(message),
    );

  contentTranslationTail = operation.catch(
    (error: unknown) => {
      console.error(
        "[cs]",
        "content translation operation failed",
        error,
      );
    },
  );
}

async function handleContentTranslation(
  message: CsTranslateMessage,
): Promise<void> {
  const sessionGeneration =
    contentTranslatorGeneration;

  if (
    !isContentTranslationSessionCurrent(
      message.requestId,
      sessionGeneration,
    )
  ) {
    postAbortedContentTranslation(message);
    return;
  }

  try {
    const translator =
      await ensureContentTranslator(
        message.requestId,
        sessionGeneration,
      );

    if (
      !isContentTranslationSessionCurrent(
        message.requestId,
        sessionGeneration,
      )
    ) {
      postAbortedContentTranslation(message);
      return;
    }

    if (translator === null) {
      postTranslationResult({
        t: "CS_TRANSLATE_RESULT",
        requestId: message.requestId,
        id: message.id,
        ja: "",
        available: false,
      });
      return;
    }

    if (message.text.trim() === "") {
      postTranslationResult({
        t: "CS_TRANSLATE_RESULT",
        requestId: message.requestId,
        id: message.id,
        ja: "",
        available: true,
      });
      return;
    }

    const ja =
      await translator.translate(
        message.text,
      );

    if (
      !isContentTranslationSessionCurrent(
        message.requestId,
        sessionGeneration,
      )
    ) {
      postAbortedContentTranslation(message);
      return;
    }

    postTranslationResult({
      t: "CS_TRANSLATE_RESULT",
      requestId: message.requestId,
      id: message.id,
      ja,
      available: true,
    });
  } catch (error) {
    if (
      !isContentTranslationSessionCurrent(
        message.requestId,
        sessionGeneration,
      )
    ) {
      postAbortedContentTranslation(message);
      return;
    }

    destroyContentTranslator();

    postTranslationResult({
      t: "CS_TRANSLATE_RESULT",
      requestId: message.requestId,
      id: message.id,
      ja: "",
      available: false,
      error: toProbeError(error),
    });
  }
}

async function ensureContentTranslator(
  requestId: string,
  generation: number,
): Promise<TranslatorInstance | null> {
  while (
    isContentTranslationSessionCurrent(
      requestId,
      generation,
    )
  ) {
    if (contentTranslator !== null) {
      return contentTranslator;
    }

    let createPromise =
      contentTranslatorCreatePromise;
    let createGeneration =
      contentTranslatorCreateGeneration;

    if (createPromise === null) {
      if (contentTranslatorCreateAttempted) {
        return null;
      }

      createGeneration = generation;
      createPromise =
        createContentTranslator(
          requestId,
          generation,
        );
      contentTranslatorCreatePromise =
        createPromise;
      contentTranslatorCreateGeneration =
        createGeneration;
    }

    let translator:
      | TranslatorInstance
      | null;

    try {
      translator =
        await waitWithTimeout(
          createPromise,
          TRANSLATOR_CREATE_WAIT_MS,
          "Content Translator creation timed out",
        );
    } catch (error) {
      if (
        contentTranslatorCreatePromise ===
          createPromise
      ) {
        contentTranslatorCreatePromise = null;
        contentTranslatorCreateGeneration =
          null;
        contentTranslatorCreateAttempted =
          true;
      }

      throw error;
    } finally {
      if (
        contentTranslatorCreatePromise ===
          createPromise
      ) {
        contentTranslatorCreatePromise = null;
        contentTranslatorCreateGeneration =
          null;
      }
    }

    if (
      !isContentTranslationSessionCurrent(
        requestId,
        generation,
      )
    ) {
      return null;
    }

    if (createGeneration !== generation) {
      continue;
    }

    return translator;
  }

  return null;
}

async function createContentTranslator(
  requestId: string,
  generation: number,
): Promise<TranslatorInstance | null> {
  try {
    const scope =
      globalThis as TranslatorScope;
    const factory = scope.Translator;

    if (
      !("Translator" in scope) ||
      factory === undefined ||
      typeof factory.availability !==
        "function" ||
      typeof factory.create !== "function"
    ) {
      return null;
    }

    const availability =
      await factory.availability({
        sourceLanguage: "en",
        targetLanguage: "ja",
      });

    if (
      !isContentTranslationSessionCurrent(
        requestId,
        generation,
      )
    ) {
      return null;
    }

    if (availability !== "available") {
      return null;
    }

    contentTranslatorCreateAttempted = true;

    const translator =
      await factory.create({
        sourceLanguage: "en",
        targetLanguage: "ja",
      });

    if (
      !isContentTranslationSessionCurrent(
        requestId,
        generation,
      )
    ) {
      destroyContentTranslatorInstance(
        translator,
      );
      return null;
    }

    contentTranslator = translator;
    return translator;
  } catch (error) {
    if (
      !isContentTranslationSessionCurrent(
        requestId,
        generation,
      )
    ) {
      return null;
    }

    throw error;
  }
}

function isContentTranslationSessionCurrent(
  requestId: string,
  generation: number,
): boolean {
  return (
    contentSessionRequestId === requestId &&
    contentTranslatorGeneration === generation
  );
}

function postAbortedContentTranslation(
  message: CsTranslateMessage,
): void {
  postTranslationResult({
    t: "CS_TRANSLATE_RESULT",
    requestId: message.requestId,
    id: message.id,
    ja: "",
    available: false,
    error: {
      name: "AbortError",
      message:
        "Translation request was aborted because the content session changed",
    },
  });
}

function resetContentTranslator(): void {
  contentTranslatorGeneration += 1;
  destroyContentTranslator();
  contentTranslatorCreateAttempted = false;
  contentTranslationTail =
    Promise.resolve();
}

function destroyContentTranslator(): void {
  const translator = contentTranslator;
  contentTranslator = null;

  if (translator !== null) {
    destroyContentTranslatorInstance(
      translator,
    );
  }
}

function destroyContentTranslatorInstance(
  translator: TranslatorInstance,
): void {
  try {
    translator.destroy();
  } catch (error) {
    console.warn(
      "[cs]",
      "content Translator cleanup failed",
      error,
    );
  }
}

function postTranslationResult(
  message: CsTranslateResultMessage,
): void {
  postContentMessage(message);
}

async function startTap(
  requestId: string,
): Promise<void> {
  if (activeTap !== null) {
    if (
      activeTap.getRequestId() === requestId
    ) {
      postTapState(
        requestId,
        "tapping",
        activeTap.isSuspended()
          ? "audio-context-suspended"
          : "already-tapping",
      );
      return;
    }

    clearPendingContextTerms(requestId);
    postTapState(
      requestId,
      "error",
      "another-tap-is-active",
    );
    showOverlayError();
    return;
  }

  const tap = new AudioTap(requestId, {
    onChunk(seq, b64) {
      if (activeTap !== tap) {
        return;
      }

      const attachContextTerms =
        pendingContextTermsRequestId ===
        requestId;
      if (
        attachContextTerms &&
        pendingContextTerms === null
      ) {
        pendingContextTerms =
          extractPostContextTerms();
      }

      const contextTerms =
        attachContextTerms &&
        pendingContextTerms !== null
          ? [...pendingContextTerms]
          : undefined;

      const message: CsPcmMessage = {
        t: "CS_PCM",
        requestId,
        seq,
        b64,
        ...(contextTerms === undefined
          ? {}
          : { contextTerms }),
      };

      postContentMessage(message);

      if (attachContextTerms) {
        clearPendingContextTerms(
          requestId,
        );
      }
    },

    onDetail(detail) {
      if (activeTap === tap) {
        postTapState(
          requestId,
          "tapping",
          detail,
        );
      }
    },

    onStopped(detail) {
      if (activeTap === tap) {
        activeTap = null;
      }

      clearPendingContextTerms(requestId);

      if (
        contentSessionRequestId ===
          requestId
      ) {
        contentSessionRequestId = null;
        resetContentTranslator();
      }

      lastCaptureStatus = "stopping";
      activeCaptureRequestId = null;
      activeTranslationPath = null;
      activeSilentInputHint = false;
      destroyOverlay();

      postTapState(
        requestId,
        "stopped",
        detail,
      );
    },

    onError(error) {
      if (activeTap === tap) {
        activeTap = null;
      }

      clearPendingContextTerms(requestId);

      if (
        contentSessionRequestId ===
          requestId
      ) {
        contentSessionRequestId = null;
        resetContentTranslator();
      }

      activeCaptureRequestId = null;
      activeTranslationPath = null;
      activeSilentInputHint = false;
      showOverlayError();

      postTapState(
        requestId,
        "error",
        getAudioTapErrorDetail(error),
      );
    },
  });

  activeTap = tap;

  try {
    const detail = await tap.start();

    if (activeTap !== tap) {
      await tap.stop();
      return;
    }

    postTapState(
      requestId,
      "tapping",
      detail,
    );
  } catch (error) {
    if (activeTap === tap) {
      activeTap = null;
    }

    clearPendingContextTerms(requestId);

    if (
      contentSessionRequestId === requestId
    ) {
      contentSessionRequestId = null;
      resetContentTranslator();
    }

    activeCaptureRequestId = null;
    activeTranslationPath = null;
    activeSilentInputHint = false;
    showOverlayError();

    postTapState(
      requestId,
      "error",
      getAudioTapErrorDetail(error),
    );
  }
}

async function stopTap(
  requestId: string,
  detail: string,
): Promise<void> {
  clearPendingContextTerms(requestId);

  const tap = activeTap;

  if (
    tap === null ||
    tap.getRequestId() !== requestId
  ) {
    postTapState(
      requestId,
      "stopped",
      "already-stopped",
    );
    return;
  }

  activeTap = null;

  try {
    await tap.stop();

    postTapState(
      requestId,
      "stopped",
      detail,
    );
  } catch (error) {
    showOverlayError();

    postTapState(
      requestId,
      "error",
      getAudioTapErrorDetail(error),
    );
  }
}

function handleCaptureState(
  state: CaptureState,
): void {
  if (
    isActivePresentationStatus(
      state.status,
    ) &&
    state.requestId !== undefined
  ) {
    if (
      activeCaptureRequestId !==
      state.requestId
    ) {
      activeCaptureRequestId =
        state.requestId;
      activeTranslationPath = null;
      activeSilentInputHint = false;

      captionOverlay?.setTranslationPath(
        null,
      );
      captionOverlay?.setSilentInputHint(
        false,
      );
    }
  }

  lastCaptureStatus = state.status;

  switch (state.status) {
    case "starting":
      activeSilentInputHint = false;
      cancelOverlayDestroy();
      ensureOverlay().setSilentInputHint(
        false,
      );
      ensureOverlay().setStatus(
        "loadingModel",
      );
      return;

    case "loadingModel":
      activeSilentInputHint = false;
      cancelOverlayDestroy();
      ensureOverlay().setSilentInputHint(
        false,
      );
      ensureOverlay().setStatus(
        "loadingModel",
        state.progress,
      );
      return;

    case "running":
      cancelOverlayDestroy();
      ensureOverlay().setSilentInputHint(
        activeSilentInputHint,
      );
      ensureOverlay().setStatus("running");
      return;

    case "error":
      activeCaptureRequestId = null;
      activeTranslationPath = null;
      activeSilentInputHint = false;
      contentSessionRequestId = null;
      clearPendingContextTerms();
      resetContentTranslator();
      showOverlayError(state.progress);
      return;

    case "stopping":
    case "idle":
      activeCaptureRequestId = null;
      activeTranslationPath = null;
      activeSilentInputHint = false;
      contentSessionRequestId = null;
      clearPendingContextTerms();
      resetContentTranslator();
      destroyOverlay();
  }
}

function isActivePresentationStatus(
  status: CaptureStatus,
): boolean {
  return (
    status === "starting" ||
    status === "loadingModel" ||
    status === "running"
  );
}

function isPresentationMessageCurrent(
  requestId: string,
): boolean {
  const expectedRequestId =
    contentSessionRequestId ??
    activeCaptureRequestId;

  return (
    expectedRequestId !== null &&
    expectedRequestId === requestId &&
    isActivePresentationStatus(
      lastCaptureStatus,
    )
  );
}

function handleCaption(
  message: SwCaptionMessage,
): void {
  cancelOverlayDestroy();
  ensureOverlay().showCaption(message);
}

function ensureOverlay(): CaptionOverlay {
  if (captionOverlay !== null) {
    syncOverlayPlaybackGate(
      captionOverlay,
    );
    return captionOverlay;
  }

  const overlay = new CaptionOverlay({
    getTargetVideo:
      getCurrentAudioTapTarget,
    showOriginal: activeShowOriginal,
    onCaptionFadeOut() {
      if (
        lastCaptureStatus === "idle" ||
        lastCaptureStatus === "stopping"
      ) {
        destroyOverlay();
      }
    },
  });

  overlay.setTranslationPath(
    activeTranslationPath,
  );
  overlay.setSilentInputHint(
    activeSilentInputHint,
  );
  captionOverlay = overlay;
  syncOverlayPlaybackGate(overlay);
  return overlay;
}

function showOverlayError(
  progress?: number,
): void {
  lastCaptureStatus = "error";
  activeSilentInputHint = false;
  cancelOverlayDestroy();
  clearTargetPlaybackFreeze();

  const overlay = ensureOverlay();
  overlay.clear();
  overlay.setTranslationPath(null);
  overlay.setSilentInputHint(false);
  overlay.setStatus("error", progress);

  overlayDestroyTimerId =
    window.setTimeout(() => {
      overlayDestroyTimerId = null;

      if (lastCaptureStatus === "error") {
        destroyOverlay();
      }
    }, ERROR_CHIP_VISIBLE_MS);
}

function cancelOverlayDestroy(): void {
  if (overlayDestroyTimerId === null) {
    return;
  }

  globalThis.clearTimeout(
    overlayDestroyTimerId,
  );
  overlayDestroyTimerId = null;
}

function destroyOverlay(): void {
  cancelOverlayDestroy();
  clearTargetPlaybackFreeze();

  const overlay = captionOverlay;
  captionOverlay = null;
  overlay?.destroy();
}

function postTapState(
  requestId: string,
  state: CsTapStateMessage["state"],
  detail?: string,
): void {
  const message: CsTapStateMessage = {
    t: "CS_TAP_STATE",
    requestId,
    state,
    ...(detail === undefined
      ? {}
      : { detail }),
  };

  postContentMessage(message);
}

function postContentMessage(
  message:
    | CsPcmMessage
    | CsTapStateMessage
    | CsTranslateResultMessage,
): void {
  const port = backgroundPort;

  if (port === null) {
    return;
  }

  try {
    port.postMessage(message);
  } catch (error) {
    console.warn(
      "[cs]",
      "could not post content-port message",
      error,
    );
  }
}

function extractPostContextTerms(): string[] {
  const articles = new Set<HTMLElement>();
  const target =
    getCurrentAudioTapTarget();
  const targetArticle =
    target?.closest("article");

  if (targetArticle instanceof HTMLElement) {
    articles.add(targetArticle);
  }

  if (
    /^\/[^/]+\/status\/\d+(?:\/|$)/u.test(
      location.pathname,
    )
  ) {
    const mainPost =
      document.querySelector(
        "main article",
      );

    if (mainPost instanceof HTMLElement) {
      articles.add(mainPost);
    }
  }

  const terms: string[] = [];
  const seen = new Set<string>();

  for (const article of articles) {
    const text =
      article.innerText ||
      article.textContent ||
      "";
    const matches = text.match(
      /@[A-Za-z0-9_]{3,15}|[\p{Lu}][\p{L}\p{M}\p{N}'’._-]{3,}/gu,
    ) ?? [];

    for (const match of matches) {
      const term = match
        .normalize("NFKC")
        .trim();

      // The wire guard (isContextTerms) rejects terms over 128 characters;
      // a single oversized term must not invalidate the whole message.
      const termLength = Array.from(term).length;

      if (
        termLength < 4 ||
        termLength > 128 ||
        !(
          term.startsWith("@") ||
          /^\p{Lu}/u.test(term)
        )
      ) {
        continue;
      }

      const key = term
        .replace(/^@/u, "")
        .toLocaleLowerCase("en-US");

      if (
        key === "" ||
        seen.has(key) ||
        (
          !term.startsWith("@") &&
          CONTEXT_TERM_STOPLIST.has(key)
        )
      ) {
        continue;
      }

      seen.add(key);
      terms.push(term);

      if (
        terms.length >= MAX_CONTEXT_TERMS
      ) {
        return terms;
      }
    }
  }

  return terms;
}

function clearPendingContextTerms(
  requestId?: string,
): void {
  if (
    requestId !== undefined &&
    pendingContextTermsRequestId !== requestId
  ) {
    return;
  }

  pendingContextTerms = null;
  pendingContextTermsRequestId = null;
}

async function runInitialProbe(): Promise<void> {
  const requestId =
    createProbeRequestId("content-load");
  const result = await probeTranslator();

  const message: ContentScriptProbeResultMessage = {
    t: "CS_PROBE_RESULT",
    requestId,
    result,
  };

  try {
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
      return;
    }

    if (
      isMessageOfType(
        response,
        "PROBE_ERROR",
      ) &&
      response.requestId === requestId
    ) {
      console.error(
        "[cs]",
        "background rejected initial probe",
        response.error,
      );
    }
  } catch (error) {
    console.error(
      "[cs]",
      "could not send initial probe result",
      error,
    );
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
      context: "content-script",
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
      context: "content-script",
      exposed: true,
      availability,
      startedAt,
      completedAt: nowIso(),
      environment: getProbeEnvironment(),
    };
  } catch (error) {
    return {
      context: "content-script",
      exposed: true,
      availability: null,
      startedAt,
      completedAt: nowIso(),
      environment: getProbeEnvironment(),
      error: toProbeError(error),
    };
  }
}

function waitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>(
    (resolve, reject) => {
      let settled = false;

      const timerId = self.setTimeout(
        () => {
          if (settled) {
            return;
          }

          settled = true;
          const error = new Error(message);
          error.name = "TimeoutError";
          reject(error);
        },
        timeoutMs,
      );

      void promise.then(
        (value) => {
          if (settled) {
            return;
          }

          settled = true;
          globalThis.clearTimeout(timerId);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) {
            return;
          }

          settled = true;
          globalThis.clearTimeout(timerId);
          reject(error);
        },
      );
    },
  );
}
