import {
  LAST_PROBE_STORAGE_KEY,
  createProbeRequestId,
  isMessageOfType,
  isM0Message,
  isProbeSnapshot,
  nowIso,
  toProbeError,
  type ContentScriptProbeResultMessage,
  type M0Message,
  type OffscreenProbeResultMessage,
  type OptionsPageProbeResultMessage,
  type ProbeFailureMessage,
  type ProbeRequest,
  type ProbeSnapshot,
} from "../shared/messages";

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const BADGE_TEXT = "M0";

type SnapshotPatch = Partial<Omit<ProbeSnapshot, "updatedAt">>;

let offscreenCreation: Promise<void> | null = null;
let storageWriteTail: Promise<void> = Promise.resolve();

console.log("[bg]", "service worker started");

void refreshBadge().catch((error: unknown) => {
  console.error("[bg]", "initial badge refresh failed", error);
});

chrome.runtime.onStartup.addListener(() => {
  console.log("[bg]", "runtime startup");

  void refreshBadge().catch((error: unknown) => {
    console.error("[bg]", "startup badge refresh failed", error);
  });
});

chrome.runtime.onInstalled.addListener((details) => {
  console.log("[bg]", "extension installed or updated", details.reason);

  void refreshBadge().catch((error: unknown) => {
    console.error("[bg]", "install badge refresh failed", error);
  });
});

chrome.action.onClicked.addListener((tab) => {
  console.log("[bg]", "action clicked", {
    tabId: tab.id,
    url: tab.url,
  });

  void handleActionClick(tab).catch((error: unknown) => {
    console.error("[bg]", "action probe flow failed", error);
  });
});

