export const SETTINGS_STORAGE_KEY =
  "settings" as const;

export const WHISPER_MODELS = [
  "tiny",
  "base",
  "small",
  "turbo",
] as const;

export type WhisperModel =
  (typeof WHISPER_MODELS)[number];

export type WhisperDevice =
  | "webgpu"
  | "wasm";

export interface Settings {
  model: WhisperModel;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  model: "base",
};

export async function readSettings(): Promise<Settings> {
  const values = await chrome.storage.sync.get(
    SETTINGS_STORAGE_KEY,
  );
  const stored = values[SETTINGS_STORAGE_KEY];

  return isSettings(stored)
    ? { model: stored.model }
    : { ...DEFAULT_SETTINGS };
}

export async function writeSettings(
  settings: Settings,
): Promise<void> {
  if (!isSettings(settings)) {
    throw new TypeError(
      "Invalid x-jimaku settings",
    );
  }

  await chrome.storage.sync.set({
    [SETTINGS_STORAGE_KEY]: settings,
  });
}

export function isSettings(
  value: unknown,
): value is Settings {
  return (
    isRecord(value) &&
    isWhisperModel(value.model)
  );
}

export function isWhisperModel(
  value: unknown,
): value is WhisperModel {
  return (
    value === "tiny" ||
    value === "base" ||
    value === "small" ||
    value === "turbo"
  );
}

export function isWhisperDevice(
  value: unknown,
): value is WhisperDevice {
  return value === "webgpu" || value === "wasm";
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
