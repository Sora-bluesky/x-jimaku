import {
  isCaptureState,
  type CaptureState,
} from "./state";
import {
  isSettings,
  isSourceLanguage,
  isWhisperDevice,
  isWhisperModel,
  type Settings,
  type SourceLanguage,
  type WhisperDevice,
  type WhisperModel,
} from "./settings";

export {
  isSettings,
};

export const LAST_PROBE_STORAGE_KEY =
  "m0.lastProbe" as const;

export type TranslatorProbeContext =
  | "offscreen-document"
  | "content-script"
  | "options-page";

export type WebGpuProbeContext =
  | "offscreen-document"
  | "dedicated-worker"
  | "options-page";

export type TranslationPath =
  | "offscreen-translator"
  | "content-translator"
  | "language-model"
  | "none";

export interface ProbeError {
  name: string;
  message: string;
  stack?: string;
}

export interface ProbeEnvironment {
  userAgent: string;
  chromeVersion: string | null;
}

export interface AdapterInfo {
  vendor?: string;
  architecture?: string;
}

export interface WebGpuProbeResult {
  context: WebGpuProbeContext;
  apiAvailable: boolean;
  adapterAvailable: boolean;
  adapterInfo?: AdapterInfo;
  startedAt: string;
  completedAt: string;
  environment: ProbeEnvironment;
  error?: ProbeError;
}

export interface TranslatorProbeResult {
  context: TranslatorProbeContext;
  exposed: boolean;
  availability:
    | BuiltinTranslatorAvailability
    | null;
  startedAt: string;
  completedAt: string;
  environment: ProbeEnvironment;
  error?: ProbeError;
}

export interface OffscreenProbeResult {
  context: "offscreen-document";
  requestId: string;
  startedAt: string;
  completedAt: string;
  environment: ProbeEnvironment;
  webgpu: {
    document: WebGpuProbeResult;
    worker: WebGpuProbeResult;
  };
  translator: TranslatorProbeResult;
}

export interface OptionsPageProbeResult {
  context: "options-page";
  requestId: string;
  startedAt: string;
  completedAt: string;
  environment: ProbeEnvironment;
  webgpu: WebGpuProbeResult;
  translator: TranslatorProbeResult;
}

export interface ProbeSnapshot {
  offscreen?: OffscreenProbeResult;
  contentScript?: TranslatorProbeResult;
  optionsPage?: OptionsPageProbeResult;
  updatedAt: string;
}

export interface ProbeRequest {
  t: "PROBE";
  requestId: string;
}

export interface OffscreenProbeResultMessage {
  t: "OFFSCREEN_PROBE_RESULT";
  requestId: string;
  result: OffscreenProbeResult;
}

export interface ContentScriptProbeResultMessage {
  t: "CS_PROBE_RESULT";
  requestId: string;
  result: TranslatorProbeResult;
}

export interface OptionsPageProbeResultMessage {
  t: "OPTIONS_PROBE_RESULT";
  requestId: string;
  result: OptionsPageProbeResult;
}

export interface GetLastProbeMessage {
  t: "GET_LAST_PROBE";
}

export interface LastProbeResultMessage {
  t: "LAST_PROBE_RESULT";
  snapshot: ProbeSnapshot | null;
}

export interface ProbeStoredMessage {
  t: "PROBE_STORED";
  requestId: string;
  context:
    | "content-script"
    | "options-page";
  storedAt: string;
}

export interface ProbeFailureMessage {
  t: "PROBE_ERROR";
  requestId: string;
  source:
    | "background"
    | "offscreen"
    | "content-script"
    | "options-page"
    | "worker";
  error: ProbeError;
  at: string;
}

export interface WorkerProbeRequest {
  t: "WORKER_PROBE";
  requestId: string;
}

export interface WorkerProbeResultMessage {
  t: "WORKER_PROBE_RESULT";
  requestId: string;
  result: WebGpuProbeResult;
}

