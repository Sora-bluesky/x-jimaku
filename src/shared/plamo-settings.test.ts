import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, isSettings, readSettings } from "./settings";
import { isPlamoWorkerInputMessage, isPlamoWorkerOutputMessage, isTranslationPath, isTranslationRung } from "./messages";
import { PLAMO_MODELS, plamoModelUrl } from "./plamo-models";

afterEach(() => vi.unstubAllGlobals());

it.each(["auto", "translator", "prompt-api"])("migrates stored %s settings to PLaMo", async (translationBackend) => {
  vi.stubGlobal("chrome", { storage: { sync: { get: async () => ({ settings: { model: "tiny", translationBackend, showOriginal: true } }) } } });
  expect(await readSettings()).toEqual({ ...DEFAULT_SETTINGS, model: "tiny", translationBackend: "plamo", showOriginal: true });
  expect(DEFAULT_SETTINGS.translationBackend).toBe("plamo");
  expect(isSettings({ ...DEFAULT_SETTINGS, translationBackend: "plamo", plamoModel: "8b", plamoStyle: "easy" })).toBe(true);
  expect(isSettings({ ...DEFAULT_SETTINGS, plamoModel: "unknown" })).toBe(false);
  expect(isSettings({ ...DEFAULT_SETTINGS, plamoStyle: "unknown" })).toBe(false);
});

it("accepts PLaMo path/rung and validates both worker directions", () => {
  expect(isTranslationPath("plamo")).toBe(true); expect(isTranslationRung("plamo")).toBe(true);
  expect(isPlamoWorkerInputMessage({ t: "PLAMO_INIT", model: "2b" })).toBe(true);
  expect(isPlamoWorkerInputMessage({ t: "PLAMO_INIT", model: "bad" })).toBe(false);
  for (const maxTokens of [1, 256, 4096]) expect(isPlamoWorkerInputMessage({ t: "PLAMO_TRANSLATE", id: 1, prompt: "a", maxTokens })).toBe(true);
  for (const maxTokens of [0, -1, 1.5, 4097, Infinity, "1"]) expect(isPlamoWorkerInputMessage({ t: "PLAMO_TRANSLATE", id: 1, prompt: "a", maxTokens })).toBe(false);
  for (const value of [
    { t: "PLAMO_READY", model: "0.8b", loadMs: 10 }, { t: "PLAMO_PROGRESS", loaded: 1, total: 2 },
    { t: "PLAMO_RESULT", id: 1, text: "訳" }, { t: "PLAMO_ERROR", id: 1, message: "recovered", fatal: false, recovered: true },
  ]) expect(isPlamoWorkerOutputMessage(value)).toBe(true);
  expect(isPlamoWorkerOutputMessage({ t: "PLAMO_ERROR", id: -1, fatal: true, message: "bad" })).toBe(false);
});

it("builds immutable revision URLs for all sizes", () => {
  for (const model of ["0.8b", "2b", "8b"] as const) {
    const entry = PLAMO_MODELS[model];
    expect(plamoModelUrl(model)).toBe(`https://huggingface.co/${entry.repo}/resolve/${entry.revision}/${entry.file}`);
    expect(entry.revision).toMatch(/^[a-f0-9]{40}$/u); expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/u);
  }
});
