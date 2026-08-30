import {
  createProbeRequestId,
  getProbeEnvironment,
  isMessageOfType,
  MAX_CONTEXT_TERMS,
  nowIso,
  toProbeError,
  type ContentScriptProbeResultMessage,
  type CsDevSetSettingsMessage,
  type CsDevToggleMessage,
  type CsDrainCompleteMessage,
  type CsEosMessage,
  type CsPcmMessage,
  type CsPongMessage,
  type CsTapStateMessage,
  type CsTranslateMessage,
  type CsTranslateResultMessage,
  type M1Message,
  type OffDrainReadyMessage,
  type ProbeFailureMessage,
  type SwCaptionMessage,
  type TranslationPath,
  type TranslatorProbeResult,
} from "../shared/messages";
import {
  DEFAULT_SETTINGS,
} from "../shared/settings";
import {
  presentCaptionIfAllowed,
} from "../shared/explicit-stop-drain";
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
  ContentGraceEpisode,
  type GraceEpisodeCloseReason,
  type GraceEpisodeIdentity,
  type GraceEpisodeTransition,
} from "./grace-episode";
import {
  CaptionOverlay,
} from "./overlay";
import {
  OrderedSendBuffer,
  type BufferedSendItem,
} from "./send-buffer";
import {
  resolveSilentInputHint,
  type SilentHintTapState,
  type SilentHintVideoState,
  type SilentInputHintVariant,
} from "./silent-hint";

type TranslatorScope = typeof globalThis & {
  Translator?: TranslatorFactory;
};

type ContentInstanceWindow = Window & {
  __xJimakuContentScriptVersion__?:
    string;
};

type CsStartTapMessage = Extract<
  M1Message,
  { t: "CS_START_TAP" }
>;

type BufferedContentMessage =
  | CsPcmMessage
  | CsEosMessage
  | CsTranslateResultMessage;

type OutboundContentMessage =
  | BufferedContentMessage
  | CsDrainCompleteMessage
  | CsTapStateMessage
  | CsTranslateResultMessage;

const CONTENT_PORT_NAME = "content";
const DEV_ORIGIN =
  "http://127.0.0.1:8123";
const INITIAL_RECONNECT_DELAY_MS = 100;
const MAX_RECONNECT_DELAY_MS = 1_000;
const PCM_SEND_DROP_WARN_INTERVAL_MS =
  5_000;
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

const graceEpisode =
  new ContentGraceEpisode();
const contentSendBuffer =
  new OrderedSendBuffer<
    BufferedContentMessage
  >();

let backgroundPort:
  | chrome.runtime.Port
  | null = null;
let reconnectTimerId: number | null = null;
let reconnectDelayMs =
  INITIAL_RECONNECT_DELAY_MS;
let graceEpisodeTimerId:
  | number
  | null = null;
let pcmSendDropRequestId:
  | string
  | null = null;
let pcmSendDropBufferOverflowCount = 0;
let lastPcmSendDropWarnAt:
  | number
  | null = null;
let activeTap: AudioTap | null = null;
let activeTapLifecycleState:
  | "missing"
  | "starting"
  | "running"
  | "stopping"
  | "closed" = "missing";
let endedAudioTapTarget:
  | HTMLVideoElement
  | null = null;
let lastEosRequestId:
  | string
  | null = null;
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
let activeSilentInputShowHint = false;
let activeShowOriginal =
  DEFAULT_SETTINGS.showOriginal;
let playbackEventTarget:
  | HTMLVideoElement
  | null = null;
let targetPlaybackPaused = false;
let drainingRequestId:
  | string
  | null = null;
let drainReadyRequestId:
  | string
  | null = null;
let drainCompleteSentRequestId:
  | string
  | null = null;

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

  document.addEventListener(
    "visibilitychange",
    handleVisibilityChange,
  );

  if (location.origin === DEV_ORIGIN) {
    window.addEventListener(
      "message",
      handleDevMessage,
    );
  }

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

function handleDevMessage(
  event: MessageEvent<unknown>,
): void {
  if (event.source !== window) {
    return;
  }

  if (
    isMessageOfType(
      event.data,
      "CS_DEV_TOGGLE",
    )
  ) {
    const message: CsDevToggleMessage = {
      t: "CS_DEV_TOGGLE",
    };

    void chrome.runtime.sendMessage(message);
    return;
  }

  if (
    isMessageOfType(
      event.data,
      "CS_DEV_SET_SETTINGS",
    )
  ) {
    const message: CsDevSetSettingsMessage = {
      t: "CS_DEV_SET_SETTINGS",
      settings: event.data.settings,
    };

    void chrome.runtime.sendMessage(message);
  }
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
  document.addEventListener(
    "ended",
    handleTargetPlaybackEvent,
    true,
  );
}

