import type {
  TranslationPath,
} from "./messages";

export const CAPTION_DISPLAY_LOG_STORAGE_KEY =
  "captionDisplayLog" as const;

export const CAPTION_DISPLAY_LOG_ENABLED_KEY =
  "captionDisplayLogEnabled" as const;

export const CAPTION_DISPLAY_LOG_MAX_PAGES =
  400;

export const CAPTION_DISPLAY_LOG_FLUSH_MS =
  250;

export interface CaptionDisplayPageInput {
  cueId: string;
  pageId: string;
  line0: string;
  line1: string;
  sourceText: string;
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

export interface CaptionDisplayLogSink {
  recordPageShown(
    page: CaptionDisplayPageInput,
  ): void;
  recordPageHidden(): void;
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

export interface CaptionDisplayLog {
  recordPageShown(
    page: CaptionDisplayPageInput,
  ): void;
  recordPageHidden(): void;
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

interface CaptionDisplayLogDocument {
  version: 1;
  pages: CaptionDisplayLogPage[];
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
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.pages)
  ) {
    return [];
  }

  return value.pages.filter(
    isCaptionDisplayLogPage,
  );
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
  private openIndex: number | null = null;
  private enabled: boolean;
  private dirty = false;
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
      await this.storage.set(
        CAPTION_DISPLAY_LOG_STORAGE_KEY,
        {
          version: 1,
          pages: this.pages.map(
            (page) => ({ ...page }),
          ),
        } satisfies CaptionDisplayLogDocument,
      );
      this.dirty = false;
    } finally {
      this.flushing = false;
    }
  }

  async clear(): Promise<void> {
    this.pages = [];
    this.openIndex = null;
    this.dirty = true;
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
    const loaded =
      parseCaptionDisplayLogPages(
        stored,
      ).map((page) =>
        page.replacedAt === null
          ? { ...page, replacedAt: closedAt }
          : page,
      );

    this.pages = this.capPages([
      ...loaded,
      ...this.pages,
    ]);
    this.recomputeOpenIndex();

    if (
      this.enabledOverride === undefined &&
      typeof enabledStored === "boolean"
    ) {
      this.enabled = enabledStored;
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
      parseCaptionDisplayLogPages(
        changes[
          CAPTION_DISPLAY_LOG_STORAGE_KEY
        ]?.newValue,
      );

    if (incoming.length > 0) {
      return;
    }

    this.pages = [];
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
  return { version: 1, pages: [] };
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
