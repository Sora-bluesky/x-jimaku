import {
  LAST_PROBE_STORAGE_KEY,
  createProbeRequestId,
  isContentPortMessage,
  isMessageOfType,
  isM1Message,
  isProbeSnapshot,
  isSettings,
  nowIso,
  toProbeError,
  type ContentScriptProbeResultMessage,
  type CsEosMessage,
  type CsPcmMessage,
  type CsPingMessage,
  type CsPongMessage,
  type CsStartTapMessage,
  type CsStopTapMessage,
  type CsTapStateMessage,
  type CsTranslateMessage,
  type CsTranslateResultMessage,
  type DiagnosticsResultMessage,
  type M1Message,
  type OffDiagnosticMessage,
  type OffLevelMessage,
  type OffQueryMessage,
  type OffRecognitionMessage,
  type OffStartMessage,
  type OffStateMessage,
  type OffStatusMessage,
  type OffStopMessage,
  type OffTranslationStateMessage,
  type OffscreenProbeResultMessage,
  type OptionsPageProbeResultMessage,
  type ProbeFailureMessage,
  type ProbeRequest,
  type ProbeSnapshot,
  type SwCaptionClearMessage,
  type SwCaptionMessage,
  type SwRecognitionMessage,
  type SwSilentInputMessage,
  type SwTranslationStateMessage,
} from "../shared/messages";
import {
  readSettings,
  writeSettings,
  type Settings,
} from "../shared/settings";
import {
  CAPTURE_STATE_STORAGE_KEY,
  createCaptureState,
  isCaptureState,
  transitionCaptureState,
  type CaptureState,
  type CaptureStateDetails,
  type CaptureStateError,
  type CaptureStatus,
} from "../shared/state";

const OFFSCREEN_DOCUMENT_PATH =
  "offscreen.html";
const CONTENT_SCRIPT_PATH = "content.js";
const DEV_ORIGIN =
  "http://127.0.0.1:8123";
const OFFSCREEN_PORT_NAME = "offscreen";
const CONTENT_PORT_NAME = "content";
const OPTIONS_PORT_NAME = "options";
const CAPTURE_SESSION_STORAGE_KEY =
  "capture.session" as const;
const LAST_UNHANDLED_ERROR_STORAGE_KEY =
  "lastUnhandledError" as const;
const PORT_WAIT_MS = 2_000;
const TRANSIENT_ERROR_MS = 2_500;
const MAX_RECOGNITION_LINES = 50;
const SILENT_INPUT_RMS_THRESHOLD = 0.001;
const SILENT_INPUT_HINT_DELAY_MS = 10_000;
const LAST_UNHANDLED_ERROR_STACK_LIMIT =
  500;
const PCM_RELAY_DROP_WARNING_INTERVAL_MS =
  5_000;

type SnapshotPatch = Partial<
  Omit<ProbeSnapshot, "updatedAt">
>;

interface PortWaiter {
  resolve(port: chrome.runtime.Port): void;
  reject(error: Error): void;
  timerId: number;
}

interface OffscreenStatusWaiter {
  port: chrome.runtime.Port;
  resolve(message: OffStatusMessage): void;
  reject(error: Error): void;
  timerId: number;
}

interface PersistedCaptureSession {
  requestId: string;
  tabId: number;
  settings: Settings;
}

interface LastUnhandledErrorRecord {
  at: string;
  context: "background" | "offscreen";
  message: string;
  stack?: string;
}

interface PcmRelayDropCounts {
  captureStateMismatch: number;
  offscreenPortMissing: number;
  postMessageException: number;
}

type PcmRelayDropReason =
  keyof PcmRelayDropCounts;

const optionsPorts =
  new Set<chrome.runtime.Port>();
const contentPorts =
  new Map<number, chrome.runtime.Port>();
const contentPortWaiters =
  new Map<number, PortWaiter[]>();
const contentInjectionOperations =
  new Map<number, Promise<void>>();
const offscreenPortWaiters: PortWaiter[] =
  [];
const offscreenStatusWaiters =
  new Map<string, OffscreenStatusWaiter>();
const expectedOffscreenDisconnectPorts =
  new WeakSet<chrome.runtime.Port>();
const expectedContentDisconnectPorts =
  new WeakSet<chrome.runtime.Port>();
const recognitionLines =
  new Map<number, SwRecognitionMessage>();
const pcmRelayDropCounts:
  PcmRelayDropCounts = {
    captureStateMismatch: 0,
    offscreenPortMissing: 0,
    postMessageException: 0,
  };

let offscreenPort:
  | chrome.runtime.Port
  | null = null;
let offscreenOperationTail: Promise<void> =
  Promise.resolve();
let offscreenBusyCount = 0;
let offscreenCloseRequested = false;
let offscreenCloseOperationQueued = false;
let offscreenCloseReason = "capture-ended";
let offscreenCloseInvocationActive = false;
let captureState =
  createCaptureState("idle");
let captureStateWriteTail: Promise<void> =
  Promise.resolve();
let captureSessionWriteTail: Promise<void> =
  Promise.resolve();
let badgeWriteTail: Promise<void> =
  Promise.resolve();
let storageWriteTail: Promise<void> =
  Promise.resolve();
let latestRms = 0;
let silentInputStartedAtMs:
  | number
  | null = null;
let silentInputRequestId:
  | string
  | null = null;
let silentInputHintActive = false;
let silentInputTimerId:
  | number
  | null = null;
let activeTranslationState:
  | SwTranslationStateMessage
  | null = null;
let localStartRequestId:
  | string
  | null = null;
let offscreenStartRequestId:
  | string
  | null = null;
let contentStartRequestId:
  | string
  | null = null;
let persistedCaptureSession:
  | PersistedCaptureSession
  | null = null;
let recoveryPending = false;
let recoveryOperation:
  | Promise<void>
  | null = null;
let transientErrorTimerId:
  | number
  | null = null;
let offscreenUnhandledErrorRecorded =
  false;
let lastPcmRelayDropWarningAtMs = 0;

self.addEventListener(
  "error",
  (event: ErrorEvent) => {
    try {
      void persistLastUnhandledError({
        at: nowIso(),
        context: "background",
        message:
          event.message.length > 0
            ? event.message
            : toUnhandledErrorMessage(
                event.error,
              ),
        ...toUnhandledErrorStack(
          event.error,
        ),
      });
    } catch {
      return;
    }
  },
);

self.addEventListener(
  "unhandledrejection",
  (event: PromiseRejectionEvent) => {
    try {
      void persistLastUnhandledError({
        at: nowIso(),
        context: "background",
        message:
          toUnhandledErrorMessage(
            event.reason,
          ),
        ...toUnhandledErrorStack(
          event.reason,
        ),
      });
    } catch {
      return;
    }
  },
);

const stateInitialization =
  hydrateCaptureState();

console.log("[bg]", "service worker started");

void stateInitialization.then(() => {
  queueBadgeUpdate(captureState);

  if (recoveryPending) {
    void reconcileRecoveredCapture(
      "service-worker-start",
    );
  }
});

chrome.runtime.onStartup.addListener(() => {
  console.log("[bg]", "runtime startup");

  void stateInitialization.then(() => {
    queueBadgeUpdate(captureState);

    if (recoveryPending) {
      void reconcileRecoveredCapture(
        "runtime-startup",
      );
    }
  });
});

chrome.runtime.onInstalled.addListener(
  (details) => {
    console.log(
      "[bg]",
      "extension installed or updated",
      details.reason,
    );

    void stateInitialization.then(() => {
      queueBadgeUpdate(captureState);
    });
  },
);

chrome.action.onClicked.addListener((tab) => {
  void handleActionClick(tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  contentPorts.delete(tabId);
  rejectContentPortWaiters(
    tabId,
    new Error(
      "The target tab closed before its content port connected",
    ),
  );

  void stateInitialization.then(() => {
    if (
      captureState.tabId === tabId &&
      isCaptureActive(captureState.status)
    ) {
      console.log(
        "[bg]",
        "captured tab closed; stopping capture",
        { tabId },
      );
      requestCaptureStop("tab-closed");
    }
  });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === OFFSCREEN_PORT_NAME) {
    handleOffscreenPortConnected(port);
    return;
  }

  if (port.name === CONTENT_PORT_NAME) {
    handleContentPortConnected(port);
    return;
  }

  if (port.name === OPTIONS_PORT_NAME) {
    handleOptionsPortConnected(port);
  }
});

