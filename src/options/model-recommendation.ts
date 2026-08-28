import type {
  WhisperModel,
} from "../shared/settings";

const NVIDIA_ARCHITECTURES = [
  "turing",
  "ampere",
  "ada",
  "lovelace",
  "blackwell",
] as const;

export function recommendModel(
  info: {
    vendor?: string;
    architecture?: string;
  } | undefined,
  device:
    | "webgpu"
    | "wasm"
    | undefined,
): WhisperModel | null {
  if (
    device === "wasm" ||
    (
      device === undefined &&
      info === undefined
    )
  ) {
    return "tiny";
  }

  if (
    device !== "webgpu" ||
    info?.vendor?.toLowerCase() !==
      "nvidia" ||
    info.architecture === undefined
  ) {
    return null;
  }

  const architecture =
    info.architecture.toLowerCase();

  return NVIDIA_ARCHITECTURES.some(
    (candidate) =>
      architecture.includes(candidate),
  )
    ? "small"
    : null;
}
