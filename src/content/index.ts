import {
  createProbeRequestId,
  getProbeEnvironment,
  isMessageOfType,
  nowIso,
  toProbeError,
  type ContentScriptProbeResultMessage,
  type ProbeFailureMessage,
  type TranslatorProbeResult,
} from "../shared/messages";

type TranslatorScope = typeof globalThis & {
  Translator?: TranslatorFactory;
};

console.log("[cs]", "content script loaded", {
  url: location.href,
  topLevel: window === window.top,
});

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
        const response: ContentScriptProbeResultMessage =
          {
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

async function runInitialProbe(): Promise<void> {
  const requestId = createProbeRequestId("content-load");
  const result = await probeTranslator();

  const message: ContentScriptProbeResultMessage = {
    t: "CS_PROBE_RESULT",
    requestId,
    result,
  };

  console.log("[cs]", "initial Translator probe complete", result);

  try {
    const response = (await chrome.runtime.sendMessage(
      message,
    )) as unknown;

    if (
      isMessageOfType(response, "PROBE_STORED") &&
      response.requestId === requestId
    ) {
      console.log("[cs]", "initial probe stored", response);
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
    typeof scope.Translator?.availability !== "function"
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
