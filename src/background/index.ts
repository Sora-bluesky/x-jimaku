import {
  LAST_PROBE_STORAGE_KEY,
  createProbeRequestId,
  isMessageOfType,
  isM1Message,
  isProbeSnapshot,
  nowIso,
  toProbeError,
  type ContentScriptProbeResultMessage,
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
const OPTIONS_PORT_NAME = "options";
const OFFSCREEN_PORT_WAIT_MS = 2_000;
const MAX_RECOGNITION_LINES = 50;

type SnapshotPatch = Partial<
  Omit<ProbeSnapshot, "updatedAt">
>;

interface StreamIdSuccess {
  ok: true;
  streamId: string;
}

interface StreamIdFailure {
  ok: false;
  error: unknown;
}

type StreamIdResult =
  | StreamIdSuccess
  | StreamIdFailure;

interface OffscreenPortWaiter {
  resolve: (port: chrome.runtime.Port) => void;
  reject: (error: Error) => void;
  timerId: number;
}

const optionsPorts =
  new Set<chrome.runtime.Port>();
const offscreenPortWaiters:
  OffscreenPortWaiter[] = [];
const expectedOffscreenDisconnectPorts =
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
let localStreamRequestId:
  | string
  | null = null;
let deliveredCaptureRequestId:
  | string
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
  console.log("[bg]", "action clicked", {
    tabId: tab.id,
    url: tab.url,
    cachedState: captureState.status,
  });

  if (tab.id === undefined) {
    void stateInitialization.then(() => {
      moveCaptureState("error", {
        error: {
          name: "CaptureError",
          message:
            "The clicked tab does not have a usable tab ID",
        },
      });
    });
    return;
  }

  if (!captureStateHydrated) {
    const requestId =
      createProbeRequestId("capture");
    const streamIdPromise =
      chrome.tabCapture.getMediaStreamId({
        targetTabId: tab.id,
      });

    void handleClickDuringHydration(
      tab.id,
      requestId,
      streamIdPromise,
    );
    return;
  }

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

  const requestId =
    createProbeRequestId("capture");
  const streamIdPromise =
    chrome.tabCapture.getMediaStreamId({
      targetTabId: tab.id,
    });

  beginCaptureStart(
    tab.id,
    requestId,
    streamIdPromise,
  );
});