chrome.runtime.onMessage.addListener(
  (
    message: unknown,
    sender,
    sendResponse: (
      response?: M1Message,
    ) => void,
  ): boolean => {
    if (!isM1Message(message)) {
      console.warn(
        "[bg]",
        "ignored malformed message",
        {
          senderUrl: sender.url,
        },
      );
      return false;
    }

    if (
      message.t === "CS_DEV_TOGGLE" ||
      message.t === "CS_DEV_SET_SETTINGS"
    ) {
      if (
        sender.tab === undefined ||
        getMessageSenderOrigin(sender) !==
          DEV_ORIGIN
      ) {
        console.warn(
          "[bg]",
          "ignored development hook message from untrusted sender",
        );
        return false;
      }

      if (message.t === "CS_DEV_TOGGLE") {
        void handleActionClick(sender.tab);
        return false;
      }

      void updateDevSettings(message.settings)
        .catch((error: unknown) => {
          console.error(
            "[bg]",
            "could not update settings from development hook",
            error,
          );
        });

      return false;
    }

    if (
      isMessageOfType(
        message,
        "RUN_DIAGNOSTICS",
      )
    ) {
      void runDiagnostics(message.requestId)
        .then(sendResponse)
        .catch((error: unknown) => {
          sendResponse(
            createFailure(
              message.requestId,
              "background",
              error,
            ),
          );
        });

      return true;
    }

    if (
      isMessageOfType(
        message,
        "CS_PROBE_RESULT",
      )
    ) {
      void storeContentScriptResult(message)
        .then(sendResponse)
        .catch((error: unknown) => {
          sendResponse(
            createFailure(
              message.requestId,
              "background",
              error,
            ),
          );
        });

      return true;
    }

    if (
      isMessageOfType(
        message,
        "OPTIONS_PROBE_RESULT",
      )
    ) {
      void storeOptionsPageResult(message)
        .then(sendResponse)
        .catch((error: unknown) => {
          sendResponse(
            createFailure(
              message.requestId,
              "background",
              error,
            ),
          );
        });

      return true;
    }

    if (
      isMessageOfType(
        message,
        "GET_LAST_PROBE",
      )
    ) {
      void getLatestSnapshot()
        .then((snapshot) => {
          sendResponse({
            t: "LAST_PROBE_RESULT",
            snapshot,
          });
        })
        .catch((error: unknown) => {
          sendResponse(
            createFailure(
              createProbeRequestId(
                "get-last",
              ),
              "background",
              error,
            ),
          );
        });

      return true;
    }

    return false;
  },
);

function getMessageSenderOrigin(
  sender: chrome.runtime.MessageSender,
): string | null {
  if (typeof sender.origin === "string") {
    return sender.origin;
  }

  if (sender.url === undefined) {
    return null;
  }

  try {
    return new URL(sender.url).origin;
  } catch {
    return null;
  }
}

async function updateDevSettings(
  patch: Record<string, unknown>,
): Promise<void> {
  let settings = await readSettings();

  for (const key of Object.keys(settings)) {
    if (
      !Object.prototype.hasOwnProperty.call(
        patch,
        key,
      )
    ) {
      continue;
    }

    const candidate = {
      ...settings,
      [key]: patch[key],
    };

    if (isSettings(candidate)) {
      settings = candidate;
    }
  }

  await writeSettings(settings);
}

async function handleActionClick(
  tab: chrome.tabs.Tab,
): Promise<void> {
  await stateInitialization;

  if (isCaptureActive(captureState.status)) {
    requestCaptureStop("action-click");
    return;
  }

  if (captureState.status === "stopping") {
    return;
  }

  if (
    tab.id === undefined ||
    (tab.url !== undefined &&
      !isSupportedCaptureUrl(tab.url))
  ) {
    showTransientCaptureError(
      "x.com のタブで使ってください",
    );
    return;
  }

  beginCaptureStart(
    tab.id,
    createProbeRequestId("capture"),
  );
}

async function hydrateCaptureState(): Promise<void> {
  let shouldWriteState = false;
  let shouldCloseInvalidContext = false;

  try {
    const values =
      await chrome.storage.session.get([
        CAPTURE_STATE_STORAGE_KEY,
        CAPTURE_SESSION_STORAGE_KEY,
        LAST_UNHANDLED_ERROR_STORAGE_KEY,
      ]);
    const storedState =
      values[CAPTURE_STATE_STORAGE_KEY];
    const storedSession =
      values[CAPTURE_SESSION_STORAGE_KEY];
    const storedUnhandledError =
      values[
        LAST_UNHANDLED_ERROR_STORAGE_KEY
      ];

    if (storedUnhandledError !== undefined) {
      console.warn(
        "[bg] last unhandled error before this start:",
        storedUnhandledError,
      );

      try {
        await chrome.storage.session.remove(
          LAST_UNHANDLED_ERROR_STORAGE_KEY,
        );
      } catch (error) {
        console.warn(
          "[bg]",
          "could not remove last unhandled error record",
          error,
        );
      }
    }

    captureState = isCaptureState(storedState)
      ? storedState
      : createCaptureState("idle");
    shouldWriteState =
      !isCaptureState(storedState);

    const restoredSession =
      isPersistedCaptureSession(storedSession)
        ? storedSession
        : null;

    if (
      isCaptureActive(captureState.status) ||
      captureState.status === "stopping"
    ) {
      const contexts =
        await getOffscreenContexts();

      if (contexts.length === 0) {
        console.warn(
          "[bg]",
          "discarded persisted capture because the offscreen document is gone",
          {
            status: captureState.status,
            requestId:
              captureState.requestId,
          },
        );

        captureState =
          createCaptureState("idle");
        persistedCaptureSession = null;
        recoveryPending = false;
        shouldWriteState = true;
      } else if (
        isCaptureActive(
          captureState.status,
        )
      ) {
        if (
          restoredSession === null ||
          restoredSession.requestId !==
            captureState.requestId ||
          restoredSession.tabId !==
            captureState.tabId
        ) {
          captureState =
            createCaptureState("error", {
              ...(captureState.requestId ===
              undefined
                ? {}
                : {
                    requestId:
                      captureState.requestId,
                  }),
              ...(captureState.tabId ===
              undefined
                ? {}
                : {
                    tabId:
                      captureState.tabId,
                  }),
              error: {
                name:
                  "CaptureRecoveryError",
                message:
                  "字幕セッションの復旧情報が失われました。もう一度開始してください",
              },
            });
          persistedCaptureSession = null;
          recoveryPending = false;
          shouldWriteState = true;
          shouldCloseInvalidContext = true;
        } else {
          persistedCaptureSession =
            restoredSession;
          recoveryPending = true;
        }
      } else {
        persistedCaptureSession =
          restoredSession;
      }
    } else {
      persistedCaptureSession = null;

      if (storedSession !== undefined) {
        void queueCaptureSessionWrite(null);
      }
    }

    if (shouldWriteState) {
      queueCaptureStateWrite(captureState);
    }

    if (persistedCaptureSession === null) {
      void queueCaptureSessionWrite(null);
    }

    console.log(
      "[bg]",
      "capture state restored",
      {
        state: captureState,
        recoveryPending,
      },
    );
  } catch (error) {
    console.error(
      "[bg]",
      "capture state restore failed",
      error,
    );

    captureState =
      createCaptureState("error", {
        error: toCaptureStateError(error),
      });
    persistedCaptureSession = null;
    recoveryPending = false;
    queueCaptureStateWrite(captureState);
    void queueCaptureSessionWrite(null);
  } finally {
    resetSilentInputTracking();
    queueBadgeUpdate(captureState);
    broadcastCaptureState();

    if (shouldCloseInvalidContext) {
      scheduleOffscreenClose(
        "invalid-persisted-session",
      );
    }
  }
}

function beginCaptureStart(
  tabId: number,
  requestId: string,
): void {
  clearTransientErrorTimer();
  recoveryPending = false;

  if (captureState.status === "error") {
    moveCaptureState("idle");
  }

  if (captureState.status !== "idle") {
    return;
  }

  resetPcmRelayDropCounts();
  offscreenUnhandledErrorRecorded = false;
  recognitionLines.clear();
  activeTranslationState = null;
  latestRms = 0;
  resetSilentInputTracking();
  localStartRequestId = requestId;
  offscreenStartRequestId = null;
  contentStartRequestId = null;
  persistedCaptureSession = null;
  void queueCaptureSessionWrite(null);

  moveCaptureState("starting", {
    requestId,
    tabId,
  });

  broadcastLevel();

  void finishCaptureStart(
    tabId,
    requestId,
  );
}

async function finishCaptureStart(
  tabId: number,
  requestId: string,
): Promise<void> {
  try {
    const settings = await readSettings();

    if (!isCurrentActiveRequest(requestId)) {
      return;
    }

    const session: PersistedCaptureSession = {
      requestId,
      tabId,
      settings,
    };

    persistedCaptureSession = session;
    await queueCaptureSessionWrite(session);

    if (!isCurrentActiveRequest(requestId)) {
      return;
    }

    await assertSupportedCaptureTab(tabId);
    await ensureOffscreenDocument();

    if (!isCurrentActiveRequest(requestId)) {
      return;
    }

    const [offscreen, content] =
      await Promise.all([
        waitForOffscreenPort(PORT_WAIT_MS),
        getOrInjectContentPort(
          tabId,
          PORT_WAIT_MS,
        ),
      ]);

    if (!isCurrentActiveRequest(requestId)) {
      return;
    }

    const contentStart: CsStartTapMessage = {
      t: "CS_START_TAP",
      requestId,
      settings,
    };

    content.postMessage(contentStart);
    contentStartRequestId = requestId;

    if (!isCurrentActiveRequest(requestId)) {
      postStopToContent(
        content,
        requestId,
      );
      return;
    }

    const offStart: OffStartMessage = {
      t: "OFF_START",
      requestId,
      settings,
    };

    offscreen.postMessage(offStart);
    offscreenStartRequestId = requestId;
    localStartRequestId = null;

    console.log(
      "[bg]",
      "offscreen host and content audio tap started",
      {
        requestId,
        tabId,
      },
    );
  } catch (error) {
    if (!isCurrentActiveRequest(requestId)) {
      return;
    }

    console.error(
      "[bg]",
      "capture start failed",
      error,
    );

    stopDeliveredSession(
      tabId,
      requestId,
    );
    clearSessionTracking();

    moveCaptureState("error", {
      requestId,
      tabId,
      error: toCaptureStateError(error),
    });
  }
}

