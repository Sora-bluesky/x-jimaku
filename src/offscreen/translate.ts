import type {
  RecognitionPayload,
  TranslationPath,
} from "../shared/messages";

type TranslatorScope = typeof globalThis & {
  Translator?: TranslatorFactory;
};

type LanguageModelScope = typeof globalThis & {
  LanguageModel?: LanguageModelFactory;
};

export interface ContentTranslationResponse {
  available: boolean;
  ja: string;
}

export interface TranslationQueueEntry
  extends RecognitionPayload {
  skipTranslation?: boolean;
}

export interface TranslationEngineOptions {
  requestContentTranslation(
    text: string,
  ): Promise<ContentTranslationResponse>;
  onTranslated(
    line: RecognitionPayload,
    ja: string,
  ): void;
  onPathChanged(path: TranslationPath): void;
}

const TRANSLATOR_OPTIONS: TranslatorOptions = {
  sourceLanguage: "en",
  targetLanguage: "ja",
};

const TRANSLATION_SYSTEM_PROMPT =
  "Translate the English subtitle clause into natural Japanese. Output only the translation of the current clause.";

const MAX_PENDING_TRANSLATIONS = 2;
const TRANSLATOR_CREATE_TIMEOUT_MS = 8_000;

export class TranslationEngine {
  private readonly options:
    TranslationEngineOptions;
  private readonly queue:
    TranslationQueueEntry[] = [];
  private readonly failedPaths =
    new Set<TranslationPath>();

  private translator:
    | TranslatorInstance
    | null = null;
  private languageModel:
    | LanguageModelSession
    | null = null;
  private path:
    | TranslationPath
    | null = null;
  private translatorCreateAttempted = false;
  private languageModelCreateAttempted = false;
  private processing = false;
  private destroyed = false;
  private initializationPromise:
    | Promise<void>
    | null = null;

  constructor(
    options: TranslationEngineOptions,
  ) {
    this.options = options;
  }

  initialize(): Promise<void> {
    if (this.destroyed) {
      return Promise.resolve();
    }

    if (this.initializationPromise !== null) {
      return this.initializationPromise;
    }

    const operation =
      this.selectBestPath().finally(() => {
        if (
          this.initializationPromise ===
          operation
        ) {
          this.initializationPromise = null;
        }
      });

    this.initializationPromise = operation;
    return operation;
  }

  enqueue(line: TranslationQueueEntry): void {
    const skipTranslation =
      line.skipTranslation === true;

    if (
      this.destroyed ||
      !line.final ||
      line.text.trim() === "" ||
      (
        this.path === "none" &&
        !skipTranslation
      )
    ) {
      return;
    }

    const queuedCapacity =
      MAX_PENDING_TRANSLATIONS -
      (this.processing ? 1 : 0);

    if (
      this.queue.length >=
      Math.max(1, queuedCapacity)
    ) {
      const dropped = this.queue.shift();

      if (dropped !== undefined) {
        console.warn(
          "[translate]",
          "dropped oldest pending committed clause",
          {
            id: dropped.id,
            text: dropped.text,
            skipTranslation:
              dropped.skipTranslation ===
              true,
          },
        );
      }
    }

    this.queue.push({
      ...line,
      final: true,
      skipTranslation,
    });
    this.runQueue();
  }

  getPath(): TranslationPath | null {
    return this.path;
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.queue.splice(0, this.queue.length);
    this.destroyTranslator();
    this.destroyLanguageModel();
    this.path = null;
  }

  private runQueue(): void {
    if (
      this.destroyed ||
      this.processing
    ) {
      return;
    }

    const next = this.queue[0];

    if (next === undefined) {
      return;
    }

    if (
      next.skipTranslation !== true &&
      (
        this.path === null ||
        this.path === "none"
      )
    ) {
      return;
    }

    const line = this.queue.shift();

    if (line === undefined) {
      return;
    }

    this.processing = true;
    void this.processClause(line);
  }

