export const SETTINGS_STORAGE_KEY =
  "settings" as const;

export const WHISPER_MODELS = [
  "tiny",
  "base",
  "small",
  "turbo",
] as const;

export const SOURCE_LANGUAGES = [
  "auto",
  "en",
] as const;

export type WhisperModel =
  (typeof WHISPER_MODELS)[number];

export type SourceLanguage =
  (typeof SOURCE_LANGUAGES)[number];

export type WhisperDevice =
  | "webgpu"
  | "wasm";

export interface Settings {
  model: WhisperModel;
  sourceLang: SourceLanguage;
  showOriginal: boolean;
  showTentative: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  model: "base",
  sourceLang: "en",
  showOriginal: false,
  showTentative: false,
};

export async function readSettings(): Promise<Settings> {
  const values = await chrome.storage.sync.get(
    SETTINGS_STORAGE_KEY,
  );
  const stored = values[SETTINGS_STORAGE_KEY];

  if (!isRecord(stored)) {
    return { ...DEFAULT_SETTINGS };
  }

  return {
    model: isWhisperModel(stored.model)
      ? stored.model
      : DEFAULT_SETTINGS.model,
    sourceLang: isSourceLanguage(
      stored.sourceLang,
    )
      ? stored.sourceLang
      : DEFAULT_SETTINGS.sourceLang,
    showOriginal:
      typeof stored.showOriginal === "boolean"
        ? stored.showOriginal
        : DEFAULT_SETTINGS.showOriginal,
    showTentative:
      typeof stored.showTentative === "boolean"
        ? stored.showTentative
        : DEFAULT_SETTINGS.showTentative,
  };
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
    isWhisperModel(value.model) &&
    isSourceLanguage(value.sourceLang) &&
    typeof value.showOriginal === "boolean" &&
    typeof value.showTentative === "boolean"
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

export function isSourceLanguage(
  value: unknown,
): value is SourceLanguage {
  return value === "auto" || value === "en";
}

export function isWhisperDevice(
  value: unknown,
): value is WhisperDevice {
  return value === "webgpu" || value === "wasm";
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null
  );
}