function requestCaptureStop(
  reason: string,
): void {
  if (!isCaptureActive(captureState.status)) {
    return;
  }

  recoveryPending = false;

  const requestId =
    captureState.requestId ??
    createProbeRequestId("capture-stop");
  const tabId = captureState.tabId;
  const startWasNotDelivered =
    captureState.status === "starting" &&
    localStartRequestId === requestId &&
    offscreenStartRequestId !== requestId &&
    contentStartRequestId !== requestId;

  moveCaptureState("stopping", {
    requestId,
    ...(tabId === undefined
      ? {}
      : { tabId }),
  });

  stopDeliveredSession(
    tabId,
    requestId,
  );

  if (startWasNotDelivered) {
    clearSessionTracking();
    latestRms = 0;
    activeTranslationState = null;
    resetSilentInputTracking();
    broadcastLevel();
    moveCaptureState("idle");
    return;
  }

  if (offscreenPort !== null) {
    return;
  }

  void getOffscreenContexts()
    .then((contexts) => {
      if (
        contexts.length === 0 &&
        captureState.status === "stopping" &&
        captureState.requestId === requestId
      ) {
        clearSessionTracking();
        latestRms = 0;
        activeTranslationState = null;
        resetSilentInputTracking();
        broadcastLevel();
        moveCaptureState("idle");
      }
    })
    .catch((error: unknown) => {
      console.error(
        "[bg]",
        "could not inspect offscreen context while stopping",
        error,
      );
    });

  console.log("[bg]", "capture stop requested", {
    requestId,
    reason,
  });
}

function stopDeliveredSession(
  tabId: number | undefined,
  requestId: string,
): void {
  if (tabId !== undefined) {
    const content = contentPorts.get(tabId);

    if (content !== undefined) {
      postStopToContent(
        content,
        requestId,
      );
    }
  }

  if (offscreenPort !== null) {
    postStopToOffscreen(
      offscreenPort,
      requestId,
    );
  }
}

function handleContentPortConnected(
  port: chrome.runtime.Port,
): void {
  const tabId = port.sender?.tab?.id;
  const senderUrl =
    port.sender?.url ??
    port.sender?.tab?.url;

  if (
    tabId === undefined ||
    !isSupportedCaptureUrl(senderUrl)
  ) {
    console.warn(
      "[bg]",
      "rejected content port from unexpected sender",
      {
        tabId,
        senderUrl,
      },
    );
    port.disconnect();
    return;
  }

  const previous = contentPorts.get(tabId);

  if (
    previous !== undefined &&
    previous !== port
  ) {
    expectedContentDisconnectPorts.add(
      previous,
    );
    previous.disconnect();
  }

  contentPorts.set(tabId, port);
  resolveContentPortWaiters(tabId, port);

  port.onMessage.addListener(
    (message: unknown) => {
      if (!isContentPortMessage(message)) {
        console.warn(
          "[bg]",
          "ignored malformed content-port message",
          message,
        );
        return;
      }

      if (
        isMessageOfType(message, "CS_PCM")
      ) {
        relayContentPcm(
          tabId,
          message,
        );
        return;
      }

      if (
        isMessageOfType(message, "CS_EOS")
      ) {
        relayContentEndOfStream(
          tabId,
          message,
        );
        return;
      }

      if (
        isMessageOfType(
          message,
          "CS_TRANSLATE_RESULT",
        )
      ) {
        relayContentTranslationResult(
          tabId,
          message,
        );
        return;
      }

      if (
        isMessageOfType(
          message,
          "CS_TAP_STATE",
        )
      ) {
        void stateInitialization.then(() => {
          handleContentTapState(
            tabId,
            message,
          );
        });
        return;
      }

      console.warn(
        "[bg]",
        "ignored content-originated control message",
        message.t,
      );
    },
  );

  port.onDisconnect.addListener(() => {
    if (contentPorts.get(tabId) === port) {
      contentPorts.delete(tabId);
    }

    const disconnectError =
      chrome.runtime.lastError?.message;

    if (
      expectedContentDisconnectPorts.has(port)
    ) {
      return;
    }

    console.warn(
      "[bg]",
      "content port disconnected",
      {
        tabId,
        detail: disconnectError ?? "",
      },
    );

    void stateInitialization.then(() => {
      if (
        captureState.tabId === tabId &&
        isCaptureActive(
          captureState.status,
        )
      ) {
        requestCaptureStop(
          "content-port-disconnected",
        );
      }
    });
  });

  void stateInitialization.then(() => {
    if (
      captureState.tabId !== tabId ||
      contentPorts.get(tabId) !== port
    ) {
      return;
    }

    postCaptureState(port);

    if (
      activeTranslationState !== null &&
      activeTranslationState.requestId ===
        captureState.requestId
    ) {
      postTranslationState(
        port,
        activeTranslationState,
      );
    }

    if (
      captureState.status === "running" &&
      captureState.requestId !== undefined
    ) {
      postSilentInputState(port, {
        t: "SW_SILENT_INPUT",
        requestId: captureState.requestId,
        showHint: silentInputHintActive,
      });
    }

    if (
      shouldClearCaptionForStatus(
        captureState.status,
      )
    ) {
      postCaptionClear(port);
    }

    if (
      captureState.status === "stopping" &&
      captureState.requestId !== undefined
    ) {
      postStopToContent(
        port,
        captureState.requestId,
      );
      return;
    }

    if (
      recoveryPending &&
      isCaptureActive(captureState.status)
    ) {
      void reconcileRecoveredCapture(
        "content-port-reconnected",
      );
    }
  });
}

function relayContentPcm(
  tabId: number,
  message: CsPcmMessage,
): void {
  if (
    captureState.tabId !== tabId ||
    captureState.requestId !==
      message.requestId ||
    !isCaptureActive(captureState.status)
  ) {
    if (
      captureState.status !== "stopping" &&
      captureState.status !== "idle" &&
      captureState.status !== "error"
    ) {
      incrementPcmRelayDrop(
        "captureStateMismatch",
      );
    }

    return;
  }

  const port = offscreenPort;

  if (port === null) {
    incrementPcmRelayDrop(
      "offscreenPortMissing",
    );
    return;
  }

  try {
    port.postMessage(message);
  } catch {
    incrementPcmRelayDrop(
      "postMessageException",
    );
  }
}

function incrementPcmRelayDrop(
  reason: PcmRelayDropReason,
): void {
  pcmRelayDropCounts[reason] += 1;

  const currentTimeMs = Date.now();

  if (
    currentTimeMs -
      lastPcmRelayDropWarningAtMs <
    PCM_RELAY_DROP_WARNING_INTERVAL_MS
  ) {
    return;
  }

  lastPcmRelayDropWarningAtMs =
    currentTimeMs;
  logPcmRelayDropCounts();
}

function logPcmRelayDropCounts(): void {
  console.warn(
    "[bg] pcm relay drops since capture start",
    {
      ...pcmRelayDropCounts,
    },
  );
}

function flushPcmRelayDropCounts(): void {
  if (hasPcmRelayDrops()) {
    logPcmRelayDropCounts();
  }

  resetPcmRelayDropCounts();
}

function hasPcmRelayDrops(): boolean {
  return (
    pcmRelayDropCounts
      .captureStateMismatch > 0 ||
    pcmRelayDropCounts
      .offscreenPortMissing > 0 ||
    pcmRelayDropCounts
      .postMessageException > 0
  );
}

function resetPcmRelayDropCounts(): void {
  pcmRelayDropCounts
    .captureStateMismatch = 0;
  pcmRelayDropCounts
    .offscreenPortMissing = 0;
  pcmRelayDropCounts
    .postMessageException = 0;
  lastPcmRelayDropWarningAtMs = 0;
}

function relayContentEndOfStream(
  tabId: number,
  message: CsEosMessage,
): void {
  if (
    captureState.tabId !== tabId ||
    captureState.requestId !==
      message.requestId ||
    !isCaptureActive(captureState.status)
  ) {
    return;
  }

  const port = offscreenPort;

  if (port === null) {
    return;
  }

  try {
    port.postMessage(message);
  } catch (error) {
    console.warn(
      "[bg]",
      "could not relay end-of-stream to offscreen",
      error,
    );
  }
}

function relayContentTranslationResult(
  tabId: number,
  message: CsTranslateResultMessage,
): void {
  if (
    captureState.tabId !== tabId ||
    captureState.requestId !==
      message.requestId ||
    !isCaptureActive(captureState.status)
  ) {
    return;
  }

  const port = offscreenPort;

  if (port === null) {
    return;
  }

  try {
    port.postMessage(message);
  } catch (error) {
    console.warn(
      "[bg]",
      "could not relay content translation result to offscreen",
      error,
    );
  }
}

function handleContentTapState(
  tabId: number,
  message: CsTapStateMessage,
): void {
  broadcastTapState(message);

  if (
    captureState.tabId !== tabId ||
    captureState.requestId !==
      message.requestId
  ) {
    return;
  }

  if (message.state === "tapping") {
    return;
  }

  if (message.state === "stopped") {
    if (isCaptureActive(captureState.status)) {
      requestCaptureStop(
        message.detail ??
        "content-tap-stopped",
      );
    }
    return;
  }

  if (
    message.state === "error" &&
    isCaptureActive(captureState.status)
  ) {
    const requestId = message.requestId;

    stopDeliveredSession(
      captureState.tabId,
      requestId,
    );
    clearSessionTracking();
    latestRms = 0;
    activeTranslationState = null;
    resetSilentInputTracking();
    broadcastLevel();

    moveCaptureState("error", {
      requestId,
      tabId,
      error: {
        name: "AudioTapError",
        message:
          message.detail ??
          "Content audio tap failed",
      },
    });
  }
}