  private async processClause(
    line: TranslationQueueEntry,
  ): Promise<void> {
    try {
      const ja =
        line.skipTranslation === true
          ? line.text
          : await this.translateWithFallback(
              line.text,
            );

      if (
        this.destroyed ||
        ja === null
      ) {
        return;
      }

      this.options.onTranslated(
        line,
        ja,
      );
    } finally {
      this.processing = false;
      this.runQueue();
    }
  }

  private async translateWithFallback(
    text: string,
  ): Promise<string | null> {
    while (
      !this.destroyed &&
      this.path !== null &&
      this.path !== "none"
    ) {
      const attemptedPath = this.path;

      try {
        const result =
          await this.translateUsingPath(
            attemptedPath,
            text,
          );
        const normalized = result.trim();

        if (normalized === "") {
          throw new Error(
            "Translation returned an empty result",
          );
        }

        return normalized;
      } catch (error) {
        if (this.destroyed) {
          return null;
        }

        console.warn(
          "[translate]",
          "translation stage failed; selecting the next path",
          {
            path: attemptedPath,
            error,
          },
        );

        this.failPath(attemptedPath);
        await this.selectBestPath();
      }
    }

    return null;
  }

  private async translateUsingPath(
    path: TranslationPath,
    text: string,
  ): Promise<string> {
    switch (path) {
      case "offscreen-translator":
        if (this.translator === null) {
          throw new Error(
            "Offscreen Translator is not initialized",
          );
        }

        return this.translator.translate(text);

      case "content-translator": {
        const response =
          await this.options
            .requestContentTranslation(text);

        if (!response.available) {
          throw new Error(
            "Content-script Translator became unavailable",
          );
        }

        return response.ja;
      }

      case "language-model":
        if (this.languageModel === null) {
          throw new Error(
            "LanguageModel is not initialized",
          );
        }

        return this.languageModel.prompt(text);

      case "none":
        throw new Error(
          "No translation path is active",
        );
    }
  }

  private async selectBestPath(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    if (
      !this.failedPaths.has(
        "offscreen-translator",
      ) &&
      await this.prepareOffscreenTranslator()
    ) {
      this.setPath(
        "offscreen-translator",
      );
      return;
    }

    if (
      !this.failedPaths.has(
        "content-translator",
      ) &&
      await this.prepareContentTranslator()
    ) {
      this.setPath("content-translator");
      return;
    }

    if (
      !this.failedPaths.has(
        "language-model",
      ) &&
      await this.prepareLanguageModel()
    ) {
      this.setPath("language-model");
      return;
    }

    this.setPath("none");
  }

