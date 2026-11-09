import {
  type CsMediaChangedMessage,
} from "../shared/messages";
import {
  type CaptureState,
} from "../shared/state";

interface MediaChangeTracker {
  mediaChanged(requestId: string): void;
}

export function handleContentMediaChanged(
  captureState: CaptureState,
  tracker: MediaChangeTracker,
  tabId: number,
  message: CsMediaChangedMessage,
): void {
  if (
    captureState.status !== "running" ||
    captureState.tabId !== tabId ||
    captureState.requestId !==
      message.requestId
  ) {
    return;
  }

  tracker.mediaChanged(message.requestId);
}
