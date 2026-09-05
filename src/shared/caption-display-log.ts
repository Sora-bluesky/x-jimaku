import {
  isTranslationRung,
  type TranslationPath,
  type TranslationRung,
} from "./messages";

export const CAPTION_DISPLAY_LOG_STORAGE_KEY =
  "captionDisplayLog" as const;

export const CAPTION_DISPLAY_LOG_ENABLED_KEY =
  "captionDisplayLogEnabled" as const;

export const CAPTION_DISPLAY_LOG_MAX_PAGES =
  400;

export const CAPTION_DISPLAY_LOG_FLUSH_MS =
  250;

export interface CaptionSourceLine {
  id: number;
  text: string;
  rung: TranslationRung | null;
}

export interface CaptionDisplayPageInput {
  cueId: string;
  pageId: string;
  line0: string;
  line1: string;
  sourceText: string;
  sources: readonly CaptionSourceLine[];
  fallback: boolean;
  translationPath: TranslationPath | null;
  showOriginal: boolean;
  showTentative: boolean;
  originalRowVisible: boolean;
  tentativeRowVisible: boolean;
}

export interface CaptionDisplayLogPage
  extends CaptionDisplayPageInput {
  appearedAt: string;
  replacedAt: string | null;
}

export interface CaptionDisplayLogLine
  extends CaptionSourceLine {
  acceptedAt: string;
}

export interface CaptionDisplayLogDrop {
  cueId: string;
  sourceIds: readonly number[];
  droppedAt: string;
}

export interface CaptionDisplayLogSink {
  recordPageShown(
    page: CaptionDisplayPageInput,
  ): void;
  recordPageHidden(): void;
  recordLineAccepted(
    line: CaptionSourceLine,
  ): void;
  recordCueDropped(
    drop: Omit<
      CaptionDisplayLogDrop,
      "droppedAt"
    >,
  ): void;
}

export interface CaptionDisplayLogStorage {
  get(key: string): Promise<unknown>;
  set(
    key: string,
    value: unknown,
  ): Promise<void>;
  subscribe?(
    listener: (
      changes: Record<
        string,
        { newValue?: unknown }
      >,
    ) => void,
  ): void;
}

export interface CaptionDisplayLog
  extends CaptionDisplayLogSink {
  setEnabled(enabled: boolean): void;
  getPages(): CaptionDisplayLogPage[];
  flush(): Promise<void>;
  clear(): Promise<void>;
}

interface CaptionDisplayLogOptions {
  storage?: CaptionDisplayLogStorage | null;
  now?: () => number;
  maxPages?: number;
  flushDelayMs?: number;
  enabled?: boolean;
}

export interface CaptionDisplayLogDocument {
  version: 1;
  pages: CaptionDisplayLogPage[];
  lines: CaptionDisplayLogLine[];
  drops: CaptionDisplayLogDrop[];
  linesTruncated: number;
  dropsTruncated: number;
}

export function createCaptionDisplayLog(
  options: CaptionDisplayLogOptions = {},
): CaptionDisplayLog {
  return new CaptionDisplayLogWriter(
    options,
  );
}

export function createChromeCaptionDisplayLogStorage():
  CaptionDisplayLogStorage | null {
  const local =
    globalThis.chrome?.storage?.local;
  const onChanged =
    globalThis.chrome?.storage?.onChanged;

  if (
    local === undefined ||
    typeof local.get !== "function" ||
    typeof local.set !== "function"
  ) {
    return null;
  }

  return {
    async get(key) {
      const values = await local.get(key);
      return values[key];
    },
    async set(key, value) {
      await local.set({ [key]: value });
    },
    subscribe(listener) {
      if (
        onChanged === undefined ||
        typeof onChanged.addListener !==
          "function"
      ) {
        return;
      }

      onChanged.addListener(
        (changes, areaName) => {
          if (areaName !== "local") {
            return;
          }

          listener(changes);
        },
      );
    },
  };
}

export async function readCaptionDisplayLogEnabled():
  Promise<boolean> {
  const storage =
    createChromeCaptionDisplayLogStorage();

  if (storage === null) {
    return true;
  }

  return (
    (await storage.get(
      CAPTION_DISPLAY_LOG_ENABLED_KEY,
    )) !== false
  );
}

export async function writeCaptionDisplayLogEnabled(
  enabled: boolean,
): Promise<void> {
  const storage =
    createChromeCaptionDisplayLogStorage();

  if (storage === null) {
    return;
  }

  await storage.set(
    CAPTION_DISPLAY_LOG_ENABLED_KEY,
    enabled,
  );
}