  private async prepareOffscreenTranslator(): Promise<boolean> {
    if (this.translator !== null) {
      return true;
    }

    if (this.translatorCreateAttempted) {
      return false;
    }

    const scope =
      globalThis as TranslatorScope;
    const factory = scope.Translator;

    if (
      !("Translator" in scope) ||
      factory === undefined ||
      typeof factory.availability !==
        "function" ||
      typeof factory.create !== "function"
    ) {
      return false;
    }

    try {
      const availability =
        await factory.availability(
          TRANSLATOR_OPTIONS,
        );

      if (
        this.destroyed ||
        availability !== "available"
      ) {
        return false;
      }

      this.translatorCreateAttempted = true;

      const createPromise =
        factory.create(
          TRANSLATOR_OPTIONS,
        );

      try {
        this.translator =
          await waitWithTimeout(
            createPromise,
            TRANSLATOR_CREATE_TIMEOUT_MS,
            "Offscreen Translator creation timed out",
          );
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === "TimeoutError"
        ) {
          void createPromise.then(
            (instance) => {
              destroyTranslatorInstance(
                instance,
              );
            },
            () => undefined,
          );
        }

        throw error;
      }

      if (this.destroyed) {
        this.destroyTranslator();
        return false;
      }

      return true;
    } catch (error) {
      this.translatorCreateAttempted = true;
      this.failedPaths.add(
        "offscreen-translator",
      );

      console.warn(
        "[translate]",
        "could not initialize offscreen Translator",
        error,
      );
      return false;
    }
  }

  private async prepareContentTranslator(): Promise<boolean> {
    try {
      const response =
        await this.options
          .requestContentTranslation("");

      return (
        !this.destroyed &&
        response.available
      );
    } catch (error) {
      this.failedPaths.add(
        "content-translator",
      );

      console.warn(
        "[translate]",
        "could not initialize content-script Translator",
        error,
      );
      return false;
    }
  }

  private async prepareLanguageModel(): Promise<boolean> {
    if (this.languageModel !== null) {
      return true;
    }

    if (this.languageModelCreateAttempted) {
      return false;
    }

    const scope =
      globalThis as LanguageModelScope;
    const factory = scope.LanguageModel;

    if (
      !("LanguageModel" in scope) ||
      factory === undefined ||
      typeof factory.availability !==
        "function" ||
      typeof factory.create !== "function"
    ) {
      return false;
    }

    try {
      const availability =
        await factory.availability();

      if (
        this.destroyed ||
        availability !== "available"
      ) {
        return false;
      }

      this.languageModelCreateAttempted =
        true;
      this.languageModel =
        await factory.create({
          initialPrompts: [
            {
              role: "system",
              content:
                TRANSLATION_SYSTEM_PROMPT,
            },
          ],
        });

      if (this.destroyed) {
        this.destroyLanguageModel();
        return false;
      }

      return true;
    } catch (error) {
      this.languageModelCreateAttempted =
        true;
      this.failedPaths.add(
        "language-model",
      );

      console.warn(
        "[translate]",
        "could not initialize LanguageModel",
        error,
      );
      return false;
    }
  }

  private failPath(
    path: TranslationPath,
  ): void {
    this.failedPaths.add(path);

    if (path === "offscreen-translator") {
      this.destroyTranslator();
    }

    if (path === "language-model") {
      this.destroyLanguageModel();
    }

    this.path = null;
  }

  private setPath(
    path: TranslationPath,
  ): void {
    if (
      this.destroyed ||
      this.path === path
    ) {
      return;
    }

    this.path = path;

    if (path === "none") {
      const skipEntries =
        this.queue.filter(
          (line) =>
            line.skipTranslation === true,
        );

      this.queue.splice(
        0,
        this.queue.length,
        ...skipEntries,
      );
    }

    this.options.onPathChanged(path);

    console.log(
      "[translate]",
      "active translation path changed",
      { path },
    );

    this.runQueue();
  }

  private destroyTranslator(): void {
    const instance = this.translator;
    this.translator = null;

    if (instance !== null) {
      destroyTranslatorInstance(
        instance,
      );
    }
  }

  private destroyLanguageModel(): void {
    const session = this.languageModel;
    this.languageModel = null;

    if (session === null) {
      return;
    }

    try {
      session.destroy();
    } catch (error) {
      console.warn(
        "[translate]",
        "LanguageModel cleanup failed",
        error,
      );
    }
  }
}

function destroyTranslatorInstance(
  instance: TranslatorInstance,
): void {
  try {
    instance.destroy();
  } catch (error) {
    console.warn(
      "[translate]",
      "Translator cleanup failed",
      error,
    );
  }
}

function waitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>(
    (resolve, reject) => {
      let settled = false;

      const timerId = self.setTimeout(
        () => {
          if (settled) {
            return;
          }

          settled = true;
          const error = new Error(message);
          error.name = "TimeoutError";
          reject(error);
        },
        timeoutMs,
      );

      void promise.then(
        (value) => {
          if (settled) {
            return;
          }

          settled = true;
          globalThis.clearTimeout(timerId);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) {
            return;
          }

          settled = true;
          globalThis.clearTimeout(timerId);
          reject(error);
        },
      );
    },
  );
}

export function isMostlyJapanese(
  text: string,
): boolean {
  const characters =
    Array.from(text).filter(
      (character) =>
        !/\s/u.test(character),
    );

  if (characters.length === 0) {
    return false;
  }

  let japaneseCharacters = 0;

  for (const character of characters) {
    if (
      /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(
        character,
      )
    ) {
      japaneseCharacters += 1;
    }
  }

  return (
    japaneseCharacters /
      characters.length >
    0.3
  );
}