chrome.tabs.onRemoved.addListener((tabId) => {
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
        .then((response) => {
          sendResponse(response);
        })
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
        .then((response) => {
          sendResponse(response);
        })
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
        .then((response) => {
          sendResponse(response);
        })
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

async function handleClickDuringHydration(
  tabId: number,
  requestId: string,
  streamIdPromise: Promise<string>,
): Promise<void> {
  const streamResultPromise =
    settleStreamId(streamIdPromise);

  const [streamResult] = await Promise.all([
    streamResultPromise,
    stateInitialization,
  ]);

  if (isCaptureActive(captureState.status)) {
    requestCaptureStop(
      "action-click-after-state-restore",
    );
    return;
  }

  if (captureState.status === "stopping") {
    return;
  }

  beginCaptureStart(
    tabId,
    requestId,
    streamIdFromResult(streamResult),
  );
}

function beginCaptureStart(
  tabId: number,
  requestId: string,
  streamIdPromise: Promise<string>,
): void {
  if (captureState.status === "error") {
    moveCaptureState("idle");
  }

  if (captureState.status !== "idle") {
    return;
  }

  recognitionLines.clear();
  localStreamRequestId = requestId;
  deliveredCaptureRequestId = null;

  moveCaptureState("starting", {
    requestId,
    tabId,
  });

  void finishCaptureStart(
    requestId,
    streamIdPromise,
  );
}

async function finishCaptureStart(
  requestId: string,
  streamIdPromise: Promise<string>,
): Promise<void> {
  try {
    const [streamId, settings] =
      await Promise.all([
        streamIdPromise,
        readSettings(),
      ]);

    if (!isCurrentStartingRequest(requestId)) {
      return;
    }

    await ensureOffscreenDocument();

    if (!isCurrentStartingRequest(requestId)) {
      return;
    }

    const port = await waitForOffscreenPort(
      OFFSCREEN_PORT_WAIT_MS,
    );

    if (!isCurrentStartingRequest(requestId)) {
      return;
    }

    const message: OffStartMessage = {
      t: "OFF_START",
      streamId,
      requestId,
      settings,
    };

    port.postMessage(message);
    deliveredCaptureRequestId = requestId;
    localStreamRequestId = null;

    console.log(
      "[bg]",
      "capture stream ID handed to offscreen",
      { requestId },
    );
  } catch (error) {
    localStreamRequestId = null;

    if (isCurrentStartingRequest(requestId)) {
      console.error(
        "[bg]",
        "capture start failed",
        error,
      );

      moveCaptureState("error", {
        requestId,
        error: toCaptureStateError(error),
      });
    }
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
  const startWasNotDelivered =
    captureState.status === "starting" &&
    localStreamRequestId === requestId &&
    deliveredCaptureRequestId !== requestId;

  console.log("[bg]", "stopping capture", {
    requestId,
    reason,
    startWasNotDelivered,
  });

  moveCaptureState("stopping", {
    requestId,
  });

  if (startWasNotDelivered) {
    localStreamRequestId = null;
    deliveredCaptureRequestId = null;
    latestRms = 0;
    broadcastLevel();
    moveCaptureState("idle");
    return;
  }

  if (offscreenPort !== null) {
    postStopToOffscreen(
      offscreenPort,
      requestId,
    );
    return;
  }

  void getOffscreenContexts()
    .then((contexts) => {
      if (
        contexts.length === 0 &&
        captureState.status === "stopping" &&
        captureState.requestId === requestId
      ) {
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
      localStreamRequestId = null;
      deliveredCaptureRequestId =
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
        latestRms = 0;
        localStreamRequestId = null;
        deliveredCaptureRequestId = null;
        broadcastLevel();

        moveCaptureState("stopping", {
          ...(current.requestId === undefined
            ? {}
            : {
                requestId:
                  current.requestId,
              }),
        });
        moveCaptureState("idle");
        return;
      }

      if (current.status === "stopping") {
        latestRms = 0;
        localStreamRequestId = null;
        deliveredCaptureRequestId = null;
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
        latestRms = 0;
        localStreamRequestId = null;
        deliveredCaptureRequestId = null;
        broadcastLevel();

        moveCaptureState("error", {
          ...(current.requestId === undefined
            ? {}
            : {
                requestId:
                  current.requestId,
              }),
          error: {
            name:
              "CaptureInterruptedError",
            message:
              "Offscreen capture returned to idle before startup completed",
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
      localStreamRequestId = null;
      deliveredCaptureRequestId = null;
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
                  "Offscreen capture reported an error",
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
              "Offscreen capture reported an error",
          },
      });
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

function isCaptureActive(
  status: CaptureStatus,
): boolean {
  return (
    status === "starting" ||
    status === "loadingModel" ||
    status === "running"
  );
}

function isCurrentStartingRequest(
  requestId: string,
): boolean {
  return (
    captureState.status === "starting" &&
    captureState.requestId === requestId
  );
}

async function settleStreamId(
  streamIdPromise: Promise<string>,
): Promise<StreamIdResult> {
  try {
    return {
      ok: true,
      streamId: await streamIdPromise,
    };
  } catch (error) {
    return {
      ok: false,
      error,
    };
  }
}

async function streamIdFromResult(
  result: StreamIdResult,
): Promise<string> {
  if (result.ok) {
    return result.streamId;
  }

  throw result.error;
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
      chrome.offscreen.Reason.USER_MEDIA,
    ],
    justification:
      "Capture tab audio for on-device speech recognition",
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
    console.info(
      "[bg]",
      "offscreen document close skipped because capture resumed",
      {
        reason: offscreenCloseReason,
        status: captureState.status,
      },
    );
    offscreenCloseRequested = false;
    return;
  }

  const contexts =
    await getOffscreenContexts();

  if (offscreenBusyCount > 0) {
    console.info(
      "[bg]",
      "offscreen document close deferred because diagnostics started",
      {
        reason: offscreenCloseReason,
        busyCount: offscreenBusyCount,
      },
    );
    return;
  }

  if (!isOffscreenCloseSafe()) {
    console.info(
      "[bg]",
      "offscreen document close skipped because capture resumed",
      {
        reason: offscreenCloseReason,
        status: captureState.status,
      },
    );
    offscreenCloseRequested = false;
    return;
  }

  if (contexts.length === 0) {
    offscreenCloseRequested = false;

    console.info(
      "[bg]",
      "offscreen document already closed",
      { reason: offscreenCloseReason },
    );
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
      const waiter: OffscreenPortWaiter = {
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
                "Offscreen port did not connect before the tab-capture stream ID could expire",
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

async function runDiagnostics(
  requestId: string,
): Promise<DiagnosticsResultMessage> {
  offscreenBusyCount += 1;

  try {
    await ensureOffscreenDocument();
    await waitForOffscreenPort(
      OFFSCREEN_PORT_WAIT_MS,
    );

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
  console.log(
    "[bg]",
    "unsolicited content-script result stored",
    {
      requestId: message.requestId,
      storedAt,
    },
  );

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
  console.log(
    "[bg]",
    "options-page result stored",
    {
      requestId: message.requestId,
      storedAt,
    },
  );

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
