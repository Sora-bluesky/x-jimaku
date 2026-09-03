import {
  describe,
  expect,
  it,
} from "vitest";
import {
  CAPTION_DISPLAY_LOG_STORAGE_KEY,
  createCaptionDisplayLog,
  type CaptionDisplayLogStorage,
  type CaptionDisplayPageInput,
} from "./caption-display-log";

function createMemoryStorage():
  CaptionDisplayLogStorage {
  const data = new Map<string, unknown>();

  return {
    async get(key) {
      return data.get(key);
    },
    async set(key, value) {
      data.set(key, value);
    },
  };
}

function samplePage(
  overrides: Partial<CaptionDisplayPageInput> = {},
): CaptionDisplayPageInput {
  return {
    cueId: "1:0",
    pageId: "0",
    line0: "上の行",
    line1: "下の行",
    sourceText: "Upper line",
    translationPath: "language-model",
    showOriginal: false,
    showTentative: false,
    originalRowVisible: false,
    tentativeRowVisible: false,
    ...overrides,
  };
}

describe("caption display log", () => {
  it(
    "keeps the newest pages when the bound is exceeded",
    () => {
      const log = createCaptionDisplayLog({
        storage: null,
        maxPages: 2,
        now: () => 0,
      });

      log.recordPageShown(
        samplePage({ cueId: "1:0" }),
      );
      log.recordPageShown(
        samplePage({ cueId: "2:0" }),
      );
      log.recordPageShown(
        samplePage({ cueId: "3:0" }),
      );

      expect(
        log.getPages().map(
          (page) => page.cueId,
        ),
      ).toEqual(["2:0", "3:0"]);
    },
  );

  it(
    "clear empties the stored data, not only the in-memory view",
    async () => {
      const storage = createMemoryStorage();
      const log = createCaptionDisplayLog({
        storage,
        now: () => 0,
        flushDelayMs: 60_000,
      });

      log.recordPageShown(samplePage());
      await log.flush();

      const stored = await storage.get(
        CAPTION_DISPLAY_LOG_STORAGE_KEY,
      ) as { pages: unknown[] };

      expect(stored.pages).toHaveLength(1);

      await log.clear();

      const cleared = await storage.get(
        CAPTION_DISPLAY_LOG_STORAGE_KEY,
      ) as { pages: unknown[] };

      expect(cleared.pages).toEqual([]);
      expect(log.getPages()).toEqual([]);
    },
  );

  it(
    "writes nothing while recording is off",
    async () => {
      const storage = createMemoryStorage();
      const log = createCaptionDisplayLog({
        storage,
        enabled: false,
        now: () => 0,
        flushDelayMs: 60_000,
      });

      log.recordPageShown(samplePage());
      log.recordPageHidden();
      await log.flush();

      expect(
        await storage.get(
          CAPTION_DISPLAY_LOG_STORAGE_KEY,
        ),
      ).toBeUndefined();
      expect(log.getPages()).toEqual([]);
    },
  );
});
