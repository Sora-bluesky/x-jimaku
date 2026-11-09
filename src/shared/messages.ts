import { isLatencyTrace, type LatencyTrace } from "./latency-trace";
import { PLAMO_CONTEXT_TOKENS, isPlamoModel, type PlamoModel } from "./plamo-models";
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

export const MAX_CONTEXT_TERMS = 40;

export type WebGpuProbeContext =
  | "offscreen-document"
  | "dedicated-worker"
  | "options-page";

export type TranslationPath = "plamo" | "none";

export type TranslationRung = "plamo" | "passthrough";

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
}

export interface ProbeSnapshot {
  offscreen?: OffscreenProbeResult;
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

export interface GetLastProbeMessage {
  t: "GET_LAST_PROBE";
}

export interface LastProbeResultMessage {
  t: "LAST_PROBE_RESULT";
  snapshot: ProbeSnapshot | null;
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

export interface CsDevToggleMessage {
  t: "CS_DEV_TOGGLE";
}

export interface CsDevSetSettingsMessage {
  t: "CS_DEV_SET_SETTINGS";
  settings: Record<string, unknown>;
}

export interface OffStartMessage {
  t: "OFF_START";
  requestId: string;
  settings: Settings;
}

export interface OffStopMessage {
  t: "OFF_STOP";
  requestId: string;
  drain?: boolean;
}

export interface OffDrainReadyMessage {
  t: "OFF_DRAIN_READY";
  requestId: string;
}

export interface OffFlushRecogMessage {
  t: "OFF_FLUSH_RECOG";
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
  drain?: boolean;
}

export interface OffLevelMessage {
  t: "OFF_LEVEL";
  rms: number;
  at: string;
}

export interface OffDiagnosticMessage {
  t: "OFF_DIAGNOSTIC";
  kind:
    | "unhandled-error"
    | "unhandled-rejection";
  at: string;
  context: "offscreen";
  message: string;
  stack?: string;
}

export type OffDevLogKind =
  | "latency"
  | "passthrough"
  | "queue-drop"
  | "clause-timing"
  | "plamo-stage"
  | "asr-timing";

export type ClauseTimingOutcome =
  | "translated"
  | "fallback";

export interface PlamoStage {
  id: number;
  stage: "received" | "completion-start" | "proxy-sent" | "proxy-answered" | "completion-end" | "catch" | "recovery-start" | "recovery-end";
  atMs: number;
  action?: string;
  actionId?: number;
  hasMore?: boolean;
  responseBytes?: number;
  failed?: boolean;
}

export interface PlamoDiagnostic {
  stageRecord?: PlamoStage;
  workerAnswered?: boolean;
  elapsedMs?: number;
}

function isPlamoStage(value: unknown): value is PlamoStage {
  return isRecord(value) && Number.isSafeInteger(value.id) && isFiniteNonNegative(value.id)
    && ["received", "completion-start", "proxy-sent", "proxy-answered", "completion-end", "catch", "recovery-start", "recovery-end"].includes(String(value.stage))
    && isFiniteNonNegative(value.atMs)
    && (value.action === undefined || typeof value.action === "string")
    && (value.actionId === undefined || (Number.isSafeInteger(value.actionId) && isFiniteNonNegative(value.actionId)))
    && (value.hasMore === undefined || typeof value.hasMore === "boolean")
    && (value.responseBytes === undefined || isFiniteNonNegative(value.responseBytes))
    && (value.failed === undefined || typeof value.failed === "boolean");
}

export interface PlamoCompletionMetrics {
  finish_reason?: "stop" | "length" | "content_filter" | null;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  timings?: { cache_n: number; prompt_n: number; prompt_ms: number; prompt_per_token_ms: number; prompt_per_second: number; predicted_n: number; predicted_ms: number; predicted_per_token_ms: number; predicted_per_second: number };
  workerWallMs?: number;
}

function isPlamoCompletionMetrics(value: Record<string, unknown>): boolean {
  return (value.finish_reason === undefined || value.finish_reason === null || value.finish_reason === "stop" || value.finish_reason === "length" || value.finish_reason === "content_filter")
    && (value.usage === undefined || (isRecord(value.usage) && ["prompt_tokens", "completion_tokens", "total_tokens"].every(key => isFiniteNonNegative((value.usage as Record<string, unknown>)[key]))))
    && (value.timings === undefined || (isRecord(value.timings) && ["cache_n", "prompt_n", "prompt_ms", "prompt_per_token_ms", "prompt_per_second", "predicted_n", "predicted_ms", "predicted_per_token_ms", "predicted_per_second"].every(key => isFiniteNonNegative((value.timings as Record<string, unknown>)[key]))))
    && (value.workerWallMs === undefined || isFiniteNonNegative(value.workerWallMs));
}

export interface OffDevLogData extends PlamoCompletionMetrics, PlamoDiagnostic {
  trace?: LatencyTrace;
  kind: OffDevLogKind;
  requestId: string;
  lineId: number;
  text?: string;
  path?: TranslationPath;
  outcome?: ClauseTimingOutcome;
  enqueueToTerminalMs?: number;
  modelCallMs?: number;
  deadlineExpired?: boolean;
  inferenceId?: string;
  startedAtMs?: number;
  endedAtMs?: number;
  failed?: boolean;
}

export interface OffDevLogMessage {
  t: "OFF_DEV_LOG";
  level: "info" | "warn" | "error";
  tag: string;
  message: string;
  data?: OffDevLogData;
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

export interface CsDrainCompleteMessage {
  t: "CS_DRAIN_COMPLETE";
  requestId: string;
}

export interface CsEosMessage {
  t: "CS_EOS";
  requestId: string;
}

export interface CsMediaChangedMessage {
  t: "CS_MEDIA_CHANGED";
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
  contextTerms?: string[];
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

export interface SwSilentInputMessage {
  t: "SW_SILENT_INPUT";
  requestId: string;
  showHint: boolean;
}

export interface RecognitionPayload {
  clauseIds?: string[];
  id: number;
  text: string;
  final: boolean;
  at: string;
  ja?: string;
  fallback?: boolean;
  rung?: TranslationRung;
}

export interface OffRecognitionMessage
  extends RecognitionPayload {
  t: "OFF_RECOG";
  requestId?: string;
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

export type PlamoWorkerInputMessage =
  | { t: "PLAMO_INIT"; model: PlamoModel }
  | { t: "PLAMO_TRANSLATE"; id: number; prompt: string; maxTokens?: number };

export type PlamoWorkerOutputMessage =
  | { t: "PLAMO_STAGE"; record: PlamoStage }
  | { t: "PLAMO_PROGRESS"; loaded: number; total: number; phase?: "download" | "hash" }
  | { t: "PLAMO_READY"; model: PlamoModel; loadMs: number; layersOffloaded?: number }
  | ({ t: "PLAMO_RESULT"; id: number; text: string } & PlamoCompletionMetrics)
  | { t: "PLAMO_ERROR"; id?: number; message: string; fatal: boolean; recovered?: boolean };

export function isPlamoWorkerInputMessage(value: unknown): value is PlamoWorkerInputMessage {
  if (!isRecord(value)) return false;
  switch (value.t) {
    case "PLAMO_INIT": return isPlamoModel(value.model);
    case "PLAMO_TRANSLATE": return Number.isSafeInteger(value.id) && isFiniteNonNegative(value.id)
      && typeof value.prompt === "string"
      && (value.maxTokens === undefined || (Number.isInteger(value.maxTokens) && typeof value.maxTokens === "number" && value.maxTokens >= 1 && value.maxTokens <= PLAMO_CONTEXT_TOKENS));
    default: return false;
  }
}

export function isPlamoWorkerOutputMessage(value: unknown): value is PlamoWorkerOutputMessage {
  if (!isRecord(value)) return false;
  switch (value.t) {
    case "PLAMO_STAGE": return isPlamoStage(value.record);
    case "PLAMO_PROGRESS": return isFiniteNonNegative(value.loaded) && isFiniteNonNegative(value.total)
      && (value.phase === undefined || value.phase === "download" || value.phase === "hash");
    case "PLAMO_READY": return isPlamoModel(value.model) && isFiniteNonNegative(value.loadMs)
      && (value.layersOffloaded === undefined || isFiniteNonNegative(value.layersOffloaded));
    case "PLAMO_RESULT": return Number.isSafeInteger(value.id) && isFiniteNonNegative(value.id) && typeof value.text === "string" && isPlamoCompletionMetrics(value);
    case "PLAMO_ERROR": return typeof value.message === "string" && typeof value.fatal === "boolean"
      && (value.id === undefined || (Number.isSafeInteger(value.id) && isFiniteNonNegative(value.id)))
      && (value.recovered === undefined || typeof value.recovered === "boolean");
    default: return false;
  }
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
  finalizedAtMs?: number;
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
  | { t: "WHISPER_TIMING"; requestId: string; startedAtMs: number; endedAtMs: number; failed: boolean }
  | WhisperProgressMessage
  | WhisperReadyMessage
  | WhisperResultMessage
  | WhisperErrorMessage;

export type M0Message =
  | ProbeRequest
  | OffscreenProbeResultMessage
  | GetLastProbeMessage
  | LastProbeResultMessage
  | ProbeFailureMessage
  | WorkerProbeRequest
  | WorkerProbeResultMessage;

export type CaptionPortMessage =
  | SwCaptionMessage
  | SwCaptionClearMessage;

export type ContentPortMessage =
  | CsStartTapMessage
  | CsStopTapMessage
  | CsDrainCompleteMessage
  | CsEosMessage
  | CsMediaChangedMessage
  | CsTapStateMessage
  | CsPcmMessage
  | OffDevLogMessage
  | OffStateMessage
  | OffDrainReadyMessage
  | SwTranslationStateMessage
  | SwSilentInputMessage
  | CaptionPortMessage;

export type CapturePortMessage =
  | OffStartMessage
  | OffStopMessage
  | OffDrainReadyMessage
  | OffFlushRecogMessage
  | OffQueryMessage
  | OffStatusMessage
  | OffStateMessage
  | OffLevelMessage
  | OffDiagnosticMessage
  | OffDevLogMessage
  | OffRecognitionMessage
  | OffTranslationStateMessage
  | CsDrainCompleteMessage
  | CsPcmMessage
  | CsEosMessage;

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
  | CsDevToggleMessage
  | CsDevSetSettingsMessage
  | CapturePortMessage
  | ContentPortMessage
  | SwRecognitionMessage
  | SwTranslationStateMessage
  | SwSilentInputMessage
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
    case "CS_DEV_TOGGLE":
      return true;

    case "CS_DEV_SET_SETTINGS":
      return isRecord(value.settings);

    case "OFF_START":
      return (
        typeof value.requestId === "string" &&
        isSettings(value.settings)
      );

    case "OFF_STOP":
      return (
        typeof value.requestId === "string" &&
        (
          value.drain === undefined ||
          typeof value.drain === "boolean"
        )
      );

    case "OFF_DRAIN_READY":
    case "OFF_FLUSH_RECOG":
    case "CS_STOP_TAP":
    case "CS_DRAIN_COMPLETE":
    case "CS_EOS":
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
      return (
        isCaptureState(value.state) &&
        (
          value.drain === undefined ||
          typeof value.drain === "boolean"
        )
      );

    case "OFF_LEVEL":
      return (
        typeof value.rms === "number" &&
        Number.isFinite(value.rms) &&
        value.rms >= 0 &&
        typeof value.at === "string"
      );

    case "OFF_DIAGNOSTIC":
      return (
        (
          value.kind === "unhandled-error" ||
          value.kind ===
            "unhandled-rejection"
        ) &&
        typeof value.at === "string" &&
        value.context === "offscreen" &&
        typeof value.message === "string" &&
        (
          value.stack === undefined ||
          typeof value.stack === "string"
        )
      );

    case "OFF_DEV_LOG":
      return (
        (
          value.level === "info" ||
          value.level === "warn" ||
          value.level === "error"
        ) &&
        typeof value.tag === "string" &&
        typeof value.message === "string" &&
        (
          value.data === undefined ||
          (
            isRecord(value.data) &&
            isPlamoCompletionMetrics(value.data) &&
            (value.data.kind !== "latency" || isLatencyTrace(value.data.trace)) &&
            (value.data.kind !== "plamo-stage" || (
              (value.data.stageRecord === undefined || isPlamoStage(value.data.stageRecord)) &&
              (value.data.workerAnswered === undefined || typeof value.data.workerAnswered === "boolean") &&
              (value.data.elapsedMs === undefined || isFiniteNonNegative(value.data.elapsedMs))
            )) &&
            (value.data.kind !== "asr-timing" || (
              typeof value.data.inferenceId === "string" && isFiniteNonNegative(value.data.startedAtMs) &&
              isFiniteNonNegative(value.data.endedAtMs) && value.data.endedAtMs >= value.data.startedAtMs && typeof value.data.failed === "boolean"
            )) &&
            (
              value.data.kind ===
                "queue-drop" ||
              value.data.kind === "latency" ||
              value.data.kind === "plamo-stage" ||
              value.data.kind === "asr-timing" ||
              value.data.kind ===
                "clause-timing"
            ) &&
            typeof value.data.requestId ===
              "string" &&
            typeof value.data.lineId ===
              "number" &&
            Number.isSafeInteger(
              value.data.lineId,
            ) &&
            value.data.lineId >= 0 &&
            (
              value.data.text === undefined ||
              typeof value.data.text ===
                "string"
            ) &&
            (
              value.data.path === undefined ||
              isTranslationPath(
                value.data.path,
              )
            ) &&
            (
              value.data.kind !==
                "clause-timing" ||
              (
                isTranslationPath(
                  value.data.path,
                ) &&
                (
                  value.data.outcome ===
                    "translated" ||
                  value.data.outcome ===
                    "fallback"
                ) &&
                typeof value.data
                  .enqueueToTerminalMs ===
                  "number" &&
                Number.isFinite(
                  value.data
                    .enqueueToTerminalMs,
                ) &&
                value.data
                  .enqueueToTerminalMs >= 0 &&
                typeof value.data.modelCallMs ===
                  "number" &&
                Number.isFinite(
                  value.data.modelCallMs,
                ) &&
                value.data.modelCallMs >= 0 &&
                value.data.modelCallMs <=
                  value.data
                    .enqueueToTerminalMs &&
                typeof value.data
                  .deadlineExpired ===
                  "boolean" &&
                (
                  !value.data
                    .deadlineExpired ||
                  value.data.outcome ===
                    "fallback"
                )
              )
            )
          )
        )
      );

    case "CS_START_TAP":
      return (
        typeof value.requestId === "string" &&
        (
          value.settings === undefined ||
          isSettings(value.settings)
        )
      );

    case "CS_MEDIA_CHANGED":
      return typeof value.requestId === "string";

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
        typeof value.b64 === "string" &&
        (
          value.contextTerms === undefined ||
          isContextTerms(value.contextTerms)
        )
      );

    case "OFF_TRANSLATION_STATE":
    case "SW_TRANSLATION_STATE":
      return (
        typeof value.requestId === "string" &&
        isTranslationPath(value.path)
      );

    case "SW_SILENT_INPUT":
      return (
        typeof value.requestId === "string" &&
        typeof value.showHint === "boolean"
      );

    case "OFF_RECOG":
      return (
        isRecognitionPayload(value) &&
        (
          value.requestId === undefined ||
          typeof value.requestId === "string"
        )
      );

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
    isMessageOfType(
      value,
      "OFF_DRAIN_READY",
    ) ||
    isMessageOfType(
      value,
      "OFF_FLUSH_RECOG",
    ) ||
    isMessageOfType(value, "OFF_QUERY") ||
    isMessageOfType(value, "OFF_STATUS") ||
    isMessageOfType(value, "OFF_STATE") ||
    isMessageOfType(value, "OFF_LEVEL") ||
    isMessageOfType(
      value,
      "OFF_DIAGNOSTIC",
    ) ||
    isMessageOfType(
      value,
      "OFF_DEV_LOG",
    ) ||
    isMessageOfType(value, "OFF_RECOG") ||
    isMessageOfType(
      value,
      "OFF_TRANSLATION_STATE",
    ) ||
    isMessageOfType(
      value,
      "CS_DRAIN_COMPLETE",
    ) ||
    isMessageOfType(value, "CS_PCM") ||
    isMessageOfType(value, "CS_EOS")
  );
}

export function isContentPortMessage(
  value: unknown,
): value is ContentPortMessage {
  return (
    isMessageOfType(value, "CS_START_TAP") ||
    isMessageOfType(value, "CS_STOP_TAP") ||
    isMessageOfType(
      value,
      "CS_DRAIN_COMPLETE",
    ) ||
    isMessageOfType(value, "CS_EOS") ||
    isMessageOfType(
      value,
      "CS_MEDIA_CHANGED",
    ) ||
    isMessageOfType(value, "CS_TAP_STATE") ||
    isMessageOfType(value, "CS_PCM") ||
    isMessageOfType(
      value,
      "OFF_DEV_LOG",
    ) ||
    isMessageOfType(value, "OFF_STATE") ||
    isMessageOfType(
      value,
      "OFF_DRAIN_READY",
    ) ||
    isMessageOfType(
      value,
      "SW_TRANSLATION_STATE",
    ) ||
    isMessageOfType(
      value,
      "SW_SILENT_INPUT",
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
    case "WHISPER_TIMING":
      return typeof value.requestId === "string" && isFiniteNonNegative(value.startedAtMs) && isFiniteNonNegative(value.endedAtMs) && value.endedAtMs >= value.startedAtMs && typeof value.failed === "boolean";

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
        (value.finalizedAtMs === undefined || isFiniteNonNegative(value.finalizedAtMs)) &&
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
  return value === "plamo" || value === "none";
}

export function isTranslationRung(
  value: unknown,
): value is TranslationRung {
  return value === "plamo" || value === "passthrough";
}

function isRecognitionPayload(
  value: Record<string, unknown>,
): boolean {
  return (
    (value.clauseIds === undefined || (Array.isArray(value.clauseIds) && value.clauseIds.every(id => typeof id === "string"))) &&
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    value.id >= 0 &&
    typeof value.text === "string" &&
    typeof value.final === "boolean" &&
    typeof value.at === "string" &&
    (
      value.ja === undefined ||
      typeof value.ja === "string"
    ) &&
    (
      value.fallback === undefined ||
      typeof value.fallback === "boolean"
    ) &&
    (
      value.rung === undefined ||
      isTranslationRung(value.rung)
    )
  );
}

function isContextTerms(
  value: unknown,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_CONTEXT_TERMS &&
    value.every(
      (term: unknown) =>
        typeof term === "string" &&
        term.trim() === term &&
        Array.from(term).length >= 4 &&
        Array.from(term).length <= 128,
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