function handleOffscreenPortConnected(
  port: chrome.runtime.Port,
): void {
  const expectedUrl = chrome.runtime.getURL(
    OFFSCREEN_DOCUMENT_PATH,
  );

  if (
    port.sender?.url !== undefined &&
    port.sender.url !== expectedUrl
  ) {
    console.warn(
      "[bg]",
      "rejected offscreen-named port from unexpected sender",
      { senderUrl: port.sender.url },
    );
    port.disconnect();
    return;
  }

  if (
    offscreenPort !== null &&
    offscreenPort !== port
  ) {
    expectedOffscreenDisconnectPorts.add(
      offscreenPort,
    );
    rejectOffscreenStatusWaitersForPort(
      offscreenPort,
      new Error(
        "Offscreen port was superseded",
      ),
    );
    offscreenPort.disconnect();
  }

  offscreenPort = port;

  if (offscreenCloseInvocationActive) {
    expectedOffscreenDisconnectPorts.add(port);
  }

  resolveOffscreenPortWaiters(port);

  port.onMessage.addListener(
    (message: unknown) => {
      if (
        isMessageOfType(
          message,
          "OFF_DIAGNOSTIC",
        )
      ) {
        handleOffscreenDiagnostic(message);
        return;
      }

      if (
        isMessageOfType(
          message,
          "OFF_STATUS",
        )
      ) {
        resolveOffscreenStatusWaiter(
          port,
          message,
        );
        return;
      }

      if (
        isMessageOfType(
          message,
          "OFF_STATE",
        )
      ) {
        void stateInitialization.then(() => {
          handleOffscreenState(message);
        });
        return;
      }

      if (
        isMessageOfType(
          message,
          "OFF_LEVEL",
        )
      ) {
        if (offscreenPort === port) {
          handleOffscreenLevel(message);
        }
        return;
      }

      if (
        isMessageOfType(
          message,
          "OFF_RECOG",
        )
      ) {
        handleOffscreenRecognition(message);
        return;
      }

      if (
        isMessageOfType(
          message,
          "OFF_TRANSLATION_STATE",
        )
      ) {
        handleOffscreenTranslationState(
          message,
        );
        return;
      }

      if (
        isMessageOfType(
          message,
          "CS_TRANSLATE",
        )
      ) {
        relayOffscreenTranslationRequest(
          message,
        );
        return;
      }

      console.warn(
        "[bg]",
        "ignored malformed offscreen port message",
        message,
      );
    },
  );

  port.onDisconnect.addListener(() => {
    if (offscreenPort === port) {
      offscreenPort = null;
    }

    rejectOffscreenStatusWaitersForPort(
      port,
      new Error(
        "Offscreen port disconnected",
      ),
    );

    const disconnectError =
      chrome.runtime.lastError?.message;

    if (
      expectedOffscreenDisconnectPorts.has(port)
    ) {
      return;
    }

    console.warn(
      "[bg]",
      "offscreen port disconnected unexpectedly",
      disconnectError ?? "",
    );

    void stateInitialization.then(() =>
      inspectUnexpectedOffscreenDisconnect(
        port,
      ),
    );
  });

  void stateInitialization.then(() => {
    if (
      captureState.status === "stopping" &&
      captureState.requestId !== undefined &&
      offscreenPort === port
    ) {
      postStopToOffscreen(
        port,
        captureState.requestId,
      );
      return;
    }

    if (
      recoveryPending &&
      isCaptureActive(captureState.status) &&
      offscreenPort === port
    ) {
      void reconcileRecoveredCapture(
        "offscreen-port-reconnected",
      );
    }
  });
}

function handleOffscreenDiagnostic(
  message: OffDiagnosticMessage,
): void {
  offscreenUnhandledErrorRecorded = true;

  void persistLastUnhandledError({
    at: message.at,
    context: "offscreen",
    message: message.message,
    ...(message.stack === undefined
      ? {}
      : {
          stack: message.stack.slice(
            0,
            LAST_UNHANDLED_ERROR_STACK_LIMIT,
          ),
        }),
  });
}

function handleOffscreenLevel(
  message: OffLevelMessage,
): void {
  latestRms = message.rms;
  broadcastLevel();

  if (
    captureState.status !== "running" ||
    captureState.requestId === undefined
  ) {
    resetSilentInputTracking();
    return;
  }

  if (
    message.rms >=
    SILENT_INPUT_RMS_THRESHOLD
  ) {
    resetSilentInputTracking();
    return;
  }

  beginSilentInputTracking(
    captureState.requestId,
  );
}

function beginSilentInputTracking(
  requestId: string,
): void {
  if (
    silentInputRequestId === requestId &&
    silentInputStartedAtMs !== null
  ) {
    return;
  }

  clearSilentInputTimer();
  silentInputRequestId = requestId;
  silentInputStartedAtMs = Date.now();
  setSilentInputHint(false);
  scheduleSilentInputTimer(
    requestId,
    silentInputStartedAtMs,
  );
}

function scheduleSilentInputTimer(
  requestId: string,
  startedAtMs: number,
): void {
  clearSilentInputTimer();

  const elapsed =
    Date.now() - startedAtMs;
  const remaining = Math.max(
    0,
    SILENT_INPUT_HINT_DELAY_MS - elapsed,
  );

  silentInputTimerId =
    self.setTimeout(() => {
      silentInputTimerId = null;

      if (
        captureState.status !== "running" ||
        captureState.requestId !==
          requestId ||
        silentInputRequestId !==
          requestId ||
        silentInputStartedAtMs !==
          startedAtMs ||
        latestRms >=
          SILENT_INPUT_RMS_THRESHOLD
      ) {
        return;
      }

      const currentElapsed =
        Date.now() - startedAtMs;

      if (
        currentElapsed <
        SILENT_INPUT_HINT_DELAY_MS
      ) {
        scheduleSilentInputTimer(
          requestId,
          startedAtMs,
        );
        return;
      }

      setSilentInputHint(true);
    }, remaining);
}

function resetSilentInputTracking(): void {
  clearSilentInputTimer();
  silentInputStartedAtMs = null;
  silentInputRequestId = null;
  setSilentInputHint(false);
}

function clearSilentInputTimer(): void {
  if (silentInputTimerId === null) {
    return;
  }

  globalThis.clearTimeout(
    silentInputTimerId,
  );
  silentInputTimerId = null;
}

function setSilentInputHint(
  showHint: boolean,
): void {
  if (
    silentInputHintActive === showHint
  ) {
    return;
  }

  silentInputHintActive = showHint;
  relaySilentInputStateToContent();
}

function relaySilentInputStateToContent(): void {
  if (
    captureState.status !== "running" ||
    captureState.requestId === undefined ||
    captureState.tabId === undefined
  ) {
    return;
  }

  const port =
    contentPorts.get(captureState.tabId);

  if (port === undefined) {
    return;
  }

  postSilentInputState(port, {
    t: "SW_SILENT_INPUT",
    requestId: captureState.requestId,
    showHint: silentInputHintActive,
  });
}

async function inspectUnexpectedOffscreenDisconnect(
  disconnectedPort: chrome.runtime.Port,
): Promise<void> {
  if (
    offscreenPort !== null ||
    !isCaptureActive(captureState.status)
  ) {
    return;
  }

  try {
    const contexts =
      await getOffscreenContexts();

    if (
      contexts.length > 0 ||
      offscreenPort !== null ||
      !isCaptureActive(captureState.status)
    ) {
      return;
    }

    if (!offscreenUnhandledErrorRecorded) {
      offscreenUnhandledErrorRecorded =
        true;

      void persistLastUnhandledError({
        at: nowIso(),
        context: "offscreen",
        message:
          "offscreen disappeared without a recorded error",
      });
    }

    failActiveCaptureUnexpectedly(
      "字幕処理が予期せず終了しました。もう一度開始してください",
    );
  } catch (error) {
    console.error(
      "[bg]",
      "could not verify offscreen disconnect",
      {
        disconnectedPort,
        error,
      },
    );
  }
}

function failActiveCaptureUnexpectedly(
  message: string,
): void {
  if (!isCaptureActive(captureState.status)) {
    return;
  }

  recoveryPending = false;

  const requestId = captureState.requestId;
  const tabId = captureState.tabId;

  if (
    requestId !== undefined &&
    tabId !== undefined
  ) {
    const content = contentPorts.get(tabId);

    if (content !== undefined) {
      postStopToContent(
        content,
        requestId,
      );
    }

    if (offscreenPort !== null) {
      postStopToOffscreen(
        offscreenPort,
        requestId,
      );
    }
  }

  clearSessionTracking();
  latestRms = 0;
  activeTranslationState = null;
  recognitionLines.clear();
  resetSilentInputTracking();
  broadcastLevel();
  flushPcmRelayDropCounts();

  moveCaptureState("error", {
    ...(requestId === undefined
      ? {}
      : { requestId }),
    ...(tabId === undefined
      ? {}
      : { tabId }),
    error: {
      name: "CaptureInterruptedError",
      message,
    },
  });
}

function reconcileRecoveredCapture(
  reason: string,
): Promise<void> {
  if (recoveryOperation !== null) {
    return recoveryOperation;
  }

  const operation =
    performRecoveredCaptureReconciliation(
      reason,
    )
      .catch((error: unknown) => {
        console.error(
          "[bg]",
          "capture reconciliation failed",
          error,
        );

        if (
          recoveryPending &&
          isCaptureActive(
            captureState.status,
          )
        ) {
          failActiveCaptureUnexpectedly(
            "字幕セッションを復旧できませんでした。もう一度開始してください",
          );
        }
      })
      .finally(() => {
        if (recoveryOperation === operation) {
          recoveryOperation = null;
        }
      });

  recoveryOperation = operation;
  return operation;
}

