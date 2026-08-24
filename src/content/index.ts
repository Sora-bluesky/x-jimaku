import {
  createProbeRequestId,
  getProbeEnvironment,
  isMessageOfType,
  nowIso,
  toProbeError,
  type ContentScriptProbeResultMessage,
  type CsPcmMessage,
  type CsTapStateMessage,
  type CsTranslateMessage,
  type CsTranslateResultMessage,
  type ProbeFailureMessage,
  type SwCaptionMessage,
  type TranslationPath,
  type TranslatorProbeResult,
} from "../shared/messages";
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

const CONTENT_PORT_NAME = "content";
const INITIAL_RECONNECT_DELAY_MS = 100;
const MAX_RECONNECT_DELAY_MS = 1_000;
const ERROR_CHIP_VISIBLE_MS = 2_500;

let backgroundPort: chrome.runtime.Port | null =
  null;
let reconnectTimerId: number | null = null;
let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
let activeTap: AudioTap | null = null;
let tapOperationTail: Promise<void> =
  Promise.resolve();
let contentTranslationTail: Promise<void> =
  Promise.resolve();
let contentTranslator:
  | TranslatorInstance
  | null = null;
let contentTranslatorCreateAttempted = false;
let contentSessionRequestId:
  | string
  | null = null;
let captionOverlay: CaptionOverlay | null =
  null;
let overlayDestroyTimerId: number | null =
  null;
let lastCaptureStatus: CaptureStatus =
  "idle";
let activeTranslationPath:
  | TranslationPath
  | null = null;

console.log("[cs]", "content script loaded", {
  url: location.href,
  topLevel: window === window.top,
});

connectBackgroundPort();
void runInitialProbe();