export async function readCaptionDisplayLogPages():
  Promise<CaptionDisplayLogPage[]> {
  const storage =
    createChromeCaptionDisplayLogStorage();

  if (storage === null) {
    return [];
  }

  return parseCaptionDisplayLogPages(
    await storage.get(
      CAPTION_DISPLAY_LOG_STORAGE_KEY,
    ),
  );
}

export async function clearCaptionDisplayLog():
  Promise<void> {
  const storage =
    createChromeCaptionDisplayLogStorage();

  if (storage === null) {
    return;
  }

  await storage.set(
    CAPTION_DISPLAY_LOG_STORAGE_KEY,
    emptyLogDocument(),
  );
}

export function formatCaptionDisplayLogExport(
  pages: readonly CaptionDisplayLogPage[],
  exportedAt: string,
): string {
  return `${JSON.stringify(
    {
      version: 1,
      exportedAt,
      maxPages:
        CAPTION_DISPLAY_LOG_MAX_PAGES,
      pageCount: pages.length,
      pages,
    },
    null,
    2,
  )}\n`;
}

export function parseCaptionDisplayLogPages(
  value: unknown,
): CaptionDisplayLogPage[] {
  return parseCaptionDisplayLogDocument(
    value,
  ).pages;
}

export function parseCaptionDisplayLogDocument(
  value: unknown,
): CaptionDisplayLogDocument {
  if (
    !isRecord(value) ||
    value.version !== 1
  ) {
    return emptyLogDocument();
  }

  return {
    version: 1,
    pages: Array.isArray(value.pages)
      ? value.pages
          .map(withCaptionPageDefaults)
          .filter(isCaptionDisplayLogPage)
      : [],
    lines: Array.isArray(value.lines)
      ? value.lines.filter(
          isCaptionDisplayLogLine,
        )
      : [],
    drops: Array.isArray(value.drops)
      ? value.drops.filter(
          isCaptionDisplayLogDrop,
        )
      : [],
    linesTruncated:
      isNonNegativeInteger(
        value.linesTruncated,
      )
        ? value.linesTruncated
        : 0,
    dropsTruncated:
      isNonNegativeInteger(
        value.dropsTruncated,
      )
        ? value.dropsTruncated
        : 0,
  };
}