export interface RunDiagnosticsMessage {
  t: "RUN_DIAGNOSTICS";
  requestId: string;
}

export interface DiagnosticsResultMessage {
  t: "DIAGNOSTICS_RESULT";
  requestId: string;
  snapshot: ProbeSnapshot;
}

export interface CsPingMessage {
  t: "CS_PING";
}

export interface CsPongMessage {
  t: "CS_PONG";
}

export interface OffStartMessage {
  t: "OFF_START";
  requestId: string;
  settings: Settings;
}

export interface OffStopMessage {
  t: "OFF_STOP";
  requestId: string;
}

export interface OffQueryMessage {
  t: "OFF_QUERY";
  queryId: string;
}

export interface OffStatusMessage {
  t: "OFF_STATUS";
  queryId: string;
  state: CaptureState;
  sessionActive: boolean;
}

export interface OffStateMessage {
  t: "OFF_STATE";
  state: CaptureState;
}

export interface OffLevelMessage {
  t: "OFF_LEVEL";
  rms: number;
  at: string;
}

export interface CsStartTapMessage {
  t: "CS_START_TAP";
  requestId: string;
  settings?: Settings;
}

export interface CsStopTapMessage {
  t: "CS_STOP_TAP";
  requestId: string;
}

export interface CsTapStateMessage {
  t: "CS_TAP_STATE";
  requestId: string;
  state:
    | "tapping"
    | "stopped"
    | "error";
  detail?: string;
}

export interface CsPcmMessage {
  t: "CS_PCM";
  requestId: string;
  seq: number;
  b64: string;
}

export interface CsTranslateMessage {
  t: "CS_TRANSLATE";
  requestId: string;
  id: string;
  text: string;
}

export interface CsTranslateResultMessage {
  t: "CS_TRANSLATE_RESULT";
  requestId: string;
  id: string;
  ja: string;
  available: boolean;
  error?: ProbeError;
}

export interface OffTranslationStateMessage {
  t: "OFF_TRANSLATION_STATE";
  requestId: string;
  path: TranslationPath;
}

export interface SwTranslationStateMessage {
  t: "SW_TRANSLATION_STATE";
  requestId: string;
  path: TranslationPath;
}

export interface RecognitionPayload {
  id: number;
  text: string;
  final: boolean;
  at: string;
  ja?: string;
}

export interface OffRecognitionMessage
  extends RecognitionPayload {
  t: "OFF_RECOG";
}

export interface SwRecognitionMessage
  extends RecognitionPayload {
  t: "SW_RECOG";
}

export interface SwCaptionMessage
  extends RecognitionPayload {
  t: "SW_CAPTION";
}

export interface SwCaptionClearMessage {
  t: "SW_CAPTION_CLEAR";
}

export interface WhisperInitMessage {
  t: "WHISPER_INIT";
  model: WhisperModel;
  ortBaseUrl: string;
  sourceLang: SourceLanguage;
  forceDevice?: WhisperDevice;
}

export interface WhisperTranscribeMessage {
  t: "WHISPER_TRANSCRIBE";
  requestId: string;
  audio: Float32Array;
}

export interface WhisperProgressMessage {
  t: "WHISPER_PROGRESS";
  file: string;
  progress: number;
  loaded: number;
  total: number;
}

export interface WhisperReadyMessage {
  t: "WHISPER_READY";
  device: WhisperDevice;
}

export interface WhisperResultMessage {
  t: "WHISPER_RESULT";
  requestId: string;
  text: string;
}

export interface WhisperErrorMessage {
  t: "WHISPER_ERROR";
  requestId?: string;
  message: string;
  fatal: boolean;
  attemptedDevice?: WhisperDevice;
}

export type WhisperWorkerInputMessage =
  | WhisperInitMessage
  | WhisperTranscribeMessage;