async function performRecoveredCaptureReconciliation(
  reason: string,
): Promise<void> {
  if (
    !recoveryPending ||
    !isCaptureActive(captureState.status)
  ) {
    return;
  }

  const requestId = captureState.requestId;
  const tabId = captureState.tabId;
  const session = persistedCaptureSession;

  if (
    requestId === undefined ||
    tabId === undefined ||
    session === null ||
    session.requestId !== requestId ||
    session.tabId !== tabId
  ) {
    failActiveCaptureUnexpectedly(
      "字幕セッションの復旧情報が一致しません。もう一度開始してください",
    );
    return;
  }

  const contexts =
    await getOffscreenContexts();

  if (contexts.length === 0) {
    failActiveCaptureUnexpectedly(
      "字幕処理が終了していたため、セッションを復旧できませんでした",
    );
    return;
  }

  const port =
    offscreenPort ??
    await waitForOffscreenPort(PORT_WAIT_MS);
  const status =
    await queryOffscreenStatus(
      port,
      PORT_WAIT_MS,
    );

  if (
    !recoveryPending ||
    captureState.requestId !== requestId ||
    captureState.tabId !== tabId ||
    !isCaptureActive(captureState.status)
  ) {
    return;
  }

  if (
    !status.sessionActive ||
    status.state.requestId !== requestId ||
    !isCaptureActive(status.state.status)
  ) {
    failActiveCaptureUnexpectedly(
      "字幕処理の実行状態を確認できなかったため、セッションを終了しました",
    );
    return;
  }

  await assertSupportedCaptureTab(tabId);
  const content =
    await getOrInjectContentPort(
      tabId,
      PORT_WAIT_MS,
    );

  if (
    !recoveryPending ||
    captureState.requestId !== requestId ||
    captureState.tabId !== tabId ||
    !isCaptureActive(captureState.status)
  ) {
    return;
  }

  const startMessage: CsStartTapMessage = {
    t: "CS_START_TAP",
    requestId,
    settings: session.settings,
  };

  content.postMessage(startMessage);
  contentStartRequestId = requestId;
  offscreenStartRequestId = requestId;
  localStartRequestId = null;
  recoveryPending = false;

  handleOffscreenState({
    t: "OFF_STATE",
    state: status.state,
  });
  postCaptureState(content);

  if (status.state.status === "running") {
    postSilentInputState(content, {
      t: "SW_SILENT_INPUT",
      requestId,
      showHint: silentInputHintActive,
    });
  }

  console.info(
    "[bg]",
    "persisted capture reconciled",
    {
      requestId,
      tabId,
      reason,
      offscreenStatus:
        status.state.status,
    },
  );
}

function queryOffscreenStatus(
  port: chrome.runtime.Port,
  timeoutMs: number,
): Promise<OffStatusMessage> {
  const queryId =
    createProbeRequestId(
      "offscreen-status",
    );
  const message: OffQueryMessage = {
    t: "OFF_QUERY",
    queryId,
  };

  return new Promise<OffStatusMessage>(
    (resolve, reject) => {
      const waiter: OffscreenStatusWaiter = {
        port,
        resolve,
        reject,
        timerId: self.setTimeout(() => {
          offscreenStatusWaiters.delete(
            queryId,
          );
          reject(
            new Error(
              "Offscreen status query timed out",
            ),
          );
        }, timeoutMs),
      };

      offscreenStatusWaiters.set(
        queryId,
        waiter,
      );

      try {
        port.postMessage(message);
      } catch (error) {
        offscreenStatusWaiters.delete(
          queryId,
        );
        globalThis.clearTimeout(
          waiter.timerId,
        );
        reject(errorToError(error));
      }
    },
  );
}

function resolveOffscreenStatusWaiter(
  port: chrome.runtime.Port,
  message: OffStatusMessage,
): void {
  const waiter =
    offscreenStatusWaiters.get(
      message.queryId,
    );

  if (
    waiter === undefined ||
    waiter.port !== port
  ) {
    return;
  }

  offscreenStatusWaiters.delete(
    message.queryId,
  );
  globalThis.clearTimeout(
    waiter.timerId,
  );
  waiter.resolve(message);
}

function rejectOffscreenStatusWaitersForPort(
  port: chrome.runtime.Port,
  error: Error,
): void {
  for (
    const [queryId, waiter]
    of offscreenStatusWaiters
  ) {
    if (waiter.port !== port) {
      continue;
    }

    offscreenStatusWaiters.delete(queryId);
    globalThis.clearTimeout(
      waiter.timerId,
    );
    waiter.reject(error);
  }
}

function relayOffscreenTranslationRequest(
  message: CsTranslateMessage,
): void {
  if (
    captureState.requestId !==
      message.requestId ||
    !isCaptureActive(captureState.status)
  ) {
    postTranslationFailureToOffscreen(
      message,
      new Error(
        "Translation request does not belong to the active capture",
      ),
    );
    return;
  }

  const tabId = captureState.tabId;
  const content =
    tabId === undefined
      ? undefined
      : contentPorts.get(tabId);

  if (content === undefined) {
    postTranslationFailureToOffscreen(
      message,
      new Error(
        "Capture-tab content script is unavailable",
      ),
    );
    return;
  }

  try {
    content.postMessage(message);
  } catch (error) {
    postTranslationFailureToOffscreen(
      message,
      error,
    );
  }
}

function postTranslationFailureToOffscreen(
  request: CsTranslateMessage,
  error: unknown,
): void {
  const port = offscreenPort;

  if (port === null) {
    return;
  }

  const message: CsTranslateResultMessage = {
    t: "CS_TRANSLATE_RESULT",
    requestId: request.requestId,
    id: request.id,
    ja: "",
    available: false,
    error: toProbeError(error),
  };

  try {
    port.postMessage(message);
  } catch (postError) {
    console.warn(
      "[bg]",
      "could not return translation relay failure",
      postError,
    );
  }
}

function handleOffscreenTranslationState(
  message: OffTranslationStateMessage,
): void {
  if (
    captureState.requestId !==
      message.requestId ||
    !isCaptureActive(captureState.status)
  ) {
    return;
  }

  const relayed:
    SwTranslationStateMessage = {
      t: "SW_TRANSLATION_STATE",
      requestId: message.requestId,
      path: message.path,
    };

  activeTranslationState = relayed;

  for (const port of optionsPorts) {
    postTranslationState(port, relayed);
  }

  const tabId = captureState.tabId;

  if (tabId === undefined) {
    return;
  }

  const content = contentPorts.get(tabId);

  if (content !== undefined) {
    postTranslationState(
      content,
      relayed,
    );
  }
}

function handleOffscreenState(
  message: OffStateMessage,
): void {
  const incoming = message.state;
  const current = captureState;

  if (
    incoming.requestId !== undefined &&
    current.requestId !== undefined &&
    incoming.requestId !== current.requestId
  ) {
    return;
  }

  switch (incoming.status) {
    case "starting":
      if (
        current.status === "idle" ||
        current.status === "error"
      ) {
        replaceCaptureState(
          createCaptureState("starting", {
            ...(incoming.requestId ===
            undefined
              ? {}
              : {
                  requestId:
                    incoming.requestId,
                }),
            ...(current.tabId === undefined
              ? {}
              : { tabId: current.tabId }),
          }),
        );
      }
      return;

    case "loadingModel":
      if (current.status === "stopping") {
        if (
          offscreenPort !== null &&
          current.requestId !== undefined
        ) {
          postStopToOffscreen(
            offscreenPort,
            current.requestId,
          );
        }
        return;
      }

      if (
        current.status === "starting" ||
        current.status === "loadingModel"
      ) {
        moveCaptureState(
          "loadingModel",
          stateDetailsFromIncoming(
            incoming,
            current,
          ),
        );
        return;
      }

      if (
        current.status === "idle" ||
        current.status === "error"
      ) {
        replaceCaptureState(
          createCaptureState(
            "loadingModel",
            stateDetailsFromIncoming(
              incoming,
              current,
            ),
          ),
        );
      }
      return;

    case "running":
      localStartRequestId = null;
      offscreenStartRequestId =
        incoming.requestId ??
        current.requestId ??
        null;

      if (current.status === "stopping") {
        if (
          offscreenPort !== null &&
          current.requestId !== undefined
        ) {
          postStopToOffscreen(
            offscreenPort,
            current.requestId,
          );
        }
        return;
      }

      if (
        current.status === "starting" ||
        current.status === "loadingModel"
      ) {
        moveCaptureState(
          "running",
          stateDetailsFromIncoming(
            incoming,
            current,
          ),
        );
        return;
      }

      if (
        current.status === "idle" ||
        current.status === "error"
      ) {
        replaceCaptureState(
          createCaptureState(
            "running",
            stateDetailsFromIncoming(
              incoming,
              current,
            ),
          ),
        );
      }
      return;

    case "stopping":
      if (isCaptureActive(current.status)) {
        moveCaptureState(
          "stopping",
          stateDetailsFromIncoming(
            incoming,
            current,
          ),
        );
      }
      return;

    case "idle":
      if (current.status === "running") {
        stopContentForState(current);
        resetSessionPresentation();

        moveCaptureState("stopping", {
          ...(current.requestId === undefined
            ? {}
            : {
                requestId:
                  current.requestId,
              }),
          ...(current.tabId === undefined
            ? {}
            : { tabId: current.tabId }),
        });
        moveCaptureState("idle");
        return;
      }

      if (current.status === "stopping") {
        stopContentForState(current);
        resetSessionPresentation();
        moveCaptureState("idle");
        return;
      }

      if (
        (
          current.status === "starting" ||
          current.status === "loadingModel"
        ) &&
        incoming.requestId !== undefined &&
        incoming.requestId ===
          current.requestId &&
        !recoveryPending
      ) {
        stopContentForState(current);
        resetSessionPresentation();

        moveCaptureState("error", {
          requestId:
            current.requestId,
          ...(current.tabId === undefined
            ? {}
            : { tabId: current.tabId }),
          error: {
            name:
              "CaptureInterruptedError",
            message:
              "Offscreen processing returned to idle before startup completed",
          },
        });
      }
      return;

    case "error":
      stopContentForState(current);
      resetSessionPresentation();

      if (current.status === "error") {
        replaceCaptureState(
          createCaptureState("error", {
            ...(incoming.requestId ??
            current.requestId
              ? {
                  requestId:
                    incoming.requestId ??
                    current.requestId,
                }
              : {}),
            ...(current.tabId === undefined
              ? {}
              : { tabId: current.tabId }),
            ...(incoming.progress === undefined
              ? {}
              : {
                  progress:
                    incoming.progress,
                }),
            ...(incoming.model === undefined
              ? {}
              : { model: incoming.model }),
            ...(incoming.device === undefined
              ? {}
              : {
                  device:
                    incoming.device,
                }),
            error:
              incoming.error ??
              current.error ?? {
                name: "CaptureError",
                message:
                  "Offscreen processing reported an error",
              },
          }),
        );
        return;
      }

      moveCaptureState("error", {
        ...(incoming.requestId ??
        current.requestId
          ? {
              requestId:
                incoming.requestId ??
                current.requestId,
            }
          : {}),
        ...(current.tabId === undefined
          ? {}
          : { tabId: current.tabId }),
        ...(incoming.progress === undefined
          ? {}
          : {
              progress: incoming.progress,
            }),
        ...(incoming.model === undefined
          ? {}
          : { model: incoming.model }),
        ...(incoming.device === undefined
          ? {}
          : { device: incoming.device }),
        error:
          incoming.error ?? {
            name: "CaptureError",
            message:
              "Offscreen processing reported an error",
          },
      });
  }
}