class CaptionDisplayLogWriter
  implements CaptionDisplayLog {
  private readonly storage:
    CaptionDisplayLogStorage | null;
  private readonly now: () => number;
  private readonly maxPages: number;
  private readonly flushDelayMs: number;
  private readonly enabledOverride:
    boolean | undefined;
  private readonly hydrated: Promise<void>;

  private pages: CaptionDisplayLogPage[] =
    [];
  private lines: CaptionDisplayLogLine[] =
    [];
  private drops: CaptionDisplayLogDrop[] =
    [];
  private linesTruncated = 0;
  private dropsTruncated = 0;
  private openIndex: number | null = null;
  private enabled: boolean;
  private dirty = false;
  private replaceOnFlush = false;
  private flushing = false;
  private flushTimerId:
    | ReturnType<typeof setTimeout>
    | null = null;

  constructor(
    options: CaptionDisplayLogOptions,
  ) {
    this.storage =
      options.storage === undefined
        ? createChromeCaptionDisplayLogStorage()
        : options.storage;
    this.now = options.now ?? Date.now;
    this.maxPages =
      options.maxPages ??
      CAPTION_DISPLAY_LOG_MAX_PAGES;
    this.flushDelayMs =
      options.flushDelayMs ??
      CAPTION_DISPLAY_LOG_FLUSH_MS;
    this.enabledOverride = options.enabled;
    this.enabled = options.enabled ?? true;
    this.hydrated =
      this.storage === null
        ? Promise.resolve()
        : this.hydrate();

    this.storage?.subscribe?.(
      (changes) => {
        this.handleExternalChange(changes);
      },
    );
  }

  recordPageShown(
    page: CaptionDisplayPageInput,
  ): void {
    if (!this.enabled) {
      return;
    }

    this.closeOpenPage();
    this.pages.push({
      cueId: page.cueId,
      pageId: page.pageId,
      line0: page.line0,
      line1: page.line1,
      appearedAt: this.isoNow(),
      replacedAt: null,
      sourceText: page.sourceText,
      sources: page.sources.map(
        (source) => ({ ...source }),
      ),
      fallback: page.fallback,
      translationPath: page.translationPath,
      showOriginal: page.showOriginal,
      showTentative: page.showTentative,
      originalRowVisible:
        page.originalRowVisible,
      tentativeRowVisible:
        page.tentativeRowVisible,
    });
    this.cap();
    this.openIndex = this.pages.length - 1;
    this.dirty = true;
    this.scheduleFlush();
  }

  recordPageHidden(): void {
    if (!this.enabled) {
      return;
    }

    if (!this.closeOpenPage()) {
      return;
    }

    this.dirty = true;
    this.scheduleFlush();
  }

  recordLineAccepted(
    line: CaptionSourceLine,
  ): void {
    if (!this.enabled) {
      return;
    }

    this.lines.push({
      ...line,
      acceptedAt: this.isoNow(),
    });
    // Truncation is counted by the writer that cuts, at the moment it cuts.
    // The merge below never counts: what it cuts beyond the cap is either an
    // entry this writer already counted or one from another writer or run,
    // and the stored counter keeps the largest count seen so far.
    this.linesTruncated += Math.max(
      0,
      this.lines.length - this.maxPages,
    );
    this.lines = this.capEntries(this.lines);
    this.dirty = true;
    this.scheduleFlush();
  }

  recordCueDropped(
    drop: Omit<
      CaptionDisplayLogDrop,
      "droppedAt"
    >,
  ): void {
    if (!this.enabled) {
      return;
    }

    this.drops.push({
      cueId: drop.cueId,
      sourceIds: [...drop.sourceIds],
      droppedAt: this.isoNow(),
    });
    this.dropsTruncated += Math.max(
      0,
      this.drops.length - this.maxPages,
    );
    this.drops =
      this.capEntries(this.drops);
    this.dirty = true;
    this.scheduleFlush();
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled && !enabled) {
      if (this.closeOpenPage()) {
        this.dirty = true;
        this.scheduleFlush();
      }
    }

    this.enabled = enabled;
  }

  getPages(): CaptionDisplayLogPage[] {
    return this.pages.slice();
  }

  async flush(): Promise<void> {
    this.cancelFlush();
    await this.hydrated;

    if (
      this.storage === null ||
      !this.dirty
    ) {
      return;
    }

    this.flushing = true;

    try {
      const document = this.replaceOnFlush
        ? {
            version: 1,
            pages: this.pages.map(
              (page) => ({ ...page }),
            ),
            lines: this.lines.map(
              (line) => ({ ...line }),
            ),
            drops: this.drops.map(
              (drop) => ({
                ...drop,
                sourceIds:
                  [...drop.sourceIds],
              }),
            ),
            linesTruncated:
              this.linesTruncated,
            dropsTruncated:
              this.dropsTruncated,
          } satisfies CaptionDisplayLogDocument
        : await this.mergedWithStored();

      await this.storage.set(
        CAPTION_DISPLAY_LOG_STORAGE_KEY,
        document,
      );
      this.linesTruncated =
        document.linesTruncated;
      this.dropsTruncated =
        document.dropsTruncated;
      this.dirty = false;
    } finally {
      this.flushing = false;
      this.replaceOnFlush = false;
    }
  }

  /**
   * This writer's pages joined with whatever is stored.
   *
   * Every tab with the extension loaded owns its own writer, hydrated from the
   * snapshot it saw when it started. Writing this writer's array wholesale
   * erases what another tab recorded since, and the tabs then take turns
   * destroying each other's history. Someone reporting a defect would hand over
   * a log missing the part they were describing.
   */
  private async mergedWithStored(): Promise<
    CaptionDisplayLogDocument
  > {
    const stored = await this.storage?.get(
      CAPTION_DISPLAY_LOG_STORAGE_KEY,
    );
    const storedDocument =
      parseCaptionDisplayLogDocument(
        stored,
      );
    const storedPages =
      storedDocument.pages;
    const seen = new Set<string>();
    const merged: CaptionDisplayLogPage[] = [];

    for (
      const page of [
        ...storedPages,
        ...this.pages,
      ]
    ) {
      const identity = [
        page.appearedAt,
        page.cueId,
        page.pageId,
      ].join("|");

      if (seen.has(identity)) {
        continue;
      }

      seen.add(identity);
      merged.push({ ...page });
    }

    merged.sort((left, right) =>
      left.appearedAt < right.appearedAt
        ? -1
        : left.appearedAt > right.appearedAt
          ? 1
          : 0,
    );

    const mergedLines =
      mergeCaptionLogEntries(
        storedDocument.lines,
        this.lines,
        (line) => line.acceptedAt,
      );

    const mergedDrops =
      mergeCaptionLogEntries(
        storedDocument.drops,
        this.drops,
        (drop) => drop.droppedAt,
      );

    return {
      version: 1,
      pages: this.capPages(merged),
      lines:
        this.capEntries(mergedLines),
      drops: this.capEntries(mergedDrops),
      linesTruncated: Math.max(
        storedDocument.linesTruncated,
        this.linesTruncated,
      ),
      dropsTruncated: Math.max(
        storedDocument.dropsTruncated,
        this.dropsTruncated,
      ),
    };
  }

  async clear(): Promise<void> {
    this.pages = [];
    this.lines = [];
    this.drops = [];
    this.linesTruncated = 0;
    this.dropsTruncated = 0;
    this.openIndex = null;
    this.dirty = true;
    // Clearing replaces; merging would put back what was just discarded.
    this.replaceOnFlush = true;
    this.cancelFlush();
    await this.flush();
  }

  private async hydrate(): Promise<void> {
    if (this.storage === null) {
      return;
    }

    const stored = await this.storage.get(
      CAPTION_DISPLAY_LOG_STORAGE_KEY,
    );
    const enabledStored =
      await this.storage.get(
        CAPTION_DISPLAY_LOG_ENABLED_KEY,
      );
    const closedAt = this.isoNow();
    const loadedDocument =
      parseCaptionDisplayLogDocument(
        stored,
      );
    const loaded =
      loadedDocument.pages.map((page) =>
        page.replacedAt === null
          ? { ...page, replacedAt: closedAt }
          : page,
      );

    this.pages = this.capPages([
      ...loaded,
      ...this.pages,
    ]);
    this.recomputeOpenIndex();
    this.linesTruncated = Math.max(
      loadedDocument.linesTruncated,
      this.linesTruncated,
    );
    this.dropsTruncated = Math.max(
      loadedDocument.dropsTruncated,
      this.dropsTruncated,
    );
    this.lines = [
      ...loadedDocument.lines,
      ...this.lines,
    ];
    this.capLines();
    this.drops = this.capEntries([
      ...loadedDocument.drops,
      ...this.drops,
    ]);

    if (
      this.enabledOverride === undefined &&
      typeof enabledStored === "boolean"
    ) {
      this.enabled = enabledStored;
    }

    if (!this.enabled) {
      // Captions recorded while this read was in flight belong to someone who
      // had turned recording off. Nothing kept, nothing to flush: an opt-out
      // honoured a few storage reads late is not an opt-out.
      this.pages = [];
      this.lines = [];
      this.drops = [];
      this.linesTruncated = 0;
      this.dropsTruncated = 0;
      this.openIndex = null;
      this.dirty = false;
    }
  }

  private handleExternalChange(
    changes: Record<
      string,
      { newValue?: unknown }
    >,
  ): void {
    if (
      CAPTION_DISPLAY_LOG_ENABLED_KEY in
      changes
    ) {
      this.setEnabled(
        changes[
          CAPTION_DISPLAY_LOG_ENABLED_KEY
        ]?.newValue !== false,
      );
    }

    if (
      this.flushing ||
      !(
        CAPTION_DISPLAY_LOG_STORAGE_KEY in
        changes
      )
    ) {
      return;
    }

    const incoming =
      parseCaptionDisplayLogDocument(
        changes[
          CAPTION_DISPLAY_LOG_STORAGE_KEY
        ]?.newValue,
      );

    if (
      incoming.pages.length > 0 ||
      incoming.lines.length > 0 ||
      incoming.drops.length > 0 ||
      incoming.linesTruncated > 0 ||
      incoming.dropsTruncated > 0
    ) {
      return;
    }

    this.pages = [];
    this.lines = [];
    this.drops = [];
    this.linesTruncated = 0;
    this.dropsTruncated = 0;
    this.openIndex = null;
    this.dirty = false;
    this.cancelFlush();
  }

  private closeOpenPage(): boolean {
    if (this.openIndex === null) {
      return false;
    }

    const page = this.pages[this.openIndex];
    this.openIndex = null;

    if (
      page === undefined ||
      page.replacedAt !== null
    ) {
      return false;
    }

    page.replacedAt = this.isoNow();
    return true;
  }

  private cap(): void {
    this.pages = this.capPages(this.pages);

    if (this.openIndex !== null) {
      this.openIndex =
        this.pages.length - 1;
    }
  }

  private capPages(
    pages: CaptionDisplayLogPage[],
  ): CaptionDisplayLogPage[] {
    if (pages.length <= this.maxPages) {
      return pages;
    }

    return pages.slice(
      pages.length - this.maxPages,
    );
  }

  private capLines(): void {
    this.lines =
      this.capEntries(this.lines);
  }

  private capEntries<T>(
    entries: T[],
  ): T[] {
    return entries.length <= this.maxPages
      ? entries
      : entries.slice(
          entries.length - this.maxPages,
        );
  }

  private recomputeOpenIndex(): void {
    this.openIndex = null;

    for (
      let index = this.pages.length - 1;
      index >= 0;
      index -= 1
    ) {
      if (
        this.pages[index]?.replacedAt ===
        null
      ) {
        this.openIndex = index;
        return;
      }
    }
  }

  private scheduleFlush(): void {
    if (
      this.storage === null ||
      this.flushTimerId !== null
    ) {
      return;
    }

    this.flushTimerId =
      globalThis.setTimeout(() => {
        this.flushTimerId = null;
        void this.flush();
      }, this.flushDelayMs);
  }

  private cancelFlush(): void {
    if (this.flushTimerId === null) {
      return;
    }

    globalThis.clearTimeout(
      this.flushTimerId,
    );
    this.flushTimerId = null;
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }
}

