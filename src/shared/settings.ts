import { isPlamoModel, type PlamoModel } from "./plamo-models";
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

export const TRANSLATION_BACKENDS = ["plamo"] as const;

export type WhisperModel =
  (typeof WHISPER_MODELS)[number];

export type SourceLanguage =
  (typeof SOURCE_LANGUAGES)[number];

export type TranslationBackend =
  (typeof TRANSLATION_BACKENDS)[number];

export type WhisperDevice =
  | "webgpu"
  | "wasm";

export interface Settings {
  model: WhisperModel;
  sourceLang: SourceLanguage;
  translationBackend:
    TranslationBackend;
  plamoModel: PlamoModel;
  plamoStyle: "standard" | "easy";
  showOriginal: boolean;
  showTentative: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  model: "base",
  sourceLang: "en",
  translationBackend: "plamo",
  plamoModel: "0.8b",
  plamoStyle: "standard",
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
    translationBackend: "plamo",
    plamoModel: isPlamoModel(stored.plamoModel) ? stored.plamoModel : DEFAULT_SETTINGS.plamoModel,
    plamoStyle: isPlamoStyle(stored.plamoStyle) ? stored.plamoStyle : DEFAULT_SETTINGS.plamoStyle,
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
    isTranslationBackend(
      value.translationBackend,
    ) &&
    isPlamoModel(value.plamoModel) &&
    isPlamoStyle(value.plamoStyle) &&
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

export function isTranslationBackend(
  value: unknown,
): value is TranslationBackend {
  return value === "plamo";
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

export function isPlamoStyle(value: unknown): value is Settings["plamoStyle"] {
  return value === "standard" || value === "easy";
}
