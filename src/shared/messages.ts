export const LAST_PROBE_STORAGE_KEY = "m0.lastProbe" as const;

export type TranslatorProbeContext =
  | "offscreen-document"
  | "content-script"
  | "options-page";

export type WebGpuProbeContext =
  | "offscreen-document"
  | "dedicated-worker"
  | "options-page";

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
  availability: BuiltinTranslatorAvailability | null;
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
  context: "content-script" | "options-page";
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

export function nowIso(): string {
  return new Date().toISOString();
}

export function createProbeRequestId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function parseChromeVersion(userAgent: string): string | null {
  const match = userAgent.match(
    /(?:Chrome|Chromium)\/(\d+(?:\.\d+){0,3})/,
  );

  return match?.[1] ?? null;
}

export function getProbeEnvironment(): ProbeEnvironment {
  const userAgent = navigator.userAgent;

  return {
    userAgent,
    chromeVersion: parseChromeVersion(userAgent),
  };
}

export function toProbeError(error: unknown): ProbeError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
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
        "name" in error && typeof error.name === "string"
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

export function isProbeSnapshot(value: unknown): value is ProbeSnapshot {
  return (
    isRecord(value) &&
    typeof value.updatedAt === "string" &&
    (value.offscreen === undefined || isRecord(value.offscreen)) &&
    (value.contentScript === undefined ||
      isRecord(value.contentScript)) &&
    (value.optionsPage === undefined || isRecord(value.optionsPage))
  );
}

export function isM0Message(value: unknown): value is M0Message {
  if (!isRecord(value) || typeof value.t !== "string") {
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
      return value.snapshot === null || isProbeSnapshot(value.snapshot);

    case "PROBE_STORED":
      return (
        typeof value.requestId === "string" &&
        (value.context === "content-script" ||
          value.context === "options-page") &&
        typeof value.storedAt === "string"
      );

    case "PROBE_ERROR":
      return (
        typeof value.requestId === "string" &&
        typeof value.source === "string" &&
        isRecord(value.error) &&
        typeof value.at === "string"
      );

    default:
      return false;
  }
}

export function isMessageOfType<T extends M0Message["t"]>(
  value: unknown,
  type: T,
): value is Extract<M0Message, { t: T }> {
  return isM0Message(value) && value.t === type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
