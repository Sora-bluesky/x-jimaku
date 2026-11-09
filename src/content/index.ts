import {
  isMessageOfType,
  MAX_CONTEXT_TERMS,
  type CsDevSetSettingsMessage,
  type CsDevToggleMessage,
  type CsDrainCompleteMessage,
  type CsEosMessage,
  type CsMediaChangedMessage,
  type CsPcmMessage,
  type CsPongMessage,
  type CsTapStateMessage,
  type M1Message,
  type OffDevLogMessage,
  type OffDrainReadyMessage,
  type SwCaptionMessage,
  type TranslationPath,
} from "../shared/messages";
import {
  DEFAULT_SETTINGS,
} from "../shared/settings";
import {
  createCaptionDisplayLog,
} from "../shared/caption-display-log";
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
import { readCueDwellPolicy, type CueDwellPolicy } from "./cue-dwell";
import {
  OrderedSendBuffer,
} from "./send-buffer";
import {
  resolveSilentInputHint,
  type SilentHintTapState,
  type SilentHintVideoState,
  type SilentInputHintVariant,
} from "./silent-hint";

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
  | CsEosMessage;

type OutboundContentMessage =
  | BufferedContentMessage
  | CsDrainCompleteMessage
  | CsMediaChangedMessage
  | CsTapStateMessage;

const CONTENT_PORT_NAME = "content";
const DEV_ORIGIN =
  "http://127.0.0.1:8123";
const INITIAL_RECONNECT_DELAY_MS = 100;
const MAX_RECONNECT_DELAY_MS = 1_000;
const PCM_SEND_DROP_WARN_INTERVAL_MS =
  5_000;
const ERROR_CHIP_VISIBLE_MS = 2_500;
const contentManifest =
  chrome.runtime.getManifest();
const CONTENT_INSTANCE_VERSION =
  contentManifest.version_name ??
  `${contentManifest.version} version_name-missing`;

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
let activeShowTentative =
  DEFAULT_SETTINGS.showTentative;
const captionDisplayLog =
  createCaptionDisplayLog();
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

  chrome.runtime.onMessage.addListener(
    (
      message: unknown,
      _sender,
      sendResponse: (
        response: CsPongMessage,
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
      return false;
    },
  );
}

let devCueDwellPolicy: CueDwellPolicy | undefined;

export function handleDevMessage(
  event: MessageEvent<unknown>,
): void {
  if (
    location.origin !== DEV_ORIGIN ||
    event.origin !== DEV_ORIGIN ||
    event.source !== window
  ) {
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
    const { devCueDwell, ...settings } = event.data.settings;
    const policy = readCueDwellPolicy(devCueDwell);
    if (policy !== null) {
      devCueDwellPolicy = policy;
      captionOverlay?.setDwellPolicy(policy);
    }
    const message: CsDevSetSettingsMessage = {
      t: "CS_DEV_SET_SETTINGS",
      settings,
    };

    void chrome.runtime.sendMessage(message);
  }
}

