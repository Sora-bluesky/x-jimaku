export const CAPTURE_STATE_STORAGE_KEY =
  "m1.captureState" as const;

export type CaptureStatus =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "error";

export interface CaptureStateError {
  name: string;
  message: string;
  stack?: string;
}

export interface CaptureState {
  status: CaptureStatus;
  updatedAt: string;
  requestId?: string;
  tabId?: number;
  error?: CaptureStateError;
}

export interface CaptureStateDetails {
  requestId?: string;
  tabId?: number;
  error?: CaptureStateError;
}

const ALLOWED_TRANSITIONS: Readonly<
  Record<CaptureStatus, ReadonlySet<CaptureStatus>>
> = {
  idle: new Set(["idle", "starting", "error"]),
  starting: new Set([
    "starting",
    "running",
    "stopping",
    "error",
  ]),
  running: new Set([
    "running",
    "stopping",
    "error",
  ]),
  stopping: new Set([
    "stopping",
    "idle",
    "error",
  ]),
  error: new Set([
    "error",
    "idle",
  ]),
};

export function createCaptureState(
  status: CaptureStatus,
  details: CaptureStateDetails = {},
): CaptureState {
  return {
    status,
    updatedAt: new Date().toISOString(),
    ...(details.requestId === undefined
      ? {}
      : { requestId: details.requestId }),
    ...(details.tabId === undefined
      ? {}
      : { tabId: details.tabId }),
    ...(details.error === undefined
      ? {}
      : { error: details.error }),
  };
}

export function transitionCaptureState(
  current: CaptureState,
  nextStatus: CaptureStatus,
  details: CaptureStateDetails = {},
): CaptureState {
  if (
    !ALLOWED_TRANSITIONS[current.status].has(nextStatus)
  ) {
    throw new Error(
      `Invalid capture transition: ${current.status} -> ${nextStatus}`,
    );
  }

  const preserveSession =
    nextStatus === "starting" ||
    nextStatus === "running" ||
    nextStatus === "stopping";

  const requestId =
    details.requestId ??
    (preserveSession ? current.requestId : undefined);
  const tabId =
    details.tabId ??
    (preserveSession ? current.tabId : undefined);
  const error =
    nextStatus === "error"
      ? details.error ?? current.error
      : undefined;

  return createCaptureState(nextStatus, {
    ...(requestId === undefined ? {} : { requestId }),
    ...(tabId === undefined ? {} : { tabId }),
    ...(error === undefined ? {} : { error }),
  });
}

export function isCaptureState(
  value: unknown,
): value is CaptureState {
  if (!isRecord(value)) {
    return false;
  }

  if (
    !isCaptureStatus(value.status) ||
    typeof value.updatedAt !== "string"
  ) {
    return false;
  }

  if (
    value.requestId !== undefined &&
    typeof value.requestId !== "string"
  ) {
    return false;
  }

  if (
    value.tabId !== undefined &&
    (
      typeof value.tabId !== "number" ||
      !Number.isInteger(value.tabId)
    )
  ) {
    return false;
  }

  return (
    value.error === undefined ||
    isCaptureStateError(value.error)
  );
}

export function isCaptureStatus(
  value: unknown,
): value is CaptureStatus {
  return (
    value === "idle" ||
    value === "starting" ||
    value === "running" ||
    value === "stopping" ||
    value === "error"
  );
}

function isCaptureStateError(
  value: unknown,
): value is CaptureStateError {
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

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