function handleTargetPlaybackEvent(
  event: Event,
): void {
  const target =
    getCurrentAudioTapTarget() ??
    endedAudioTapTarget;

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

  if (event.type === "ended") {
    refreshSilentInputHint();
    return;
  }

  if (
    event.type === "playing" &&
    activeTap?.getRequestId() ===
      lastEosRequestId
  ) {
    lastEosRequestId = null;
  }

  targetPlaybackPaused =
    event.type === "pause";
  captionOverlay?.setPlaybackPaused(
    targetPlaybackPaused,
  );
  refreshSilentInputHint();

  if (
    (
      event.type === "play" ||
      event.type === "playing"
    ) &&
    activeTap === null &&
    lastEosRequestId !== null &&
    contentSessionRequestId ===
      lastEosRequestId
  ) {
    const requestId = lastEosRequestId;

    void enqueueTapOperation(() =>
      startTap(requestId),
    );
  }
}

function handleVisibilityChange(): void {
  expireGraceEpisodeAt(Date.now());
  refreshSilentInputHint();
}

function syncOverlayPlaybackGate(
  overlay: CaptionOverlay,
): void {
  const target =
    getCurrentAudioTapTarget() ??
    endedAudioTapTarget;

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
        expireGraceEpisodeAt(Date.now());

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
          const drain =
            isDrainingRequest(
              message.requestId,
            );

          closeGraceEpisodeForRequest(
            message.requestId,
            "explicit-stop",
          );

          if (!drain) {
            contentSendBuffer.clear();
          }

          clearPendingContextTerms(
            message.requestId,
          );

          if (
            !drain &&
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
          handleCaptureState(
            message.state,
            message.drain === true,
          );
          return;
        }

        if (
          isMessageOfType(
            message,
            "OFF_DRAIN_READY",
          )
        ) {
          handleDrainReady(message);
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

          activeSilentInputShowHint =
            message.showHint;
          refreshSilentInputHint(
            ensureOverlay(),
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
          if (isDrainingRequest()) {
            return;
          }

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
        closeCurrentGraceEpisode(
          "context-dead",
        );
        contentSendBuffer.clear();
        finishCurrentPcmSendDropSession();
        console.info(
          "[cs]",
          "extension was updated; this page's script is retiring (reload the page to refresh)",
        );
        lastCaptureStatus = "idle";
        activeCaptureRequestId = null;
        contentSessionRequestId = null;
        clearExplicitStopDrainState();
        clearPendingContextTerms();
        destroyOverlay();
        return;
      }

      if (
        expireGraceEpisodeAt(
          Date.now(),
        ) !== null
      ) {
        scheduleReconnect();
        return;
      }

      const disconnectDuringCapture =
        contentSessionRequestId !== null ||
        activeTap !== null;

      if (disconnectDuringCapture) {
        console.info(
          "[cs]",
          "background port disconnected during capture",
          disconnectError ?? "",
        );

        openGraceEpisode(Date.now());
        scheduleReconnect();
        return;
      }

      console.info(
        "[cs]",
        "background port disconnected (routine service-worker suspend)",
        disconnectError ?? "",
      );

      contentSendBuffer.clear();
      lastCaptureStatus = "idle";
      activeCaptureRequestId = null;
      activeTranslationPath = null;
      activeSilentInputShowHint = false;
      endedAudioTapTarget = null;
      lastEosRequestId = null;
      activeShowOriginal =
        DEFAULT_SETTINGS.showOriginal;
      contentSessionRequestId = null;
      clearExplicitStopDrainState();
      clearPendingContextTerms();
      resetContentTranslator();
      destroyOverlay();

      void enqueueTapOperation(async () => {
        const tap = activeTap;

        if (tap === null) {
          finishCurrentPcmSendDropSession();
          return;
        }

        beginActiveTapTeardown(tap);

        try {
          await tap.stop();
        } catch (error) {
          console.error(
            "[cs]",
            "tap cleanup after background disconnect failed",
            error,
          );
        } finally {
          clearActiveTap(tap);
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
      closeCurrentGraceEpisode(
        "context-dead",
      );
      contentSendBuffer.clear();
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

function openGraceEpisode(
  now: number,
): void {
  const requestId =
    contentSessionRequestId ??
    activeTap?.getRequestId() ??
    lastEosRequestId;

  if (requestId === null) {
    return;
  }

  const flavor =
    activeTap?.getRequestId() === requestId
      ? "held-tap"
      : (
          lastEosRequestId === requestId
            ? "ended-awaiting-resume"
            : "held-tap"
        );

  const episode = graceEpisode.open(
    requestId,
    now,
    flavor,
  );

  scheduleGraceEpisodeExpiry(
    episode,
    now,
  );
}

function scheduleGraceEpisodeExpiry(
  identity: GraceEpisodeIdentity,
  now: number,
): void {
  clearGraceEpisodeTimer();

  graceEpisodeTimerId =
    window.setTimeout(
      () => {
        graceEpisodeTimerId = null;

        const transition =
          graceEpisode.expire(
            identity,
            Date.now(),
          );

        if (transition !== null) {
          handleExpiredGraceEpisode(
            transition,
          );
        }
      },
      Math.max(
        0,
        identity.deadlineAt - now,
      ),
    );
}

function clearGraceEpisodeTimer(): void {
  if (graceEpisodeTimerId === null) {
    return;
  }

  globalThis.clearTimeout(
    graceEpisodeTimerId,
  );
  graceEpisodeTimerId = null;
}

function expireGraceEpisodeAt(
  now: number,
): GraceEpisodeTransition | null {
  const current =
    graceEpisode.getCurrent();

  if (
    current === null ||
    !graceEpisode.isExpired(now)
  ) {
    return null;
  }

  const transition =
    graceEpisode.expire(
      current,
      now,
    );

  if (transition === null) {
    return null;
  }

  clearGraceEpisodeTimer();
  handleExpiredGraceEpisode(transition);
  return transition;
}

function handleExpiredGraceEpisode(
  transition: GraceEpisodeTransition,
): void {
  console.warn(
    "[cs]",
    "background reconnect grace period expired; capture recovery failed",
    {
      requestId:
        transition.episode.requestId,
    },
  );

  beginFullGraceTeardown(
    transition.episode.requestId,
    "grace period expired",
  );
}

function closeGraceEpisodeForRequest(
  requestId: string,
  reason: GraceEpisodeCloseReason,
): GraceEpisodeTransition | null {
  const current =
    graceEpisode.getCurrent();

  if (
    current === null ||
    current.requestId !== requestId
  ) {
    return null;
  }

  const transition =
    graceEpisode.close(
      reason,
      current,
    );

  if (transition !== null) {
    clearGraceEpisodeTimer();
  }

  return transition;
}

function closeCurrentGraceEpisode(
  reason: GraceEpisodeCloseReason,
): GraceEpisodeTransition | null {
  const current =
    graceEpisode.getCurrent();

  if (current === null) {
    return null;
  }

  const transition =
    graceEpisode.close(
      reason,
      current,
    );

  if (transition !== null) {
    clearGraceEpisodeTimer();
  }

  return transition;
}

function completeGraceResume(
  identity: GraceEpisodeIdentity,
): void {
  const transition =
    graceEpisode.close(
      "resumed",
      identity,
    );

  if (transition === null) {
    return;
  }

  clearGraceEpisodeTimer();
  flushBufferedContentMessages();

  if (
    transition.episode.flavor ===
      "ended-awaiting-resume"
  ) {
    finishPcmSendDropSession(
      transition.episode.requestId,
    );
  }
}

function beginFullGraceTeardown(
  requestId: string,
  failureContext: string,
): void {
  contentSendBuffer.clear();
  finishCurrentPcmSendDropSession();
  lastCaptureStatus = "idle";
  activeCaptureRequestId = null;
  activeTranslationPath = null;
  activeSilentInputShowHint = false;
  endedAudioTapTarget = null;
  lastEosRequestId = null;
  activeShowOriginal =
    DEFAULT_SETTINGS.showOriginal;
  contentSessionRequestId = null;
  clearExplicitStopDrainState();
  clearPendingContextTerms();
  resetContentTranslator();
  destroyOverlay();

  void enqueueTapOperation(() =>
    stopHeldTapAfterGrace(
      requestId,
      failureContext,
    ),
  );
}

async function stopHeldTapAfterGrace(
  requestId: string,
  failureContext: string,
): Promise<void> {
  const tap = activeTap;

  if (
    tap === null ||
    tap.getRequestId() !== requestId
  ) {
    return;
  }

  beginActiveTapTeardown(tap);

  try {
    await tap.stop();
  } catch (error) {
    console.error(
      "[cs]",
      `${failureContext}: tap cleanup failed`,
      error,
    );
  } finally {
    clearActiveTap(tap);
  }
}

function handleStartTapMessage(
  message: CsStartTapMessage,
): void {
  const currentGrace =
    graceEpisode.getCurrent();

  if (
    currentGrace !== null &&
    currentGrace.requestId !==
      message.requestId
  ) {
    closeGraceEpisodeForRequest(
      currentGrace.requestId,
      "different-request",
    );
    beginFullGraceTeardown(
      currentGrace.requestId,
      "different request started",
    );
    enqueueFreshTap(
      message,
      false,
    );
    return;
  }

  if (
    currentGrace !== null &&
    currentGrace.requestId ===
      message.requestId
  ) {
    if (
      activeTap?.getRequestId() ===
        message.requestId
    ) {
      const identity =
        graceEpisode.resumeRequested(
          message.requestId,
          Date.now(),
        );

      if (identity === null) {
        expireGraceEpisodeAt(
          Date.now(),
        );
        enqueueFreshTap(
          message,
          false,
        );
        return;
      }

      graceEpisode.setFlavor(
        message.requestId,
        "held-tap",
      );
      activeShowOriginal =
        message.settings?.showOriginal ??
        DEFAULT_SETTINGS.showOriginal;
      beginPcmSendDropSession(
        message.requestId,
      );
      lastCaptureStatus = "starting";
      activeCaptureRequestId =
        message.requestId;
      cancelOverlayDestroy();

      const overlay = ensureOverlay();
      overlay.setTranslationPath(
        activeTranslationPath,
      );
      refreshSilentInputHint(overlay);
      overlay.setStatus("loadingModel");

      const posted = postTapState(
        message.requestId,
        "tapping",
        activeTap.isSuspended()
          ? "audio-context-suspended"
          : "already-tapping",
      );

      if (posted) {
        completeGraceResume(identity);
      }

      return;
    }

    if (
      lastEosRequestId ===
        message.requestId
    ) {
      graceEpisode.setFlavor(
        message.requestId,
        "ended-awaiting-resume",
      );

      const identity =
        graceEpisode.resumeRequested(
          message.requestId,
          Date.now(),
        );

      if (identity === null) {
        expireGraceEpisodeAt(
          Date.now(),
        );
        enqueueFreshTap(
          message,
          false,
        );
        return;
      }

      activeShowOriginal =
        message.settings?.showOriginal ??
        DEFAULT_SETTINGS.showOriginal;
      activeCaptureRequestId =
        message.requestId;
      cancelOverlayDestroy();
      refreshSilentInputHint();

      const posted = postTapState(
        message.requestId,
        "stopped",
        "ended-awaiting-resume",
      );

      if (posted) {
        completeGraceResume(identity);
      }

      return;
    }

    closeGraceEpisodeForRequest(
      message.requestId,
      "explicit-stop",
    );
    beginFullGraceTeardown(
      message.requestId,
      "held tap was unavailable",
    );
    enqueueFreshTap(
      message,
      false,
    );
    return;
  }

  activeShowOriginal =
    message.settings?.showOriginal ??
    DEFAULT_SETTINGS.showOriginal;

  beginPcmSendDropSession(
    message.requestId,
  );

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
    refreshSilentInputHint(overlay);
    overlay.setStatus("loadingModel");

    const posted = postTapState(
      message.requestId,
      "tapping",
      activeTap.isSuspended()
        ? "audio-context-suspended"
        : "already-tapping",
    );

    if (
      posted &&
      contentSendBuffer.pendingCount > 0
    ) {
      flushBufferedContentMessages();
    }

    return;
  }

  const preservePresentation =
    activeCaptureRequestId ===
    message.requestId;

  enqueueFreshTap(
    message,
    preservePresentation,
  );
}

function enqueueFreshTap(
  message: CsStartTapMessage,
  preservePresentation: boolean,
): void {
  void enqueueTapOperation(async () => {
    prepareFreshTapSession(
      message,
      preservePresentation,
    );
    await startTap(message.requestId);
  });
}

function prepareFreshTapSession(
  message: CsStartTapMessage,
  preservePresentation: boolean,
): void {
  clearExplicitStopDrainState();

  activeShowOriginal =
    message.settings?.showOriginal ??
    DEFAULT_SETTINGS.showOriginal;
  beginPcmSendDropSession(
    message.requestId,
  );
  endedAudioTapTarget = null;
  lastEosRequestId = null;
  contentSessionRequestId =
    message.requestId;
  activeCaptureRequestId =
    message.requestId;
  pendingContextTermsRequestId =
    message.requestId;
  pendingContextTerms = null;
  resetContentTranslator();

  if (!preservePresentation) {
    activeTranslationPath = null;
    activeSilentInputShowHint = false;
  }

  lastCaptureStatus = "starting";

  destroyOverlay();

  const overlay = ensureOverlay();
  overlay.setTranslationPath(
    activeTranslationPath,
  );
  refreshSilentInputHint(overlay);
  overlay.setStatus("loadingModel");
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

  beginPcmSendDropSession(requestId);

  const tap = new AudioTap(requestId, {
    onChunk(seq, b64) {
      if (activeTap !== tap) {
        return;
      }

      endedAudioTapTarget = null;

      if (lastEosRequestId === requestId) {
        lastEosRequestId = null;
      }

      graceEpisode.setFlavor(
        requestId,
        "held-tap",
      );

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

        if (
          detail ===
          "audio-context-running"
        ) {
          refreshSilentInputHint();
        }
      }
    },

    onContextStateChange(state) {
      if (activeTap !== tap) {
        return;
      }

      if (state === "closed") {
        activeTapLifecycleState =
          "closed";
      }

      refreshSilentInputHint();
    },

    onTargetChanged(target) {
      if (activeTap !== tap) {
        return;
      }

      if (target === null) {
        beginActiveTapTeardown(tap);
        return;
      }

      refreshSilentInputHint();
    },

    onMediaEnded() {
      if (activeTap !== tap) {
        return;
      }

      postEndOfStream(requestId);
    },

    onStopped(detail, target) {
      if (detail === "track-ended") {
        endedAudioTapTarget =
          target?.isConnected === true
            ? target
            : null;
        graceEpisode.setFlavor(
          requestId,
          "ended-awaiting-resume",
        );
        clearActiveTap(tap);
        postEndOfStream(requestId);
        return;
      }

      const drain =
        isDrainingRequest(requestId);

      closeGraceEpisodeForRequest(
        requestId,
        "explicit-stop",
      );

      if (!drain) {
        contentSendBuffer.clear();
      }

      endedAudioTapTarget = null;
      lastEosRequestId = null;
      clearPendingContextTerms(requestId);

      if (
        !drain &&
        contentSessionRequestId ===
          requestId
      ) {
        contentSessionRequestId = null;
        resetContentTranslator();
      }

      lastCaptureStatus = "stopping";
      activeSilentInputShowHint = false;
      clearActiveTap(tap);

      if (drain) {
        refreshSilentInputHint();
      } else {
        activeCaptureRequestId = null;
        activeTranslationPath = null;
        destroyOverlay();
      }

      postTapState(
        requestId,
        "stopped",
        detail,
      );
    },

    onError(error) {
      closeGraceEpisodeForRequest(
        requestId,
        "explicit-stop",
      );
      contentSendBuffer.clear();
      endedAudioTapTarget = null;
      lastEosRequestId = null;
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
      activeSilentInputShowHint = false;
      clearActiveTap(tap);
      showOverlayError();

      postTapState(
        requestId,
        "error",
        getAudioTapErrorDetail(error),
      );
    },
  });

  activeTap = tap;
  activeTapLifecycleState = "starting";
  graceEpisode.setFlavor(
    requestId,
    "held-tap",
  );
  refreshSilentInputHint();

  try {
    const detail = await tap.start();

    if (activeTap !== tap) {
      await tap.stop();
      refreshSilentInputHint();
      return;
    }

    activeTapLifecycleState = "running";
    refreshSilentInputHint();

    postTapState(
      requestId,
      "tapping",
      detail,
    );
  } catch (error) {
    closeGraceEpisodeForRequest(
      requestId,
      "explicit-stop",
    );
    contentSendBuffer.clear();
    endedAudioTapTarget = null;
    lastEosRequestId = null;
    clearPendingContextTerms(requestId);

    if (
      contentSessionRequestId === requestId
    ) {
      contentSessionRequestId = null;
      resetContentTranslator();
    }

    activeCaptureRequestId = null;
    activeTranslationPath = null;
    activeSilentInputShowHint = false;
    clearActiveTap(tap);
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
  endedAudioTapTarget = null;
  lastEosRequestId = null;
  clearPendingContextTerms(requestId);

  const tap = activeTap;

  if (
    tap === null ||
    tap.getRequestId() !== requestId
  ) {
    finishPcmSendDropSession(requestId);
    postTapState(
      requestId,
      "stopped",
      "already-stopped",
    );
    return;
  }

  beginActiveTapTeardown(tap);

  try {
    await tap.stop();
    clearActiveTap(tap);

    postTapState(
      requestId,
      "stopped",
      detail,
    );
  } catch (error) {
    clearActiveTap(tap);
    showOverlayError();

    postTapState(
      requestId,
      "error",
      getAudioTapErrorDetail(error),
    );
  }
}

function beginActiveTapTeardown(
  tap: AudioTap,
): void {
  if (activeTap !== tap) {
    return;
  }

  if (activeTapLifecycleState !== "closed") {
    activeTapLifecycleState = "stopping";
  }

  refreshSilentInputHint();
}

function clearActiveTap(
  tap: AudioTap,
): void {
  if (activeTap !== tap) {
    return;
  }

  const requestId = tap.getRequestId();
  const currentGrace =
    graceEpisode.getCurrent();

  if (
    currentGrace?.requestId !== requestId
  ) {
    finishPcmSendDropSession(
      requestId,
    );
  }

  activeTapLifecycleState = "closed";
  refreshSilentInputHint();

  activeTap = null;
  activeTapLifecycleState = "missing";
  refreshSilentInputHint();
}

function handleCaptureState(
  state: CaptureState,
  drain = false,
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
      clearExplicitStopDrainState();
      activeCaptureRequestId =
        state.requestId;
      activeTranslationPath = null;
      activeSilentInputShowHint = false;

      captionOverlay?.setTranslationPath(
        null,
      );
      refreshSilentInputHint();
    }
  }

  lastCaptureStatus = state.status;

  switch (state.status) {
    case "starting":
      activeSilentInputShowHint = false;
      cancelOverlayDestroy();
      refreshSilentInputHint(
        ensureOverlay(),
      );
      ensureOverlay().setStatus(
        "loadingModel",
      );
      return;

    case "loadingModel":
      activeSilentInputShowHint = false;
      cancelOverlayDestroy();
      refreshSilentInputHint(
        ensureOverlay(),
      );
      ensureOverlay().setStatus(
        "loadingModel",
        state.progress,
      );
      return;

    case "running":
      cancelOverlayDestroy();
      refreshSilentInputHint(
        ensureOverlay(),
      );
      ensureOverlay().setStatus("running");
      return;

    case "error":
      clearExplicitStopDrainState();
      closeCurrentGraceEpisode(
        "explicit-stop",
      );
      contentSendBuffer.clear();
      finishCurrentPcmSendDropSession();
      activeCaptureRequestId = null;
      activeTranslationPath = null;
      endedAudioTapTarget = null;
      lastEosRequestId = null;
      activeSilentInputShowHint = false;
      contentSessionRequestId = null;
      clearPendingContextTerms();
      resetContentTranslator();
      showOverlayError(state.progress);
      return;

    case "stopping":
      if (
        drain &&
        state.requestId !== undefined
      ) {
        drainingRequestId =
          state.requestId;
        drainReadyRequestId = null;
        drainCompleteSentRequestId = null;
        closeCurrentGraceEpisode(
          "explicit-stop",
        );
        finishCurrentPcmSendDropSession();
        endedAudioTapTarget = null;
        lastEosRequestId = null;
        activeSilentInputShowHint = false;
        clearPendingContextTerms(
          state.requestId,
        );
        cancelOverlayDestroy();
        refreshSilentInputHint();
        return;
      }
      break;

    case "idle":
      break;
  }

  clearExplicitStopDrainState();
  closeCurrentGraceEpisode(
    "explicit-stop",
  );
  contentSendBuffer.clear();
  finishCurrentPcmSendDropSession();
  activeCaptureRequestId = null;
  activeTranslationPath = null;
  endedAudioTapTarget = null;
  lastEosRequestId = null;
  activeSilentInputShowHint = false;
  contentSessionRequestId = null;
  clearPendingContextTerms();
  resetContentTranslator();
  destroyOverlay();
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
    (
      isActivePresentationStatus(
        lastCaptureStatus,
      ) ||
      (
        lastCaptureStatus ===
          "stopping" &&
        drainingRequestId === requestId
      )
    )
  );
}

function handleCaption(
  message: SwCaptionMessage,
): void {
  presentCaptionIfAllowed(
    lastCaptureStatus,
    drainingRequestId,
    () => {
      cancelOverlayDestroy();
      ensureOverlay().showCaption(message);
    },
  );
}

function handleDrainReady(
  message: OffDrainReadyMessage,
): void {
  if (
    !isDrainingRequest(
      message.requestId,
    ) ||
    (
      contentSessionRequestId !==
        message.requestId &&
      activeCaptureRequestId !==
        message.requestId
    )
  ) {
    return;
  }

  drainReadyRequestId =
    message.requestId;

  if (
    captionOverlay === null ||
    !captionOverlay.hasPendingCaption()
  ) {
    postExplicitStopDrainComplete(
      message.requestId,
    );
  }
}

function postExplicitStopDrainComplete(
  requestId: string,
): void {
  if (
    drainCompleteSentRequestId ===
      requestId
  ) {
    return;
  }

  const message: CsDrainCompleteMessage = {
    t: "CS_DRAIN_COMPLETE",
    requestId,
  };

  if (postContentMessage(message)) {
    drainCompleteSentRequestId =
      requestId;
  }
}

function isDrainingRequest(
  requestId?: string,
): boolean {
  if (requestId === undefined) {
    return drainingRequestId !== null;
  }

  return drainingRequestId === requestId;
}

function clearExplicitStopDrainState():
  void {
  drainingRequestId = null;
  drainReadyRequestId = null;
  drainCompleteSentRequestId = null;
}

function ensureOverlay(): CaptionOverlay {
  if (captionOverlay !== null) {
    syncOverlayPlaybackGate(
      captionOverlay,
    );
    return captionOverlay;
  }

  const overlay = new CaptionOverlay({
    getTargetVideo: () =>
      getCurrentAudioTapTarget() ??
      endedAudioTapTarget,
    showOriginal: activeShowOriginal,
    onCaptionFadeOut() {
      if (
        drainReadyRequestId !== null &&
        drainReadyRequestId ===
          drainingRequestId
      ) {
        postExplicitStopDrainComplete(
          drainReadyRequestId,
        );
        return;
      }

      if (isDrainingRequest()) {
        return;
      }

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
  refreshSilentInputHint(overlay);
  syncOverlayPlaybackGate(overlay);
  return overlay;
}

function refreshSilentInputHint(
  overlay: CaptionOverlay | null =
    captionOverlay,
): void {
  if (overlay === null) {
    return;
  }

  overlay.setSilentInputHint(
    resolveCurrentSilentInputHint(),
  );
}

function resolveCurrentSilentInputHint():
  | SilentInputHintVariant
  | null {
  return resolveSilentInputHint({
    showHint:
      lastCaptureStatus === "running" &&
      activeSilentInputShowHint,
    visible:
      document.visibilityState ===
      "visible",
    tap: getSilentHintTapState(),
    video: getSilentHintVideoState(),
  });
}

function getSilentHintTapState():
  SilentHintTapState {
  const tap = activeTap;
  const expectedRequestId =
    contentSessionRequestId ??
    activeCaptureRequestId;

  if (
    tap === null ||
    expectedRequestId === null ||
    tap.getRequestId() !==
      expectedRequestId
  ) {
    return "missing";
  }

  if (
    activeTapLifecycleState ===
      "starting" ||
    activeTapLifecycleState ===
      "stopping" ||
    activeTapLifecycleState ===
      "closed"
  ) {
    return activeTapLifecycleState;
  }

  return tap.isSuspended()
    ? "suspended"
    : "running";
}

function getSilentHintVideoState():
  SilentHintVideoState {
  const video =
    getCurrentAudioTapTarget() ??
    endedAudioTapTarget;

  if (
    video === null ||
    !video.isConnected
  ) {
    return "missing";
  }

  if (video.ended) {
    return "ended";
  }

  if (video.paused) {
    return "paused";
  }

  return "playing";
}

function showOverlayError(
  progress?: number,
): void {
  lastCaptureStatus = "error";
  activeSilentInputShowHint = false;
  cancelOverlayDestroy();
  clearTargetPlaybackFreeze();

  const overlay = ensureOverlay();
  overlay.clear();
  overlay.setTranslationPath(null);
  refreshSilentInputHint(overlay);
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

function postEndOfStream(
  requestId: string,
): void {
  if (lastEosRequestId === requestId) {
    return;
  }

  lastEosRequestId = requestId;

  const message: CsEosMessage = {
    t: "CS_EOS",
    requestId,
  };

  postContentMessage(message);
}

function postTapState(
  requestId: string,
  state: CsTapStateMessage["state"],
  detail?: string,
): boolean {
  const message: CsTapStateMessage = {
    t: "CS_TAP_STATE",
    requestId,
    state,
    ...(detail === undefined
      ? {}
      : { detail }),
  };

  return postContentMessage(message);
}

function beginPcmSendDropSession(
  requestId: string,
): void {
  if (
    pcmSendDropRequestId === requestId
  ) {
    return;
  }

  finishCurrentPcmSendDropSession();

  pcmSendDropRequestId = requestId;
  pcmSendDropBufferOverflowCount = 0;
  lastPcmSendDropWarnAt = null;
}

function recordPcmSendDrop(
  requestId: string,
  reason: "buffer-overflow",
): void {
  if (
    pcmSendDropRequestId !== requestId
  ) {
    return;
  }

  if (reason === "buffer-overflow") {
    pcmSendDropBufferOverflowCount += 1;
  }

  const now = Date.now();

  if (
    lastPcmSendDropWarnAt !== null &&
    now - lastPcmSendDropWarnAt <
      PCM_SEND_DROP_WARN_INTERVAL_MS
  ) {
    return;
  }

  emitPcmSendDropSummary();
  lastPcmSendDropWarnAt = now;
}

function emitPcmSendDropSummary(): void {
  console.warn(
    "[cs] pcm sends dropped since tap start",
    {
      bufferOverflow:
        pcmSendDropBufferOverflowCount,
    },
  );
}

function finishPcmSendDropSession(
  requestId: string,
): void {
  if (
    pcmSendDropRequestId !== requestId
  ) {
    return;
  }

  finishCurrentPcmSendDropSession();
}

function finishCurrentPcmSendDropSession():
  void {
  if (pcmSendDropRequestId === null) {
    return;
  }

  if (
    pcmSendDropBufferOverflowCount !== 0
  ) {
    emitPcmSendDropSummary();
  }

  pcmSendDropRequestId = null;
  pcmSendDropBufferOverflowCount = 0;
  lastPcmSendDropWarnAt = null;
}

function postContentMessage(
  message: OutboundContentMessage,
): boolean {
  if (
    isBufferedContentMessage(message) &&
    (
      backgroundPort === null ||
      graceEpisode.getCurrent() !== null ||
      contentSendBuffer.pendingCount > 0 ||
      contentSendBuffer.isFlushing
    )
  ) {
    enqueueBufferedContentMessage(message);

    if (
      backgroundPort !== null &&
      graceEpisode.getCurrent() === null &&
      !contentSendBuffer.isFlushing
    ) {
      flushBufferedContentMessages();
    }

    return false;
  }

  const port = backgroundPort;

  if (port === null) {
    return false;
  }

  try {
    port.postMessage(message);
    return true;
  } catch (error) {
    if (isBufferedContentMessage(message)) {
      enqueueBufferedContentMessage(
        message,
      );
      return false;
    }

    console.warn(
      "[cs]",
      "could not post content-port message",
      error,
    );
    return false;
  }
}

function isBufferedContentMessage(
  message: OutboundContentMessage,
): message is BufferedContentMessage {
  return (
    message.t === "CS_PCM" ||
    message.t === "CS_EOS" ||
    message.t === "CS_TRANSLATE_RESULT"
  );
}

function enqueueBufferedContentMessage(
  message: BufferedContentMessage,
): void {
  const result =
    contentSendBuffer.enqueue(message);

  if (result.dropped !== null) {
    recordPcmSendDrop(
      result.dropped.payload.requestId,
      "buffer-overflow",
    );
  }
}

function flushBufferedContentMessages():
  void {
  if (contentSendBuffer.isFlushing) {
    return;
  }

  while (
    backgroundPort !== null &&
    graceEpisode.getCurrent() === null
  ) {
    const batch =
      contentSendBuffer.beginFlush();

    if (batch === null) {
      return;
    }

    let completed = true;

    try {
      for (const item of batch) {
        const port = backgroundPort;

        if (port === null) {
          completed = false;
          break;
        }

        try {
          port.postMessage(item.payload);
        } catch {
          completed = false;
          break;
        }

        if (
          !contentSendBuffer.markSent(
            item,
          )
        ) {
          completed = false;
          break;
        }
      }
    } finally {
      contentSendBuffer.endFlush();
    }

    if (!completed) {
      return;
    }
  }
}

const RUN_LEADING_ARTICLES: ReadonlySet<string> =
  new Set(["the", "a", "an"]);

export function extractPostContextTerms(): string[] {
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
        .trim()
        .replace(/\.+$/u, "");
      const termLength =
        Array.from(term).length;

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

  for (const article of articles) {
    const normalizedText = (
      article.innerText ||
      article.textContent ||
      ""
    )
      .normalize("NFKC")
      .replace(/\s+/gu, " ");
    // A period right after a capital is
    // treated as an abbreviation dot
    // (U.S. Space Force), not a sentence
    // end; the cost is that an acronym
    // ending a sentence can bridge into
    // the next one.
    const runs = normalizedText
      .split(/(?<![A-Z])[.!?。！？](?:\s|$)/u)
      .flatMap(
        (sentence) =>
          sentence.match(
            /(?<![@\p{L}\p{M}\p{N}'’._-])\p{Lu}[\p{L}\p{M}\p{N}'’._-]+(?: \p{Lu}[\p{L}\p{M}\p{N}'’._-]+)+/gu,
          ) ?? [],
      );

    for (const run of runs) {
      const words = run.split(" ");

      while (
        words.length > 0 &&
        RUN_LEADING_ARTICLES.has(
          (words[0] ?? "")
            .toLocaleLowerCase("en-US"),
        )
      ) {
        words.shift();
      }

      const term = words
        .slice(0, 4)
        .map((word) =>
          /^(?:\p{Lu}\.)+$/u.test(word)
            ? word
            : word.replace(/\.+$/u, ""),
        )
        .join(" ");

      if (
        !term.includes(" ")
      ) {
        continue;
      }
      const termLength =
        Array.from(term).length;

      if (
        termLength < 4 ||
        termLength > 128
      ) {
        continue;
      }

      const key = term
        .toLocaleLowerCase("en-US");

      if (
        key === "" ||
        seen.has(key) ||
        CONTEXT_TERM_STOPLIST.has(key)
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

async function probeTranslator():
  Promise<TranslatorProbeResult> {
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