chrome.runtime.onMessage.addListener(
  (
    message: unknown,
    sender,
    sendResponse: (response?: M0Message) => void,
  ): boolean => {
    if (!isM0Message(message)) {
      console.warn("[bg]", "ignored malformed message", {
        senderUrl: sender.url,
      });
      return false;
    }

    console.log("[bg]", "received message", message.t, {
      senderUrl: sender.url,
      tabId: sender.tab?.id,
    });

    if (isMessageOfType(message, "CS_PROBE_RESULT")) {
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

    if (isMessageOfType(message, "OPTIONS_PROBE_RESULT")) {
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

    if (isMessageOfType(message, "GET_LAST_PROBE")) {
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
              createProbeRequestId("get-last"),
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

async function handleActionClick(tab: chrome.tabs.Tab): Promise<void> {
  const requestId = createProbeRequestId("action");
  let offscreenReady = false;

  try {
    await ensureOffscreenDocument();
    offscreenReady = true;
  } catch (error) {
    console.error("[bg]", "could not prepare offscreen document", error);
    await refreshBadge();
  }

  if (offscreenReady) {
    try {
      const result = await requestOffscreenProbe(requestId);
      await updateSnapshot({ offscreen: result });
      console.log("[bg]", "offscreen probe stored", result);
    } catch (error) {
      console.error("[bg]", "offscreen probe failed", error);
    }
  }

  if (tab.id !== undefined && isSupportedXUrl(tab.url)) {
    try {
      const result = await requestContentScriptProbe(
        tab.id,
        requestId,
      );
      await updateSnapshot({ contentScript: result });
      console.log("[bg]", "content-script probe stored", result);
    } catch (error) {
      console.error("[bg]", "content-script probe failed", error);
    }
  } else {
    console.log(
      "[bg]",
      "content-script probe skipped because the clicked tab is not a supported X URL",
    );
  }

  const snapshot = await getLatestSnapshot();
  console.log("[bg]", "probe flow complete", snapshot);
}

async function ensureOffscreenDocument(): Promise<void> {
  if (offscreenCreation !== null) {
    await offscreenCreation;
    return;
  }

  offscreenCreation = createOffscreenDocumentIfMissing();

  try {
    await offscreenCreation;
  } finally {
    offscreenCreation = null;
  }
}

async function createOffscreenDocumentIfMissing(): Promise<void> {
  const contexts = await getOffscreenContexts();

  if (contexts.length > 0) {
    console.log("[bg]", "offscreen document already exists");
    await setBadge(true);
    return;
  }

  console.log("[bg]", "creating offscreen document");

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification:
      "Capture tab audio for on-device speech recognition",
  });

  console.log("[bg]", "offscreen document created");
  await setBadge(true);
}

async function getOffscreenContexts(): Promise<
  chrome.runtime.ExtensionContext[]
> {
  return chrome.runtime.getContexts({
    contextTypes: [
      chrome.runtime.ContextType.OFFSCREEN_DOCUMENT,
    ],
    documentUrls: [
      chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH),
    ],
  });
}

async function refreshBadge(): Promise<void> {
  const contexts = await getOffscreenContexts();
  const offscreenAlive = contexts.length > 0;

  await setBadge(offscreenAlive);
  console.log("[bg]", "badge refreshed", { offscreenAlive });
}

async function setBadge(offscreenAlive: boolean): Promise<void> {
  await Promise.all([
    chrome.action.setBadgeText({
      text: offscreenAlive ? BADGE_TEXT : "",
    }),
    chrome.action.setBadgeBackgroundColor({
      color: "#2563eb",
    }),
  ]);
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

  console.log("[bg]", "requesting offscreen probe", requestId);

  const response = (await chrome.runtime.sendMessage(
    request,
  )) as unknown;

  if (
    isMessageOfType(response, "OFFSCREEN_PROBE_RESULT") &&
    response.requestId === requestId
  ) {
    return response.result;
  }

  if (
    isMessageOfType(response, "PROBE_ERROR") &&
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

async function requestContentScriptProbe(
  tabId: number,
  requestId: string,
): Promise<
  ContentScriptProbeResultMessage["result"]
> {
  const request: ProbeRequest = {
    t: "PROBE",
    requestId,
  };

  console.log("[bg]", "requesting content-script probe", {
    tabId,
    requestId,
  });

  const response = (await chrome.tabs.sendMessage(
    tabId,
    request,
  )) as unknown;

  if (
    isMessageOfType(response, "CS_PROBE_RESULT") &&
    response.requestId === requestId
  ) {
    return response.result;
  }

  if (
    isMessageOfType(response, "PROBE_ERROR") &&
    response.requestId === requestId
  ) {
    throw new Error(
      `Content-script probe failed: ${response.error.message}`,
    );
  }

  throw new Error(
    "Content script returned an invalid probe response",
  );
}

async function storeContentScriptResult(
  message: ContentScriptProbeResultMessage,
): Promise<M0Message> {
  await updateSnapshot({
    contentScript: message.result,
  });

  const storedAt = nowIso();
  console.log("[bg]", "unsolicited content-script result stored", {
    requestId: message.requestId,
    storedAt,
  });

  return {
    t: "PROBE_STORED",
    requestId: message.requestId,
    context: "content-script",
    storedAt,
  };
}

async function storeOptionsPageResult(
  message: OptionsPageProbeResultMessage,
): Promise<M0Message> {
  await updateSnapshot({
    optionsPage: message.result,
  });

  const storedAt = nowIso();
  console.log("[bg]", "options-page result stored", {
    requestId: message.requestId,
    storedAt,
  });

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
        ...(current ?? { updatedAt: nowIso() }),
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
      console.error("[bg]", "snapshot write failed", error);
    },
  );

  return operation;
}

async function getLatestSnapshot(): Promise<ProbeSnapshot | null> {
  await storageWriteTail;
  return readSnapshot();
}

async function readSnapshot(): Promise<ProbeSnapshot | null> {
  const values = await chrome.storage.session.get(
    LAST_PROBE_STORAGE_KEY,
  );
  const value = values[LAST_PROBE_STORAGE_KEY];

  return isProbeSnapshot(value) ? value : null;
}

function isSupportedXUrl(url: string | undefined): boolean {
  if (url === undefined) {
    return false;
  }

  try {
    const parsed = new URL(url);

    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === "x.com" ||
        parsed.hostname === "twitter.com")
    );
  } catch {
    return false;
  }
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
