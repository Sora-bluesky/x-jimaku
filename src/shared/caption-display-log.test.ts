import {
  describe,
  expect,
  it,
} from "vitest";
import {
  CAPTION_DISPLAY_LOG_ENABLED_KEY,
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
    "keeps nothing recorded before a stored opt-out was read",
    async () => {
      const storage = createMemoryStorage();
      await storage.set(
        CAPTION_DISPLAY_LOG_ENABLED_KEY,
        false,
      );

      const log = createCaptionDisplayLog({
        storage,
        now: () => 0,
        flushDelayMs: 60_000,
      });

      // The stored preference is two reads away; a capture already running
      // fills the buffer in that window.
      log.recordPageShown(samplePage());
      await log.flush();

      expect(log.getPages()).toHaveLength(0);
      expect(
        await storage.get(
          CAPTION_DISPLAY_LOG_STORAGE_KEY,
        ),
      ).toBeUndefined();
    },
  );

  it(
    "keeps another writer's pages when it flushes",
    async () => {
      const storage = createMemoryStorage();

      // Both tabs are already open and hydrated from an empty store, which is
      // the real case: a tab hydrates once, when it loads.
      const tabA = createCaptionDisplayLog({
        storage,
        now: () => 1000,
        flushDelayMs: 60_000,
      });
      const tabB = createCaptionDisplayLog({
        storage,
        now: () => 2000,
        flushDelayMs: 60_000,
      });
      await tabA.flush();
      await tabB.flush();

      tabA.recordPageShown({
        ...samplePage(),
        cueId: "a:0",
      });
      await tabA.flush();

      tabB.recordPageShown({
        ...samplePage(),
        cueId: "b:0",
      });
      await tabB.flush();

      const stored = (await storage.get(
        CAPTION_DISPLAY_LOG_STORAGE_KEY,
      )) as { pages: { cueId: string }[] };

      expect(
        stored.pages.map(
          (page) => page.cueId,
        ),
      ).toEqual(["a:0", "b:0"]);
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
