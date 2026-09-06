import {
  describe,
  expect,
  it,
} from "vitest";
import {
  CAPTION_DISPLAY_LOG_ENABLED_KEY,
  CAPTION_DISPLAY_LOG_MAX_PAGES,
  CAPTION_DISPLAY_LOG_STORAGE_KEY,
  createCaptionDisplayLog,
  formatCaptionDisplayLogExport,
  parseCaptionDisplayLogDocument,
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
    sources: [
      {
        id: 1,
        text: "Upper line",
        rung: "lm-unmasked",
      },
    ],
    fallback: false,
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
    "round-trips accepted lines and drops through flush and hydrate",
    async () => {
      const storage = createMemoryStorage();
      const first = createCaptionDisplayLog({
        storage,
        now: () => 1_000,
        flushDelayMs: 60_000,
      });

      first.recordLineAccepted({
        id: 1,
        text: "first",
        rung: "masked",
      });
      first.recordCueDropped({
        cueId: "1:0",
        sourceIds: [1],
      });
      await first.flush();

      const hydrated =
        createCaptionDisplayLog({
          storage,
          now: () => 2_000,
          flushDelayMs: 60_000,
        });
      hydrated.recordLineAccepted({
        id: 2,
        text: "second",
        rung: null,
      });
      hydrated.recordCueDropped({
        cueId: "2:0",
        sourceIds: [2],
      });
      await hydrated.flush();

      const document =
        parseCaptionDisplayLogDocument(
          await storage.get(
            CAPTION_DISPLAY_LOG_STORAGE_KEY,
          ),
        );

      expect(
        document.lines.map((line) => line.id),
      ).toEqual([1, 2]);
      expect(
        document.drops.map(
          (drop) => drop.cueId,
        ),
      ).toEqual(["1:0", "2:0"]);
    },
  );

  it(
    "defaults an old document's missing provenance fields",
    () => {
      const legacyPage:
        Record<string, unknown> = {
          ...samplePage(),
          appearedAt:
            "2026-09-01T00:00:00.000Z",
          replacedAt: null,
        };
      delete legacyPage.sources;
      delete legacyPage.fallback;

      const document =
        parseCaptionDisplayLogDocument({
          version: 1,
          pages: [legacyPage],
        });

      expect(document.pages[0]?.sources)
        .toEqual([]);
      expect(document.pages[0]?.fallback)
        .toBe(false);
      expect(document.lines).toEqual([]);
      expect(document.drops).toEqual([]);
      expect(document.linesTruncated)
        .toBe(0);
      expect(document.dropsTruncated)
        .toBe(0);
    },
  );

  it(
    "counts accepted lines truncated beyond the 400-entry cap",
    async () => {
      const storage = createMemoryStorage();
      const log = createCaptionDisplayLog({
        storage,
        now: () => 0,
        flushDelayMs: 60_000,
      });

      for (
        let id = 0;
        id <= CAPTION_DISPLAY_LOG_MAX_PAGES;
        id += 1
      ) {
        if (
          id ===
          CAPTION_DISPLAY_LOG_MAX_PAGES
        ) {
          await log.flush();
        }

        log.recordLineAccepted({
          id,
          text: String(id),
          rung: null,
        });
        log.recordCueDropped({
          cueId: `${id}:0`,
          sourceIds: [id],
        });
      }

      await log.flush();
      const document =
        parseCaptionDisplayLogDocument(
          await storage.get(
            CAPTION_DISPLAY_LOG_STORAGE_KEY,
          ),
        );

      expect(document.lines).toHaveLength(
        CAPTION_DISPLAY_LOG_MAX_PAGES,
      );
      expect(document.lines[0]?.id).toBe(1);
      expect(document.linesTruncated).toBe(1);
      expect(document.drops).toHaveLength(
        CAPTION_DISPLAY_LOG_MAX_PAGES,
      );
      expect(document.drops[0]?.cueId)
        .toBe("1:0");
      expect(document.dropsTruncated)
        .toBe(1);

      await log.clear();
      const cleared =
        parseCaptionDisplayLogDocument(
          await storage.get(
            CAPTION_DISPLAY_LOG_STORAGE_KEY,
          ),
        );

      expect(cleared.linesTruncated)
        .toBe(0);
      expect(cleared.dropsTruncated)
        .toBe(0);
    },
  );

  it(
    "counts a line truncated before the first flush exactly once",
    async () => {
      const storage = createMemoryStorage();
      const log = createCaptionDisplayLog({
        storage,
        now: () => 0,
        flushDelayMs: 60_000,
      });

      for (
        let id = 0;
        id <= CAPTION_DISPLAY_LOG_MAX_PAGES;
        id += 1
      ) {
        log.recordLineAccepted({
          id,
          text: String(id),
          rung: null,
        });
        log.recordCueDropped({
          cueId: `${id}:0`,
          sourceIds: [id],
        });
      }

      await log.flush();
      await log.flush();
      const document =
        parseCaptionDisplayLogDocument(
          await storage.get(
            CAPTION_DISPLAY_LOG_STORAGE_KEY,
          ),
        );

      expect(document.lines).toHaveLength(
        CAPTION_DISPLAY_LOG_MAX_PAGES,
      );
      expect(document.linesTruncated).toBe(1);
      expect(document.dropsTruncated)
        .toBe(1);
    },
  );

  it("keeps truncation counts exact across writers", async () => {
    const storage = createMemoryStorage();
    const options = { storage, now: () => 0, flushDelayMs: 60_000 };
    const tabA = createCaptionDisplayLog(options);
    const tabB = createCaptionDisplayLog(options);
    await Promise.all([tabA.flush(), tabB.flush()]);

    for (let id = 0; id < 600; id += 1) {
      const writer = id < 300 ? tabA : tabB;
      writer.recordLineAccepted({ id, text: String(id), rung: null });
      writer.recordCueDropped({ cueId: `${id}:0`, sourceIds: [id] });
    }

    await tabA.flush();
    await tabB.flush();
    const readDocument = async () =>
      parseCaptionDisplayLogDocument(
        await storage.get(CAPTION_DISPLAY_LOG_STORAGE_KEY),
      );
    let document = await readDocument();
    expect([document.lines.length, document.linesTruncated]).toEqual([400, 200]);
    expect([document.drops.length, document.dropsTruncated]).toEqual([400, 200]);

    tabA.recordPageShown(samplePage({ cueId: "a:0" }));
    await tabA.flush();
    document = await readDocument();
    expect([document.linesTruncated, document.dropsTruncated]).toEqual([200, 200]);

    tabB.recordPageShown(samplePage({ cueId: "b:0" }));
    await tabB.flush();
    document = await readDocument();
    expect([document.linesTruncated, document.dropsTruncated]).toEqual([200, 200]);
  });

  it("adds the hydrated truncation base to later overflow", async () => {
    const storage = createMemoryStorage();
    const options = { storage, now: () => 0, flushDelayMs: 60_000 };
    const first = createCaptionDisplayLog(options);

    for (let id = 0; id < 450; id += 1) {
      first.recordLineAccepted({ id, text: String(id), rung: null });
    }
    await first.flush();

    const hydrated = createCaptionDisplayLog(options);
    await hydrated.flush();
    for (let id = 450; id < 460; id += 1) {
      hydrated.recordLineAccepted({ id, text: String(id), rung: null });
    }
    await hydrated.flush();

    const document = parseCaptionDisplayLogDocument(
      await storage.get(CAPTION_DISPLAY_LOG_STORAGE_KEY),
    );
    expect([document.lines.length, document.linesTruncated]).toEqual([400, 60]);
  });

  it(
    "exports the lines, drops and truncation counts next to the pages",
    () => {
      const exported = JSON.parse(
        formatCaptionDisplayLogExport(
          {
            version: 1,
            pages: [],
            lines: [
              {
                id: 7,
                text: "seven",
                rung: "masked",
                acceptedAt:
                  "2026-09-05T00:00:00.000Z",
              },
            ],
            drops: [
              {
                cueId: "7:0",
                sourceIds: [7],
                droppedAt:
                  "2026-09-05T00:00:01.000Z",
              },
            ],
            linesTruncated: 3,
            dropsTruncated: 1,
          },
          "2026-09-05T00:00:02.000Z",
        ),
      );

      expect(exported.lineCount).toBe(1);
      expect(exported.dropCount).toBe(1);
      expect(exported.lines[0]?.text)
        .toBe("seven");
      expect(exported.drops[0]?.cueId)
        .toBe("7:0");
      expect(exported.linesTruncated).toBe(3);
      expect(exported.dropsTruncated).toBe(1);
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
