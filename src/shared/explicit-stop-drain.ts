import type {
  CaptureStatus,
} from "./state";

export const CAPTION_VISIBLE_MS = 5_000;
export const CAPTION_FADE_MS = 350;
export const CUE_MINIMUM_DISPLAY_MS = 1_500;
export const CUE_ACCELERATED_DISPLAY_MS =
  1_000;
export const MAX_WAITING_CUES = 6;

export const CAPTION_DRAIN_WAIT_MS =
  2 * CUE_MINIMUM_DISPLAY_MS +
  MAX_WAITING_CUES *
    2 *
    CUE_ACCELERATED_DISPLAY_MS +
  CAPTION_VISIBLE_MS +
  CAPTION_FADE_MS;

export type ActionClickDisposition =
  | "start"
  | "stop"
  | "ignore";

export function getActionClickDisposition(
  status: CaptureStatus,
): ActionClickDisposition {
  if (isCaptureActiveStatus(status)) {
    return "stop";
  }

  return status === "stopping"
    ? "ignore"
    : "start";
}

export function isExplicitStopReason(
  reason: string,
): boolean {
  return reason === "action-click";
}

export function isCaptureRequestActiveOrDraining(
  status: CaptureStatus,
  captureRequestId: string | undefined,
  drainingRequestId: string | null,
  requestId: string,
): boolean {
  if (captureRequestId !== requestId) {
    return false;
  }

  return (
    isCaptureActiveStatus(status) ||
    (
      status === "stopping" &&
      drainingRequestId === requestId
    )
  );
}

export function isRecognitionRequestCurrent(
  messageRequestId: string | undefined,
  captureRequestId: string | undefined,
): boolean {
  return (
    messageRequestId === undefined ||
    (
      captureRequestId !== undefined &&
      messageRequestId === captureRequestId
    )
  );
}

export function presentCaptionIfAllowed(
  status: CaptureStatus,
  drainingRequestId: string | null,
  present: () => void,
): boolean {
  const allowed =
    isCaptureActiveStatus(status) ||
    (
      status === "stopping" &&
      drainingRequestId !== null
    );

  if (!allowed) {
    return false;
  }

  present();
  return true;
}

function isCaptureActiveStatus(
  status: CaptureStatus,
): boolean {
  return (
    status === "starting" ||
    status === "loadingModel" ||
    status === "running"
  );
}