export type WhisperWorkerOutputMessage =
  | WhisperProgressMessage
  | WhisperReadyMessage
  | WhisperResultMessage
  | WhisperErrorMessage;

export type M0Message =
  | ProbeRequest
  | OffscreenProbeResultMessage
  | ContentScriptProbeResultMessage
  | OptionsPageProbeResultMessage
  | GetLastProbeMessage
  | LastProbeResultMessage
  | ProbeStoredMessage
  | ProbeFailureMessage
  | WorkerProbeRequest
  | WorkerProbeResultMessage;

export type CaptionPortMessage =
  | SwCaptionMessage
  | SwCaptionClearMessage;

export type ContentPortMessage =
  | CsStartTapMessage
  | CsStopTapMessage
  | CsTapStateMessage
  | CsPcmMessage
  | CsTranslateMessage
  | CsTranslateResultMessage
  | OffStateMessage
  | SwTranslationStateMessage
  | CaptionPortMessage;

export type CapturePortMessage =
  | OffStartMessage
  | OffStopMessage
  | OffQueryMessage
  | OffStatusMessage
  | OffStateMessage
  | OffLevelMessage
  | OffRecognitionMessage
  | OffTranslationStateMessage
  | CsPcmMessage
  | CsTranslateMessage
  | CsTranslateResultMessage;

export type OptionsPortMessage =
  | OffStateMessage
  | OffLevelMessage
  | SwRecognitionMessage
  | SwTranslationStateMessage
  | CsTapStateMessage;

export type M1Message =
  | M0Message
  | RunDiagnosticsMessage
  | DiagnosticsResultMessage
  | CsPingMessage
  | CsPongMessage
  | CapturePortMessage
  | ContentPortMessage
  | SwRecognitionMessage
  | SwTranslationStateMessage
  | CaptionPortMessage;

export function nowIso(): string {
  return new Date().toISOString();
}

export function createProbeRequestId(
  prefix: string,
): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function parseChromeVersion(
  userAgent: string,
): string | null {
  const match = userAgent.match(
    /(?:Chrome|Chromium)\/(\d+(?:\.\d+){0,3})/,
  );

  return match?.[1] ?? null;
}

export function getProbeEnvironment(): ProbeEnvironment {
  const userAgent = navigator.userAgent;

  return {
    userAgent,
    chromeVersion: parseChromeVersion(
      userAgent,
    ),
  };
}

export function toProbeError(
  error: unknown,
): ProbeError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined
        ? {}
        : { stack: error.stack }),
    };
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return {
      name:
        "name" in error &&
        typeof error.name === "string"
          ? error.name
          : "Error",
      message: error.message,
    };
  }

  return {
    name: "Error",
    message: String(error),
  };
}

export function isProbeSnapshot(
  value: unknown,
): value is ProbeSnapshot {
  return (
    isRecord(value) &&
    typeof value.updatedAt === "string" &&
    (
      value.offscreen === undefined ||
      isRecord(value.offscreen)
    ) &&
    (
      value.contentScript === undefined ||
      isRecord(value.contentScript)
    ) &&
    (
      value.optionsPage === undefined ||
      isRecord(value.optionsPage)
    )
  );
}

export function isM0Message(
  value: unknown,
): value is M0Message {
  if (
    !isRecord(value) ||
    typeof value.t !== "string"
  ) {
    return false;
  }

  switch (value.t) {
    case "PROBE":
    case "WORKER_PROBE":
      return typeof value.requestId === "string";

    case "OFFSCREEN_PROBE_RESULT":
    case "CS_PROBE_RESULT":
    case "OPTIONS_PROBE_RESULT":
    case "WORKER_PROBE_RESULT":
      return (
        typeof value.requestId === "string" &&
        isRecord(value.result)
      );

    case "GET_LAST_PROBE":
      return true;

    case "LAST_PROBE_RESULT":
      return (
        value.snapshot === null ||
        isProbeSnapshot(value.snapshot)
      );

    case "PROBE_STORED":
      return (
        typeof value.requestId === "string" &&
        (
          value.context === "content-script" ||
          value.context === "options-page"
        ) &&
        typeof value.storedAt === "string"
      );

    case "PROBE_ERROR":
      return (
        typeof value.requestId === "string" &&
        typeof value.source === "string" &&
        isProbeError(value.error) &&
        typeof value.at === "string"
      );

    default:
      return false;
  }
}