function emptyLogDocument():
  CaptionDisplayLogDocument {
  return {
    version: 1,
    pages: [],
    lines: [],
    drops: [],
    linesTruncated: 0,
    dropsTruncated: 0,
  };
}

function withCaptionPageDefaults(
  value: unknown,
): unknown {
  if (!isRecord(value)) {
    return value;
  }

  return {
    ...value,
    sources: value.sources ?? [],
    fallback: value.fallback ?? false,
  };
}

function isCaptionDisplayLogPage(
  value: unknown,
): value is CaptionDisplayLogPage {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.cueId === "string" &&
    typeof value.pageId === "string" &&
    typeof value.line0 === "string" &&
    typeof value.line1 === "string" &&
    typeof value.appearedAt === "string" &&
    (
      value.replacedAt === null ||
      typeof value.replacedAt === "string"
    ) &&
    typeof value.sourceText === "string" &&
    Array.isArray(value.sources) &&
    value.sources.every(
      isCaptionSourceLine,
    ) &&
    typeof value.fallback === "boolean" &&
    isStoredTranslationPath(
      value.translationPath,
    ) &&
    typeof value.showOriginal ===
      "boolean" &&
    typeof value.showTentative ===
      "boolean" &&
    typeof value.originalRowVisible ===
      "boolean" &&
    typeof value.tentativeRowVisible ===
      "boolean"
  );
}

