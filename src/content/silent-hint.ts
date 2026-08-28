export type SilentInputHintVariant =
  | "paused"
  | "gesture"
  | "unknown";

export type SilentHintTapState =
  | "missing"
  | "starting"
  | "suspended"
  | "running"
  | "stopping"
  | "closed";

export type SilentHintVideoState =
  | "missing"
  | "playing"
  | "paused"
  | "ended";

export interface SilentInputHintState {
  showHint: boolean;
  visible: boolean;
  tap: SilentHintTapState;
  video: SilentHintVideoState;
}

export function resolveSilentInputHint(
  state: SilentInputHintState,
): SilentInputHintVariant | null {
  if (!state.showHint || !state.visible) {
    return null;
  }

  if (
    state.video === "paused" ||
    state.video === "ended"
  ) {
    return "paused";
  }

  if (
    state.video === "playing" &&
    state.tap === "suspended"
  ) {
    return "gesture";
  }

  return "unknown";
}