export function isM1Message(
  value: unknown,
): value is M1Message {
  if (isM0Message(value)) {
    return true;
  }

  if (
    !isRecord(value) ||
    typeof value.t !== "string"
  ) {
    return false;
  }

  switch (value.t) {
    case "RUN_DIAGNOSTICS":
      return typeof value.requestId === "string";

    case "DIAGNOSTICS_RESULT":
      return (
        typeof value.requestId === "string" &&
        isProbeSnapshot(value.snapshot)
      );

    case "CS_PING":
    case "CS_PONG":
      return true;

    case "OFF_START":
      return (
        typeof value.requestId === "string" &&
        isSettings(value.settings)
      );

    case "OFF_STOP":
    case "CS_STOP_TAP":
      return typeof value.requestId === "string";

    case "OFF_QUERY":
      return typeof value.queryId === "string";

    case "OFF_STATUS":
      return (
        typeof value.queryId === "string" &&
        isCaptureState(value.state) &&
        typeof value.sessionActive ===
          "boolean"
      );

    case "OFF_STATE":
      return isCaptureState(value.state);

    case "OFF_LEVEL":
      return (
        typeof value.rms === "number" &&
        Number.isFinite(value.rms) &&
        value.rms >= 0 &&
        typeof value.at === "string"
      );

    case "CS_START_TAP":
      return (
        typeof value.requestId === "string" &&
        (
          value.settings === undefined ||
          isSettings(value.settings)
        )
      );

    case "CS_TAP_STATE":
      return (
        typeof value.requestId === "string" &&
        (
          value.state === "tapping" ||
          value.state === "stopped" ||
          value.state === "error"
        ) &&
        (
          value.detail === undefined ||
          typeof value.detail === "string"
        )
      );

    case "CS_PCM":
      return (
        typeof value.requestId === "string" &&
        typeof value.seq === "number" &&
        Number.isSafeInteger(value.seq) &&
        value.seq >= 0 &&
        typeof value.b64 === "string"
      );

    case "CS_TRANSLATE":
      return (
        typeof value.requestId === "string" &&
        typeof value.id === "string" &&
        typeof value.text === "string"
      );

    case "CS_TRANSLATE_RESULT":
      return (
        typeof value.requestId === "string" &&
        typeof value.id === "string" &&
        typeof value.ja === "string" &&
        typeof value.available === "boolean" &&
        (
          value.error === undefined ||
          isProbeError(value.error)
        )
      );

    case "OFF_TRANSLATION_STATE":
    case "SW_TRANSLATION_STATE":
      return (
        typeof value.requestId === "string" &&
        isTranslationPath(value.path)
      );

    case "OFF_RECOG":
    case "SW_RECOG":
    case "SW_CAPTION":
      return isRecognitionPayload(value);

    case "SW_CAPTION_CLEAR":
      return true;

    default:
      return false;
  }
}

export function isMessageOfType<
  T extends M1Message["t"],
>(
  value: unknown,
  type: T,
): value is Extract<M1Message, { t: T }> {
  return isM1Message(value) && value.t === type;
}