function isCaptionSourceLine(
  value: unknown,
): value is CaptionSourceLine {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.id) &&
    typeof value.text === "string" &&
    (
      value.rung === null ||
      isTranslationRung(value.rung)
    )
  );
}

function isCaptionDisplayLogLine(
  value: unknown,
): value is CaptionDisplayLogLine {
  return (
    isRecord(value) &&
    typeof value.acceptedAt === "string" &&
    isCaptionSourceLine(value)
  );
}

function isCaptionDisplayLogDrop(
  value: unknown,
): value is CaptionDisplayLogDrop {
  return (
    isRecord(value) &&
    typeof value.cueId === "string" &&
    Array.isArray(value.sourceIds) &&
    value.sourceIds.every(
      isNonNegativeInteger,
    ) &&
    typeof value.droppedAt === "string"
  );
}

function mergeCaptionLogEntries<T extends object>(
  stored: readonly T[],
  current: readonly T[],
  timestamp: (entry: T) => string,
): T[] {
  const seen = new Set<string>();
  const merged = [...stored, ...current]
    .filter((entry) => {
      const identity =
        JSON.stringify(entry) ?? "";

      if (seen.has(identity)) {
        return false;
      }

      seen.add(identity);
      return true;
    });

  merged.sort((left, right) =>
    timestamp(left) < timestamp(right)
      ? -1
      : timestamp(left) > timestamp(right)
        ? 1
        : 0,
  );
  return merged;
}

function isNonNegativeInteger(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isStoredTranslationPath(
  value: unknown,
): value is TranslationPath | null {
  return (
    value === null ||
    value === "offscreen-translator" ||
    value === "content-translator" ||
    value === "language-model" ||
    value === "none"
  );
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null
  );
}