export function handleOffscreenDevLog(
  message: OffDevLogMessage,
): void {
  if (location.origin !== DEV_ORIGIN) {
    return;
  }

  window.postMessage(
    {
      ...message,
      timestampMs: performance.now(),
    },
    DEV_ORIGIN,
  );

  const details =
    message.data === undefined
      ? []
      : [message.data];

  if (message.level === "info") {
    console.info(
      "[x-jimaku-dev]",
      `[${message.tag}]`,
      message.message,
      ...details,
    );
    return;
  }

  if (message.level === "warn") {
    console.warn(
      "[x-jimaku-dev]",
      `[${message.tag}]`,
      message.message,
      ...details,
    );
    return;
  }

  console.error(
    "[x-jimaku-dev]",
    `[${message.tag}]`,
    message.message,
    ...details,
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
  document.addEventListener(
    "seeked",
    handleTargetPlaybackEvent,
    true,
  );
  document.addEventListener(
    "loadstart",
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

  if (
    event.type === "seeked" ||
    event.type === "loadstart"
  ) {
    postMediaChanged();
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
            "OFF_DEV_LOG",
          )
        ) {
          handleOffscreenDevLog(message);
          return;
        }

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

          if (location.origin === DEV_ORIGIN) {
            window.postMessage(
              {
                ...message,
                timestampMs:
                  performance.now(),
              },
              DEV_ORIGIN,
            );
          }

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
      activeShowTentative =
        DEFAULT_SETTINGS.showTentative;
      contentSessionRequestId = null;
      clearExplicitStopDrainState();
      clearPendingContextTerms();
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
  activeShowTentative =
    DEFAULT_SETTINGS.showTentative;
  contentSessionRequestId = null;
  clearExplicitStopDrainState();
  clearPendingContextTerms();
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
      activeShowTentative =
        message.settings?.showTentative ??
        DEFAULT_SETTINGS.showTentative;
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
      activeShowTentative =
        message.settings?.showTentative ??
        DEFAULT_SETTINGS.showTentative;
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
  activeShowTentative =
    message.settings?.showTentative ??
    DEFAULT_SETTINGS.showTentative;

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
  activeShowTentative =
    message.settings?.showTentative ??
    DEFAULT_SETTINGS.showTentative;
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

      postMediaChanged(requestId);
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

export function handleCaptureState(
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
        captionOverlay?.beginDrain();
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
    captionOverlay?.endDrain();
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
  captionOverlay?.endDrain();
  drainingRequestId = null;
  drainReadyRequestId = null;
  drainCompleteSentRequestId = null;
}

export function ensureOverlay(): CaptionOverlay {
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
    buildStamp: CONTENT_INSTANCE_VERSION,
    showOriginal: activeShowOriginal,
    showTentative: activeShowTentative,
    displayLog: captionDisplayLog,
    dwellPolicy: location.origin === DEV_ORIGIN ? devCueDwellPolicy : undefined,
    onCaptionFadeOut() {
      if (
        drainReadyRequestId !== null &&
        drainReadyRequestId ===
          drainingRequestId &&
        !overlay.hasPendingCaption()
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

  if (drainingRequestId !== null) {
    overlay.beginDrain();
  }

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

function postMediaChanged(
  requestId: string | null =
    activeTap?.getRequestId() ??
    contentSessionRequestId,
): void {
  if (requestId === null) {
    return;
  }

  const message: CsMediaChangedMessage = {
    t: "CS_MEDIA_CHANGED",
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
    message.t === "CS_EOS"
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

const TITLE_ABBREVIATIONS: ReadonlySet<string> =
  new Set([
    "st", "mt", "dr", "mr",
    "mrs", "ms", "jr", "sr",
  ]);

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
      const normalizedMatch = match
        .normalize("NFKC")
        .trim();
      const term = /^(?:\p{Lu}\.)+$/u.test(
        normalizedMatch,
      )
        ? normalizedMatch
        : normalizedMatch.replace(
            /\.+$/u,
            "",
          );
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
    // A period right after a capital or a
    // common title abbreviation is treated
    // as an abbreviation dot (U.S. Space
    // Force, St. Louis), not a sentence
    // end. Only a SINGLE capital before
    // the dot counts (U.S. yes, NASA. no,
    // so a sentence-final acronym still
    // splits). A sentence ending in a
    // one-letter name (Malcolm X.) is the
    // accepted false join of this rule:
    // one regex cannot tell it apart from
    // a dotted acronym without breaking
    // U.S., and the cost is bounded to a
    // single noisy four-word hint. The abbreviation set is a
    // small closed list on purpose: this
    // feeds a hint list for the
    // translation prompt, so a missed
    // exotic abbreviation only costs one
    // hint, and a full lexicon is not
    // worth the false joins it would
    // cause.
    const runs = normalizedText
      .split(
        /(?<!\b(?:St|Mt|Dr|Mr|Mrs|Ms|Jr|Sr)|\b[A-Z])[.!?。！？](?:\s|$)/u,
      )
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
        .map((word) => {
          const stripped = word.replace(
            /\.+$/u,
            "",
          );

          if (
            /^(?:\p{Lu}\.)+$/u.test(word) ||
            TITLE_ABBREVIATIONS.has(
              stripped.toLocaleLowerCase(
                "en-US",
              ),
            )
          ) {
            return word;
          }

          return stripped;
        })
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
