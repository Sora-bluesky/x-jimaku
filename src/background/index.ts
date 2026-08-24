import {
  LAST_PROBE_STORAGE_KEY,
  createProbeRequestId,
  isContentPortMessage,
  isMessageOfType,
  isM1Message,
  isProbeSnapshot,
  nowIso,
  toProbeError,
  type ContentScriptProbeResultMessage,
  type CsPcmMessage,
  type CsStartTapMessage,
  type CsStopTapMessage,
  type CsTapStateMessage,
  type DiagnosticsResultMessage,
  type M1Message,
  type OffRecognitionMessage,
  type OffStartMessage,
  type OffscreenProbeResultMessage,
  type OffStateMessage,
  type OffStopMessage,
  type OptionsPageProbeResultMessage,
  type ProbeFailureMessage,
  type ProbeRequest,
  type ProbeSnapshot,
  type SwCaptionClearMessage,
  type SwCaptionMessage,
  type SwRecognitionMessage,
} from "../shared/messages";
import {
  readSettings,
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
const OFFSCREEN_PORT_NAME = "offscreen";
const CONTENT_PORT_NAME = "content";
const OPTIONS_PORT_NAME = "options";
const PORT_WAIT_MS = 2_000;
const TRANSIENT_ERROR_MS = 2_500;
const MAX_RECOGNITION_LINES = 50;

type SnapshotPatch = Partial<
  Omit<ProbeSnapshot, "updatedAt">
>;

interface PortWaiter {
  resolve: (port: chrome.runtime.Port) => void;
  reject: (error: Error) => void;
  timerId: number;
}

const optionsPorts =
  new Set<chrome.runtime.Port>();
const contentPorts =
  new Map<number, chrome.runtime.Port>();
const contentPortWaiters =
  new Map<number, PortWaiter[]>();
const offscreenPortWaiters: PortWaiter[] =
  [];
const expectedOffscreenDisconnectPorts =
  new WeakSet<chrome.runtime.Port>();
const expectedContentDisconnectPorts =
  new WeakSet<chrome.runtime.Port>();
const recognitionLines =
  new Map<number, SwRecognitionMessage>();

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
let captureStateHydrated = false;
let captureStateWriteTail: Promise<void> =
  Promise.resolve();
let badgeWriteTail: Promise<void> =
  Promise.resolve();
let storageWriteTail: Promise<void> =
  Promise.resolve();
let latestRms = 0;
let localStartRequestId:
  | string
  | null = null;
let offscreenStartRequestId:
  | string
  | null = null;
let contentStartRequestId:
  | string
  | null = null;
let transientErrorTimerId:
  | number
  | null = null;

const stateInitialization =
  hydrateCaptureState();

console.log("[bg]", "service worker started");

void stateInitialization.then(() => {
  queueBadgeUpdate(captureState);
});

chrome.runtime.onStartup.addListener(() => {
  console.log("[bg]", "runtime startup");

  void stateInitialization.then(() => {
    queueBadgeUpdate(captureState);
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

    console.log(
      "[bg]",
      "received message",
      message.t,
      {
        senderUrl: sender.url,
        tabId: sender.tab?.id,
      },
    );

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

async function handleActionClick(
  tab: chrome.tabs.Tab,
): Promise<void> {
  await stateInitialization;

  console.log("[bg]", "action clicked", {
    tabId: tab.id,
    url: tab.url,
    cachedState: captureState.status,
  });

  if (isCaptureActive(captureState.status)) {
    requestCaptureStop("action-click");
    return;
  }

  if (captureState.status === "stopping") {
    console.log(
      "[bg]",
      "capture stop already in progress",
    );
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
  try {
    const values =
      await chrome.storage.session.get(
        CAPTURE_STATE_STORAGE_KEY,
      );
    const stored =
      values[CAPTURE_STATE_STORAGE_KEY];

    captureState = isCaptureState(stored)
      ? stored
      : createCaptureState("idle");

    if (!isCaptureState(stored)) {
      queueCaptureStateWrite(captureState);
    }

    console.log(
      "[bg]",
      "capture state restored",
      captureState,
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
    queueCaptureStateWrite(captureState);
  } finally {
    captureStateHydrated = true;
    queueBadgeUpdate(captureState);
    broadcastCaptureState();
  }
}

function beginCaptureStart(
  tabId: number,
  requestId: string,
): void {
  clearTransientErrorTimer();

  if (captureState.status === "error") {
    moveCaptureState("idle");
  }

  if (captureState.status !== "idle") {
    return;
  }

  recognitionLines.clear();
  localStartRequestId = requestId;
  offscreenStartRequestId = null;
  contentStartRequestId = null;

  moveCaptureState("starting", {
    requestId,
    tabId,
  });

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

    await ensureOffscreenDocument();

    if (!isCurrentActiveRequest(requestId)) {
      return;
    }

    const [offscreen, content] =
      await Promise.all([
        waitForOffscreenPort(PORT_WAIT_MS),
        waitForContentPort(
          tabId,
          PORT_WAIT_MS,
        ),
      ]);

    if (!isCurrentActiveRequest(requestId)) {
      return;
    }

    const offStart: OffStartMessage = {
      t: "OFF_START",
      requestId,
      settings,
    };

    offscreen.postMessage(offStart);
    offscreenStartRequestId = requestId;

    if (!isCurrentActiveRequest(requestId)) {
      postStopToOffscreen(
        offscreen,
        requestId,
      );
      return;
    }

    const contentStart: CsStartTapMessage = {
      t: "CS_START_TAP",
      requestId,
      settings,
    };

    content.postMessage(contentStart);
    contentStartRequestId = requestId;
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

  const requestId =
    captureState.requestId ??
    createProbeRequestId("capture-stop");
  const tabId = captureState.tabId;
  const startWasNotDelivered =
    captureState.status === "starting" &&
    localStartRequestId === requestId &&
    offscreenStartRequestId !== requestId &&
    contentStartRequestId !== requestId;

  console.log("[bg]", "stopping capture", {
    requestId,
    reason,
    startWasNotDelivered,
  });

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

  console.log(
    "[bg]",
    "content port connected",
    { tabId },
  );

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
      console.info(
        "[bg]",
        "superseded content port disconnected",
        {
          tabId,
          detail: disconnectError ?? "",
        },
      );
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
      "could not relay PCM to offscreen",
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
    console.warn(
      "[bg]",
      "ignored stale content tap state",
      {
        tabId,
        incomingRequestId:
          message.requestId,
        currentRequestId:
          captureState.requestId,
      },
    );
    return;
  }

  if (message.state === "tapping") {
    console.log("[bg]", "content tap state", {
      requestId: message.requestId,
      detail: message.detail,
    });
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
    offscreenPort.disconnect();
  }

  offscreenPort = port;

  if (offscreenCloseInvocationActive) {
    expectedOffscreenDisconnectPorts.add(port);
  }

  resolveOffscreenPortWaiters(port);

  console.log("[bg]", "offscreen port connected");

  port.onMessage.addListener(
    (message: unknown) => {
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
        latestRms = message.rms;
        broadcastLevel();
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

    const disconnectError =
      chrome.runtime.lastError?.message;

    if (
      expectedOffscreenDisconnectPorts.has(port)
    ) {
      console.info(
        "[bg]",
        "offscreen port disconnected after document close",
        disconnectError ?? "",
      );
      return;
    }

    console.warn(
      "[bg]",
      "offscreen port disconnected",
      disconnectError ?? "",
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
    }
  });
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
    console.warn(
      "[bg]",
      "ignored stale offscreen state",
      {
        currentRequestId: current.requestId,
        incomingRequestId:
          incoming.requestId,
        incomingStatus: incoming.status,
      },
    );
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
        latestRms = 0;
        clearSessionTracking();
        broadcastLevel();

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
        latestRms = 0;
        clearSessionTracking();
        broadcastLevel();
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
          current.requestId
      ) {
        stopContentForState(current);
        latestRms = 0;
        clearSessionTracking();
        broadcastLevel();

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
        return;
      }

      if (
        current.status === "starting" ||
        current.status === "loadingModel"
      ) {
        console.log(
          "[bg]",
          "ignored boot-time idle report",
          {
            currentRequestId:
              current.requestId,
            incomingRequestId:
              incoming.requestId,
          },
        );
      }
      return;

    case "error":
      stopContentForState(current);
      clearSessionTracking();
      latestRms = 0;
      broadcastLevel();

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
  if (captureState.status !== "running") {
    console.warn(
      "[bg]",
      "ignored recognition outside running capture",
      {
        id: message.id,
        status: captureState.status,
      },
    );
    return;
  }

  const relayed: SwRecognitionMessage = {
    t: "SW_RECOG",
    id: message.id,
    text: message.text,
    final: message.final,
    at: message.at,
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
  console.log("[bg]", "options port connected");

  port.onDisconnect.addListener(() => {
    optionsPorts.delete(port);
    console.log(
      "[bg]",
      "options port disconnected",
    );
  });

  void stateInitialization.then(() => {
    postCaptureState(port);
    postLevel(port);

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

  console.log(
    "[bg]",
    "capture state changed",
    nextState,
  );

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
    console.log(
      "[bg]",
      "offscreen document already exists",
    );
    return;
  }

  console.log(
    "[bg]",
    "creating offscreen document",
  );

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: [
      chrome.offscreen.Reason.WORKERS,
    ],
    justification:
      "Host on-device speech recognition workers and diagnostics",
  });

  console.log(
    "[bg]",
    "offscreen document created",
  );
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
    console.info(
      "[bg]",
      "offscreen document close deferred while diagnostics are running",
      {
        reason: offscreenCloseReason,
        busyCount: offscreenBusyCount,
      },
    );
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

    console.log(
      "[bg]",
      "offscreen diagnostics stored",
      result,
    );

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

  console.log(
    "[bg]",
    "requesting offscreen probe",
    requestId,
  );

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

  const storedAt = nowIso();

  return {
    t: "PROBE_STORED",
    requestId: message.requestId,
    context: "content-script",
    storedAt,
  };
}

async function storeOptionsPageResult(
  message: OptionsPageProbeResultMessage,
): Promise<M1Message> {
  await updateSnapshot({
    optionsPage: message.result,
  });

  const storedAt = nowIso();

  return {
    t: "PROBE_STORED",
    requestId: message.requestId,
    context: "options-page",
    storedAt,
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

void captureStateHydrated;