export function isCapturePortMessage(
  value: unknown,
): value is CapturePortMessage {
  return (
    isMessageOfType(value, "OFF_START") ||
    isMessageOfType(value, "OFF_STOP") ||
    isMessageOfType(value, "OFF_QUERY") ||
    isMessageOfType(value, "OFF_STATUS") ||
    isMessageOfType(value, "OFF_STATE") ||
    isMessageOfType(value, "OFF_LEVEL") ||
    isMessageOfType(value, "OFF_RECOG") ||
    isMessageOfType(
      value,
      "OFF_TRANSLATION_STATE",
    ) ||
    isMessageOfType(value, "CS_PCM") ||
    isMessageOfType(value, "CS_TRANSLATE") ||
    isMessageOfType(
      value,
      "CS_TRANSLATE_RESULT",
    )
  );
}

export function isContentPortMessage(
  value: unknown,
): value is ContentPortMessage {
  return (
    isMessageOfType(value, "CS_START_TAP") ||
    isMessageOfType(value, "CS_STOP_TAP") ||
    isMessageOfType(value, "CS_TAP_STATE") ||
    isMessageOfType(value, "CS_PCM") ||
    isMessageOfType(value, "CS_TRANSLATE") ||
    isMessageOfType(
      value,
      "CS_TRANSLATE_RESULT",
    ) ||
    isMessageOfType(value, "OFF_STATE") ||
    isMessageOfType(
      value,
      "SW_TRANSLATION_STATE",
    ) ||
    isMessageOfType(value, "SW_CAPTION") ||
    isMessageOfType(
      value,
      "SW_CAPTION_CLEAR",
    )
  );
}

export function isWhisperWorkerInputMessage(
  value: unknown,
): value is WhisperWorkerInputMessage {
  if (
    !isRecord(value) ||
    typeof value.t !== "string"
  ) {
    return false;
  }

  switch (value.t) {
    case "WHISPER_INIT":
      return (
        isWhisperModel(value.model) &&
        typeof value.ortBaseUrl === "string" &&
        isSourceLanguage(value.sourceLang) &&
        (
          value.forceDevice === undefined ||
          isWhisperDevice(value.forceDevice)
        )
      );

    case "WHISPER_TRANSCRIBE":
      return (
        typeof value.requestId === "string" &&
        value.audio instanceof Float32Array
      );

    default:
      return false;
  }
}

export function isWhisperWorkerOutputMessage(
  value: unknown,
): value is WhisperWorkerOutputMessage {
  if (
    !isRecord(value) ||
    typeof value.t !== "string"
  ) {
    return false;
  }

  switch (value.t) {
    case "WHISPER_PROGRESS":
      return (
        typeof value.file === "string" &&
        isFiniteNonNegative(value.progress) &&
        value.progress <= 100 &&
        isFiniteNonNegative(value.loaded) &&
        isFiniteNonNegative(value.total)
      );

    case "WHISPER_READY":
      return isWhisperDevice(value.device);

    case "WHISPER_RESULT":
      return (
        typeof value.requestId === "string" &&
        typeof value.text === "string"
      );

    case "WHISPER_ERROR":
      return (
        (
          value.requestId === undefined ||
          typeof value.requestId === "string"
        ) &&
        typeof value.message === "string" &&
        typeof value.fatal === "boolean" &&
        (
          value.attemptedDevice === undefined ||
          isWhisperDevice(
            value.attemptedDevice,
          )
        )
      );

    default:
      return false;
  }
}

export function isTranslationPath(
  value: unknown,
): value is TranslationPath {
  return (
    value === "offscreen-translator" ||
    value === "content-translator" ||
    value === "language-model" ||
    value === "none"
  );
}

function isRecognitionPayload(
  value: Record<string, unknown>,
): boolean {
  return (
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    value.id >= 0 &&
    typeof value.text === "string" &&
    typeof value.final === "boolean" &&
    typeof value.at === "string" &&
    (
      value.ja === undefined ||
      typeof value.ja === "string"
    )
  );
}

function isProbeError(
  value: unknown,
): value is ProbeError {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.message === "string" &&
    (
      value.stack === undefined ||
      typeof value.stack === "string"
    )
  );
}

function isFiniteNonNegative(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
  );
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null
  );
}