function resetSessionPresentation(): void {
  clearSessionTracking();
  latestRms = 0;
  activeTranslationState = null;
  recognitionLines.clear();
  resetSilentInputTracking();
  broadcastLevel();
}

function stopContentForState(
  state: CaptureState,
): void {
  if (
    state.tabId === undefined ||
    state.requestId === undefined
  ) {
    return;
  }

  const port =
    contentPorts.get(state.tabId);

  if (port !== undefined) {
    postStopToContent(
      port,
      state.requestId,
    );
  }
}

function stateDetailsFromIncoming(
  incoming: CaptureState,
  current: CaptureState,
): CaptureStateDetails {
  return {
    ...(incoming.requestId ??
    current.requestId
      ? {
          requestId:
            incoming.requestId ??
            current.requestId,
        }
      : {}),
    ...(current.tabId === undefined
      ? {}
      : { tabId: current.tabId }),
    ...(incoming.progress === undefined
      ? {}
      : { progress: incoming.progress }),
    ...(incoming.model === undefined
      ? {}
      : { model: incoming.model }),
    ...(incoming.device === undefined
      ? {}
      : { device: incoming.device }),
  };
}

function handleOffscreenRecognition(
  message: OffRecognitionMessage,
): void {
  // "stopping" still accepts lines: the segmenter's stop() flush emits the
  // final tail clause after the state has already left "running".
  if (
    captureState.status !== "running" &&
    captureState.status !== "stopping"
  ) {
    return;
  }

  const relayed: SwRecognitionMessage = {
    t: "SW_RECOG",
    id: message.id,
    text: message.text,
    final: message.final,
    at: message.at,
    ...(message.ja === undefined
      ? {}
      : { ja: message.ja }),
  };

  recognitionLines.set(
    relayed.id,
    relayed,
  );
  trimRecognitionLines();

  for (const port of optionsPorts) {
    postRecognition(port, relayed);
  }

  const tabId = captureState.tabId;

  if (tabId === undefined) {
    return;
  }

  const content = contentPorts.get(tabId);

  if (content === undefined) {
    return;
  }

  const caption: SwCaptionMessage = {
    t: "SW_CAPTION",
    id: message.id,
    text: message.text,
    final: message.final,
    at: message.at,
    ...(message.ja === undefined
      ? {}
      : { ja: message.ja }),
  };

  postCaption(content, caption);
}

function trimRecognitionLines(): void {
  while (
    recognitionLines.size >
    MAX_RECOGNITION_LINES
  ) {
    const oldestId =
      recognitionLines.keys().next().value as
        | number
        | undefined;

    if (oldestId === undefined) {
      return;
    }

    recognitionLines.delete(oldestId);
  }
}

function handleOptionsPortConnected(
  port: chrome.runtime.Port,
): void {
  optionsPorts.add(port);

  port.onDisconnect.addListener(() => {
    optionsPorts.delete(port);
  });

  void stateInitialization.then(() => {
    postCaptureState(port);
    postLevel(port);

    if (activeTranslationState !== null) {
      postTranslationState(
        port,
        activeTranslationState,
      );
    }

    for (
      const message of
      recognitionLines.values()
    ) {
      postRecognition(port, message);
    }
  });
}

function postStopToOffscreen(
  port: chrome.runtime.Port,
  requestId: string,
): void {
  const message: OffStopMessage = {
    t: "OFF_STOP",
    requestId,
  };

  try {
    port.postMessage(message);
  } catch (error) {
    console.error(
      "[bg]",
      "could not send stop to offscreen",
      error,
    );
  }
}

function postStopToContent(
  port: chrome.runtime.Port,
  requestId: string,
): void {
  const message: CsStopTapMessage = {
    t: "CS_STOP_TAP",
    requestId,
  };

  try {
    port.postMessage(message);
  } catch (error) {
    console.error(
      "[bg]",
      "could not send stop to content",
      error,
    );
  }
}

function showTransientCaptureError(
  detail: string,
): void {
  clearTransientErrorTimer();

  if (captureState.status === "error") {
    moveCaptureState("idle");
  }

  if (captureState.status !== "idle") {
    return;
  }

  const requestId =
    createProbeRequestId(
      "unsupported-tab",
    );

  moveCaptureState("error", {
    requestId,
    error: {
      name: "CaptureError",
      message: detail,
    },
  });

  transientErrorTimerId =
    self.setTimeout(() => {
      transientErrorTimerId = null;

      if (
        captureState.status === "error" &&
        captureState.requestId === requestId
      ) {
        moveCaptureState("idle");
      }
    }, TRANSIENT_ERROR_MS);
}

function clearTransientErrorTimer(): void {
  if (transientErrorTimerId === null) {
    return;
  }

  globalThis.clearTimeout(
    transientErrorTimerId,
  );
  transientErrorTimerId = null;
}

function clearSessionTracking(): void {
  localStartRequestId = null;
  offscreenStartRequestId = null;
  contentStartRequestId = null;
}

function moveCaptureState(
  nextStatus: CaptureStatus,
  details: CaptureStateDetails = {},
): void {
  replaceCaptureState(
    transitionCaptureState(
      captureState,
      nextStatus,
      details,
    ),
  );
}

function replaceCaptureState(
  nextState: CaptureState,
): void {
  const previousState = captureState;

  captureState = nextState;

  if (
    previousState.status === "stopping" &&
    nextState.status === "idle"
  ) {
    flushPcmRelayDropCounts();
  }

  synchronizeSilentInputForCaptureState(
    previousState,
    nextState,
  );

  if (
    nextState.status === "idle" ||
    nextState.status === "error"
  ) {
    recoveryPending = false;
    persistedCaptureSession = null;
    void queueCaptureSessionWrite(null);
  }

  queueCaptureStateWrite(nextState);
  queueBadgeUpdate(nextState);
  broadcastCaptureState();
  relayCaptureStateToContent(
    previousState,
    nextState,
  );

  if (
    shouldClearCaptionForStatus(
      nextState.status,
    )
  ) {
    relayCaptionClearToContent(
      previousState,
      nextState,
    );
  }

  if (
    shouldCloseOffscreenAfterTransition(
      previousState,
      nextState,
    )
  ) {
    scheduleOffscreenClose(
      `${previousState.status}-to-${nextState.status}`,
    );
  }
}

function synchronizeSilentInputForCaptureState(
  previousState: CaptureState,
  nextState: CaptureState,
): void {
  if (nextState.status !== "running") {
    resetSilentInputTracking();
    return;
  }

  const enteredRunning =
    previousState.status !== "running" ||
    previousState.requestId !==
      nextState.requestId;

  if (!enteredRunning) {
    return;
  }

  resetSilentInputTracking();

  if (
    nextState.requestId !== undefined &&
    latestRms <
      SILENT_INPUT_RMS_THRESHOLD
  ) {
    beginSilentInputTracking(
      nextState.requestId,
    );
  }
}

function relayCaptureStateToContent(
  previousState: CaptureState,
  nextState: CaptureState,
): void {
  const tabId =
    nextState.tabId ??
    previousState.tabId;

  if (tabId === undefined) {
    return;
  }

  const port = contentPorts.get(tabId);

  if (port !== undefined) {
    postCaptureState(port);
  }
}

function relayCaptionClearToContent(
  previousState: CaptureState,
  nextState: CaptureState,
): void {
  const tabId =
    nextState.tabId ??
    previousState.tabId;

  if (tabId === undefined) {
    return;
  }

  const port = contentPorts.get(tabId);

  if (port !== undefined) {
    postCaptionClear(port);
  }
}

function shouldClearCaptionForStatus(
  status: CaptureStatus,
): boolean {
  return (
    status === "stopping" ||
    status === "idle" ||
    status === "error"
  );
}