chrome.runtime.onMessage.addListener(
  (
    message: unknown,
    _sender,
    sendResponse: (
      response:
        | ContentScriptProbeResultMessage
        | ProbeFailureMessage,
    ) => void,
  ): boolean => {
    if (!isMessageOfType(message, "PROBE")) {
      return false;
    }

    console.log(
      "[cs]",
      "probe request received",
      message.requestId,
    );

    void probeTranslator()
      .then((result) => {
        const response:
          ContentScriptProbeResultMessage = {
            t: "CS_PROBE_RESULT",
            requestId: message.requestId,
            result,
          };

        console.log("[cs]", "probe complete", result);
        sendResponse(response);
      })
      .catch((error: unknown) => {
        console.error("[cs]", "probe failed", error);

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
          contentSessionRequestId =
            message.requestId;
          resetContentTranslator();
          activeTranslationPath = null;
          lastCaptureStatus = "starting";

          const overlay = ensureOverlay();
          overlay.setTranslationPath(null);
          overlay.setStatus("loadingModel");

          void enqueueTapOperation(() =>
            startTap(message.requestId),
          );
          return;
        }

        if (
          isMessageOfType(
            message,
            "CS_STOP_TAP",
          )
        ) {
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
            contentSessionRequestId !== null &&
            message.requestId !==
              contentSessionRequestId
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

      console.warn(
        "[cs]",
        "background port disconnected",
        disconnectError ?? "",
      );

      lastCaptureStatus = "idle";
      activeTranslationPath = null;
      contentSessionRequestId = null;
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

    console.log(
      "[cs]",
      "background port connected",
    );
  } catch (error) {
    console.warn(
      "[cs]",
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
  if (
    contentSessionRequestId !==
      message.requestId
  ) {
    postTranslationResult({
      t: "CS_TRANSLATE_RESULT",
      requestId: message.requestId,
      id: message.id,
      ja: "",
      available: false,
      error: {
        name: "AbortError",
        message:
          "Translation request does not belong to the active content session",
      },
    });
    return;
  }

  try {
    const translator =
      await ensureContentTranslator();

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
      contentSessionRequestId !==
        message.requestId
    ) {
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

async function ensureContentTranslator(): Promise<
  TranslatorInstance | null
> {
  if (contentTranslator !== null) {
    return contentTranslator;
  }

  if (contentTranslatorCreateAttempted) {
    return null;
  }

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

  if (availability !== "available") {
    return null;
  }

  contentTranslatorCreateAttempted = true;
  contentTranslator =
    await factory.create({
      sourceLanguage: "en",
      targetLanguage: "ja",
    });

  return contentTranslator;
}

function resetContentTranslator(): void {
  destroyContentTranslator();
  contentTranslatorCreateAttempted = false;
  contentTranslationTail =
    Promise.resolve();
}

function destroyContentTranslator(): void {
  const translator = contentTranslator;
  contentTranslator = null;

  if (translator === null) {
    return;
  }

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

      const message: CsPcmMessage = {
        t: "CS_PCM",
        requestId,
        seq,
        b64,
      };

      postContentMessage(message);
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

      if (
        contentSessionRequestId ===
          requestId
      ) {
        contentSessionRequestId = null;
        resetContentTranslator();
      }

      lastCaptureStatus = "stopping";
      activeTranslationPath = null;
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

      if (
        contentSessionRequestId ===
          requestId
      ) {
        contentSessionRequestId = null;
        resetContentTranslator();
      }

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

    console.log("[tap]", "audio tap started", {
      requestId,
      detail,
    });
  } catch (error) {
    if (activeTap === tap) {
      activeTap = null;
    }

    if (
      contentSessionRequestId === requestId
    ) {
      contentSessionRequestId = null;
      resetContentTranslator();
    }

    console.error(
      "[tap]",
      "audio tap start failed",
      error,
    );

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

    console.log("[tap]", "audio tap stopped", {
      requestId,
      detail,
    });
  } catch (error) {
    console.error(
      "[tap]",
      "audio tap cleanup failed",
      error,
    );

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
  lastCaptureStatus = state.status;

  switch (state.status) {
    case "starting":
      cancelOverlayDestroy();
      ensureOverlay().setStatus(
        "loadingModel",
      );
      return;

    case "loadingModel":
      cancelOverlayDestroy();
      ensureOverlay().setStatus(
        "loadingModel",
        state.progress,
      );
      return;

    case "running":
      cancelOverlayDestroy();
      ensureOverlay().setStatus("running");
      return;

    case "error":
      activeTranslationPath = null;
      contentSessionRequestId = null;
      resetContentTranslator();
      showOverlayError(state.progress);
      return;

    case "stopping":
    case "idle":
      activeTranslationPath = null;
      contentSessionRequestId = null;
      resetContentTranslator();
      destroyOverlay();
  }
}

function handleCaption(
  message: SwCaptionMessage,
): void {
  cancelOverlayDestroy();
  ensureOverlay().showCaption(message);
}

function ensureOverlay(): CaptionOverlay {
  if (captionOverlay !== null) {
    return captionOverlay;
  }

  const overlay = new CaptionOverlay({
    getTargetVideo:
      getCurrentAudioTapTarget,
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
  captionOverlay = overlay;
  return overlay;
}

function showOverlayError(
  progress?: number,
): void {
  lastCaptureStatus = "error";
  cancelOverlayDestroy();

  const overlay = ensureOverlay();
  overlay.clear();
  overlay.setTranslationPath(null);
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

async function runInitialProbe(): Promise<void> {
  const requestId =
    createProbeRequestId("content-load");
  const result = await probeTranslator();

  const message: ContentScriptProbeResultMessage = {
    t: "CS_PROBE_RESULT",
    requestId,
    result,
  };

  console.log(
    "[cs]",
    "initial Translator probe complete",
    result,
  );

  try {
    const response = (await chrome.runtime.sendMessage(
      message,
    )) as unknown;

    if (
      isMessageOfType(response, "PROBE_STORED") &&
      response.requestId === requestId
    ) {
      console.log(
        "[cs]",
        "initial probe stored",
        response,
      );
      return;
    }

    if (
      isMessageOfType(response, "PROBE_ERROR") &&
      response.requestId === requestId
    ) {
      console.error(
        "[cs]",
        "background rejected initial probe",
        response.error,
      );
      return;
    }

    console.warn(
      "[cs]",
      "background returned an unexpected response",
      response,
    );
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
