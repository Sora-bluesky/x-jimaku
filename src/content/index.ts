import {
  createProbeRequestId,
  getProbeEnvironment,
  isMessageOfType,
  nowIso,
  toProbeError,
  type ContentScriptProbeResultMessage,
  type CsPcmMessage,
  type CsTapStateMessage,
  type ProbeFailureMessage,
  type TranslatorProbeResult,
} from "../shared/messages";
import {
  AudioTap,
  getAudioTapErrorDetail,
} from "./audio-tap";

type TranslatorScope = typeof globalThis & {
  Translator?: TranslatorFactory;
};

const CONTENT_PORT_NAME = "content";
const INITIAL_RECONNECT_DELAY_MS = 100;
const MAX_RECONNECT_DELAY_MS = 1_000;

let backgroundPort: chrome.runtime.Port | null =
  null;
let reconnectTimerId: number | null = null;
let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
let activeTap: AudioTap | null = null;
let tapOperationTail: Promise<void> =
  Promise.resolve();

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
          void enqueueTapOperation(() =>
            stopTap(
              message.requestId,
              "stop-requested",
            ),
          );
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

    console.error(
      "[tap]",
      "audio tap start failed",
      error,
    );

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

    postTapState(
      requestId,
      "error",
      getAudioTapErrorDetail(error),
    );
  }
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
  message: CsPcmMessage | CsTapStateMessage,
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