function shouldCloseOffscreenAfterTransition(
  previousState: CaptureState,
  nextState: CaptureState,
): boolean {
  if (
    previousState.status === "stopping" &&
    nextState.status === "idle"
  ) {
    return true;
  }

  return (
    nextState.status === "error" &&
    (
      previousState.status === "starting" ||
      previousState.status ===
        "loadingModel" ||
      previousState.status === "running" ||
      previousState.status === "stopping" ||
      nextState.requestId !== undefined
    )
  );
}

function queueCaptureStateWrite(
  state: CaptureState,
): void {
  const operation = captureStateWriteTail
    .catch(() => undefined)
    .then(async () => {
      await chrome.storage.session.set({
        [CAPTURE_STATE_STORAGE_KEY]: state,
      });
    });

  captureStateWriteTail = operation.catch(
    (error: unknown) => {
      console.error(
        "[bg]",
        "capture state write failed",
        error,
      );
    },
  );
}

function queueCaptureSessionWrite(
  session: PersistedCaptureSession | null,
): Promise<void> {
  const operation = captureSessionWriteTail
    .catch(() => undefined)
    .then(async () => {
      if (session === null) {
        await chrome.storage.session.remove(
          CAPTURE_SESSION_STORAGE_KEY,
        );
        return;
      }

      await chrome.storage.session.set({
        [CAPTURE_SESSION_STORAGE_KEY]:
          session,
      });
    });

  captureSessionWriteTail =
    operation.catch((error: unknown) => {
      console.error(
        "[bg]",
        "capture session write failed",
        error,
      );
    });

  return operation;
}

function isPersistedCaptureSession(
  value: unknown,
): value is PersistedCaptureSession {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    return false;
  }

  const record =
    value as Record<string, unknown>;

  return (
    typeof record.requestId === "string" &&
    typeof record.tabId === "number" &&
    Number.isSafeInteger(record.tabId) &&
    record.tabId >= 0 &&
    isSettings(record.settings)
  );
}

async function persistLastUnhandledError(
  record: LastUnhandledErrorRecord,
): Promise<boolean> {
  try {
    await chrome.storage.session.set({
      [LAST_UNHANDLED_ERROR_STORAGE_KEY]:
        record,
    });
    return true;
  } catch (error) {
    console.warn(
      "[bg]",
      "could not persist last unhandled error",
      error,
    );
    return false;
  }
}

function toUnhandledErrorMessage(
  value: unknown,
): string {
  try {
    if (value instanceof Error) {
      return (
        value.message ||
        value.name ||
        "Unknown unhandled error"
      );
    }

    if (typeof value === "string") {
      return value;
    }

    const serialized = JSON.stringify(value);

    if (
      typeof serialized === "string" &&
      serialized.length > 0
    ) {
      return serialized;
    }

    return String(value);
  } catch {
    return "Unknown unhandled error";
  }
}

function toUnhandledErrorStack(
  value: unknown,
): Pick<
  LastUnhandledErrorRecord,
  "stack"
> | {} {
  try {
    if (
      !(value instanceof Error) ||
      typeof value.stack !== "string" ||
      value.stack.length === 0
    ) {
      return {};
    }

    return {
      stack: value.stack.slice(
        0,
        LAST_UNHANDLED_ERROR_STACK_LIMIT,
      ),
    };
  } catch {
    return {};
  }
}

function queueBadgeUpdate(
  state: CaptureState,
): void {
  const operation = badgeWriteTail
    .catch(() => undefined)
    .then(() =>
      applyBadge(state.status),
    );

  badgeWriteTail = operation.catch(
    (error: unknown) => {
      console.error(
        "[bg]",
        "badge update failed",
        error,
      );
    },
  );
}

async function applyBadge(
  status: CaptureStatus,
): Promise<void> {
  const appearance =
    getBadgeAppearance(status);

  await chrome.action.setBadgeText({
    text: appearance.text,
  });

  if (appearance.color !== null) {
    await chrome.action.setBadgeBackgroundColor({
      color: appearance.color,
    });
  }
}

function getBadgeAppearance(
  status: CaptureStatus,
): {
  text: string;
  color: string | null;
} {
  switch (status) {
    case "idle":
      return {
        text: "",
        color: null,
      };

    case "starting":
    case "loadingModel":
    case "stopping":
      return {
        text: "…",
        color: "#eab308",
      };

    case "running":
      return {
        text: "ON",
        color: "#16a34a",
      };

    case "error":
      return {
        text: "!",
        color: "#dc2626",
      };
  }
}

function broadcastCaptureState(): void {
  for (const port of optionsPorts) {
    postCaptureState(port);
  }
}

function postCaptureState(
  port: chrome.runtime.Port,
): void {
  try {
    const message: OffStateMessage = {
      t: "OFF_STATE",
      state: captureState,
    };

    port.postMessage(message);
  } catch (error) {
    console.warn(
      "[bg]",
      "could not relay capture state",
      error,
    );
  }
}

function postTranslationState(
  port: chrome.runtime.Port,
  message: SwTranslationStateMessage,
): void {
  try {
    port.postMessage(message);
  } catch (error) {
    console.warn(
      "[bg]",
      "could not relay translation state",
      error,
    );
  }
}

function postSilentInputState(
  port: chrome.runtime.Port,
  message: SwSilentInputMessage,
): void {
  try {
    port.postMessage(message);
  } catch (error) {
    console.warn(
      "[bg]",
      "could not relay silent-input state",
      error,
    );
  }
}

function broadcastTapState(
  message: CsTapStateMessage,
): void {
  for (const port of optionsPorts) {
    try {
      port.postMessage(message);
    } catch (error) {
      console.warn(
        "[bg]",
        "could not relay tap state",
        error,
      );
    }
  }
}

function broadcastLevel(): void {
  for (const port of optionsPorts) {
    postLevel(port);
  }
}

function postLevel(
  port: chrome.runtime.Port,
): void {
  try {
    port.postMessage({
      t: "OFF_LEVEL",
      rms: latestRms,
      at: nowIso(),
    });
  } catch (error) {
    console.warn(
      "[bg]",
      "could not relay capture level",
      error,
    );
  }
}

function postRecognition(
  port: chrome.runtime.Port,
  message: SwRecognitionMessage,
): void {
  try {
    port.postMessage(message);
  } catch (error) {
    console.warn(
      "[bg]",
      "could not relay recognition line",
      error,
    );
  }
}

function postCaption(
  port: chrome.runtime.Port,
  message: SwCaptionMessage,
): void {
  try {
    port.postMessage(message);
  } catch (error) {
    console.warn(
      "[bg]",
      "could not relay caption line",
      error,
    );
  }
}

function postCaptionClear(
  port: chrome.runtime.Port,
): void {
  const message: SwCaptionClearMessage = {
    t: "SW_CAPTION_CLEAR",
  };

  try {
    port.postMessage(message);
  } catch (error) {
    console.warn(
      "[bg]",
      "could not clear content caption",
      error,
    );
  }
}

function isCaptureActive(
  status: CaptureStatus,
): boolean {
  return (
    status === "starting" ||
    status === "loadingModel" ||
    status === "running"
  );
}

function isCurrentActiveRequest(
  requestId: string,
): boolean {
  return (
    captureState.requestId === requestId &&
    isCaptureActive(captureState.status)
  );
}

async function assertSupportedCaptureTab(
  tabId: number,
): Promise<void> {
  const tab = await chrome.tabs.get(tabId);

  if (
    tab.url !== undefined &&
    !isSupportedCaptureUrl(tab.url)
  ) {
    throw new Error(
      "x.com のタブで使ってください",
    );
  }
}

async function getOrInjectContentPort(
  tabId: number,
  timeoutMs: number,
): Promise<chrome.runtime.Port> {
  const existing = contentPorts.get(tabId);

  if (existing !== undefined) {
    return existing;
  }

  await ensureContentScript(tabId);
  return waitForContentPort(
    tabId,
    timeoutMs,
  );
}

function ensureContentScript(
  tabId: number,
): Promise<void> {
  const existing =
    contentInjectionOperations.get(tabId);

  if (existing !== undefined) {
    return existing;
  }

  const operation =
    performContentScriptHandshake(tabId)
      .finally(() => {
        if (
          contentInjectionOperations.get(
            tabId,
          ) === operation
        ) {
          contentInjectionOperations.delete(
            tabId,
          );
        }
      });

  contentInjectionOperations.set(
    tabId,
    operation,
  );
  return operation;
}

async function performContentScriptHandshake(
  tabId: number,
): Promise<void> {
  if (contentPorts.has(tabId)) {
    return;
  }

  await assertSupportedCaptureTab(tabId);

  const ping: CsPingMessage = {
    t: "CS_PING",
  };

  try {
    const response =
      (await chrome.tabs.sendMessage(
        tabId,
        ping,
      )) as unknown;

    if (
      isMessageOfType(
        response,
        "CS_PONG",
      )
    ) {
      return;
    }
  } catch (error) {
    console.info(
      "[bg]",
      "content script ping failed; injecting it",
      {
        tabId,
        error,
      },
    );
  }

  if (contentPorts.has(tabId)) {
    return;
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: [CONTENT_SCRIPT_PATH],
  });
}

function isSupportedCaptureUrl(
  value: string | undefined,
): boolean {
  if (value === undefined) {
    return false;
  }

  try {
    const url = new URL(value);

    if (
      url.protocol === "https:" &&
      (
        url.hostname === "x.com" ||
        url.hostname === "twitter.com"
      )
    ) {
      return true;
    }

    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port === "8123"
    );
  } catch {
    return false;
  }
}

function toCaptureStateError(
  error: unknown,
): CaptureStateError {
  return toProbeError(error);
}

function enqueueOffscreenOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const next = offscreenOperationTail
    .catch(() => undefined)
    .then(operation);

  offscreenOperationTail = next.then(
    () => undefined,
    () => undefined,
  );

  return next;
}

function ensureOffscreenDocument(): Promise<void> {
  return enqueueOffscreenOperation(
    createOffscreenDocumentIfMissing,
  );
}

async function createOffscreenDocumentIfMissing(): Promise<void> {
  const contexts =
    await getOffscreenContexts();

  if (contexts.length > 0) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: [
      chrome.offscreen.Reason.WORKERS,
    ],
    justification:
      "Host on-device speech recognition workers and diagnostics",
  });
}

function scheduleOffscreenClose(
  reason: string,
): void {
  offscreenCloseRequested = true;
  offscreenCloseReason = reason;
  queueOffscreenCloseOperation();
}

function queueOffscreenCloseOperation(): void {
  if (offscreenCloseOperationQueued) {
    return;
  }

  offscreenCloseOperationQueued = true;

  void enqueueOffscreenOperation(
    closeOffscreenDocumentIfUnused,
  )
    .catch((error: unknown) => {
      offscreenCloseRequested = false;

      console.error(
        "[bg]",
        "could not close offscreen document",
        error,
      );
    })
    .finally(() => {
      offscreenCloseOperationQueued = false;

      if (
        offscreenCloseRequested &&
        offscreenBusyCount === 0
      ) {
        queueOffscreenCloseOperation();
      }
    });
}

async function closeOffscreenDocumentIfUnused(): Promise<void> {
  if (!offscreenCloseRequested) {
    return;
  }

  if (offscreenBusyCount > 0) {
    return;
  }

  if (!isOffscreenCloseSafe()) {
    offscreenCloseRequested = false;
    return;
  }

  const contexts =
    await getOffscreenContexts();

  if (
    offscreenBusyCount > 0 ||
    !isOffscreenCloseSafe()
  ) {
    return;
  }

  if (contexts.length === 0) {
    offscreenCloseRequested = false;
    return;
  }

  const reason = offscreenCloseReason;
  offscreenCloseRequested = false;
  offscreenCloseInvocationActive = true;

  if (offscreenPort !== null) {
    expectedOffscreenDisconnectPorts.add(
      offscreenPort,
    );
  }

  try {
    await chrome.offscreen.closeDocument();

    console.info(
      "[bg]",
      "offscreen document closed",
      { reason },
    );
  } finally {
    offscreenCloseInvocationActive = false;
  }
}

function isOffscreenCloseSafe(): boolean {
  return (
    captureState.status === "idle" ||
    captureState.status === "error"
  );
}

async function getOffscreenContexts(): Promise<
  chrome.runtime.ExtensionContext[]
> {
  return chrome.runtime.getContexts({
    contextTypes: [
      chrome.runtime.ContextType
        .OFFSCREEN_DOCUMENT,
    ],
    documentUrls: [
      chrome.runtime.getURL(
        OFFSCREEN_DOCUMENT_PATH,
      ),
    ],
  });
}

function waitForOffscreenPort(
  timeoutMs: number,
): Promise<chrome.runtime.Port> {
  if (offscreenPort !== null) {
    return Promise.resolve(offscreenPort);
  }

  return new Promise<chrome.runtime.Port>(
    (resolve, reject) => {
      const waiter: PortWaiter = {
        resolve,
        reject,
        timerId: self.setTimeout(
          () => {
            const index =
              offscreenPortWaiters.indexOf(
                waiter,
              );

            if (index !== -1) {
              offscreenPortWaiters.splice(
                index,
                1,
              );
            }

            reject(
              new Error(
                "Offscreen port did not connect before startup timed out",
              ),
            );
          },
          timeoutMs,
        ),
      };

      offscreenPortWaiters.push(waiter);
    },
  );
}

function resolveOffscreenPortWaiters(
  port: chrome.runtime.Port,
): void {
  const waiters =
    offscreenPortWaiters.splice(
      0,
      offscreenPortWaiters.length,
    );

  for (const waiter of waiters) {
    globalThis.clearTimeout(
      waiter.timerId,
    );
    waiter.resolve(port);
  }
}

function waitForContentPort(
  tabId: number,
  timeoutMs: number,
): Promise<chrome.runtime.Port> {
  const existing = contentPorts.get(tabId);

  if (existing !== undefined) {
    return Promise.resolve(existing);
  }

  return new Promise<chrome.runtime.Port>(
    (resolve, reject) => {
      const waiters =
        contentPortWaiters.get(tabId) ?? [];

      const waiter: PortWaiter = {
        resolve,
        reject,
        timerId: self.setTimeout(
          () => {
            removeContentPortWaiter(
              tabId,
              waiter,
            );

            reject(
              new Error(
                "Content-script port did not connect before startup timed out",
              ),
            );
          },
          timeoutMs,
        ),
      };

      waiters.push(waiter);
      contentPortWaiters.set(
        tabId,
        waiters,
      );
    },
  );
}

function resolveContentPortWaiters(
  tabId: number,
  port: chrome.runtime.Port,
): void {
  const waiters =
    contentPortWaiters.get(tabId);

  if (waiters === undefined) {
    return;
  }

  contentPortWaiters.delete(tabId);

  for (const waiter of waiters) {
    globalThis.clearTimeout(
      waiter.timerId,
    );
    waiter.resolve(port);
  }
}

function rejectContentPortWaiters(
  tabId: number,
  error: Error,
): void {
  const waiters =
    contentPortWaiters.get(tabId);

  if (waiters === undefined) {
    return;
  }

  contentPortWaiters.delete(tabId);

  for (const waiter of waiters) {
    globalThis.clearTimeout(
      waiter.timerId,
    );
    waiter.reject(error);
  }
}

function removeContentPortWaiter(
  tabId: number,
  waiter: PortWaiter,
): void {
  const waiters =
    contentPortWaiters.get(tabId);

  if (waiters === undefined) {
    return;
  }

  const index = waiters.indexOf(waiter);

  if (index !== -1) {
    waiters.splice(index, 1);
  }

  if (waiters.length === 0) {
    contentPortWaiters.delete(tabId);
  }
}

async function runDiagnostics(
  requestId: string,
): Promise<DiagnosticsResultMessage> {
  offscreenBusyCount += 1;

  try {
    await ensureOffscreenDocument();
    await waitForOffscreenPort(PORT_WAIT_MS);

    const result =
      await requestOffscreenProbe(
        requestId,
      );
    const snapshot =
      await updateSnapshot({
        offscreen: result,
      });

    return {
      t: "DIAGNOSTICS_RESULT",
      requestId,
      snapshot,
    };
  } finally {
    offscreenBusyCount -= 1;

    if (
      offscreenBusyCount === 0 &&
      offscreenCloseRequested
    ) {
      queueOffscreenCloseOperation();
    }
  }
}

async function requestOffscreenProbe(
  requestId: string,
): Promise<
  OffscreenProbeResultMessage["result"]
> {
  const request: ProbeRequest = {
    t: "PROBE",
    requestId,
  };

  const response =
    (await chrome.runtime.sendMessage(
      request,
    )) as unknown;

  if (
    isMessageOfType(
      response,
      "OFFSCREEN_PROBE_RESULT",
    ) &&
    response.requestId === requestId
  ) {
    return response.result;
  }

  if (
    isMessageOfType(
      response,
      "PROBE_ERROR",
    ) &&
    response.requestId === requestId
  ) {
    throw new Error(
      `Offscreen probe failed: ${response.error.message}`,
    );
  }

  throw new Error(
    "Offscreen document returned an invalid probe response",
  );
}

async function storeContentScriptResult(
  message: ContentScriptProbeResultMessage,
): Promise<M1Message> {
  await updateSnapshot({
    contentScript: message.result,
  });

  return {
    t: "PROBE_STORED",
    requestId: message.requestId,
    context: "content-script",
    storedAt: nowIso(),
  };
}

async function storeOptionsPageResult(
  message: OptionsPageProbeResultMessage,
): Promise<M1Message> {
  await updateSnapshot({
    optionsPage: message.result,
  });

  return {
    t: "PROBE_STORED",
    requestId: message.requestId,
    context: "options-page",
    storedAt: nowIso(),
  };
}

function updateSnapshot(
  patch: SnapshotPatch,
): Promise<ProbeSnapshot> {
  const operation = storageWriteTail
    .catch(() => undefined)
    .then(async (): Promise<ProbeSnapshot> => {
      const current = await readSnapshot();
      const next: ProbeSnapshot = {
        ...(
          current ?? {
            updatedAt: nowIso(),
          }
        ),
        ...patch,
        updatedAt: nowIso(),
      };

      await chrome.storage.session.set({
        [LAST_PROBE_STORAGE_KEY]: next,
      });

      return next;
    });

  storageWriteTail = operation.then(
    () => undefined,
    (error: unknown) => {
      console.error(
        "[bg]",
        "snapshot write failed",
        error,
      );
    },
  );

  return operation;
}

async function getLatestSnapshot(): Promise<
  ProbeSnapshot | null
> {
  await storageWriteTail;
  return readSnapshot();
}

async function readSnapshot(): Promise<
  ProbeSnapshot | null
> {
  const values =
    await chrome.storage.session.get(
      LAST_PROBE_STORAGE_KEY,
    );
  const value =
    values[LAST_PROBE_STORAGE_KEY];

  return isProbeSnapshot(value)
    ? value
    : null;
}

function createFailure(
  requestId: string,
  source: ProbeFailureMessage["source"],
  error: unknown,
): ProbeFailureMessage {
  return {
    t: "PROBE_ERROR",
    requestId,
    source,
    error: toProbeError(error),
    at: nowIso(),
  };
}

function errorToError(
  error: unknown,
): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

void (null as CsPongMessage | null);
