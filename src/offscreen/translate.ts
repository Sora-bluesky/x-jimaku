import type {
  RecognitionPayload,
  TranslationPath,
} from "../shared/messages";
import type {
  TranslationBackend,
} from "../shared/settings";

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

export interface TranslationEnqueueOptions {
  stopFlush?: boolean;
}

export interface TranslationPair {
  en: string;
  ja: string;
}

export interface TranslationContext {
  recentPairs: TranslationPair[];
  properNouns: string[];
}

interface TranslationAttemptResult {
  ja: string;
  recordHistory: boolean;
}

export interface TranslationEngineOptions {
  backend: TranslationBackend;
  getContext(): TranslationContext;
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

const LANGUAGE_MODEL_EXPECTED_OUTPUTS:
  readonly LanguageModelExpected[] = [
    {
      type: "text",
      languages: [
        TRANSLATOR_OPTIONS.targetLanguage,
      ],
    },
  ];

const TRANSLATION_SYSTEM_PROMPT =
  "あなたは英語動画の日本語字幕翻訳者。与えられた英語の節を、直前の文脈と固有名詞リストに整合する自然な日本語に訳す。出力は当該節の訳だけ。説明・引用符・前後の節の再訳は出力しない。リストに無い語でも、大文字で始まる語・見慣れない語は固有名詞として原綴りのまま残す";

const MAX_PENDING_TRANSLATIONS = 2;
export const TRANSLATOR_CREATE_TIMEOUT_MS =
  8_000;
const LANGUAGE_MODEL_PROMPT_TIMEOUT_MS =
  10_000;
const LANGUAGE_MODEL_SLOW_THRESHOLD_MS =
  3_000;
const LANGUAGE_MODEL_LATENCY_WINDOW = 5;
const LANGUAGE_MODEL_SLOW_LIMIT = 3;

export class TranslationEngine {
  private readonly options:
    TranslationEngineOptions;
  private readonly queue:
    TranslationQueueEntry[] = [];
  private readonly failedPaths =
    new Set<TranslationPath>();
  private readonly recentHistory:
    TranslationPair[] = [];
  private readonly languageModelSlowSamples:
    boolean[] = [];
  private readonly drainResolvers =
    new Set<() => void>();

  private translator:
    | TranslatorInstance
    | null = null;
  private languageModel:
    | LanguageModelSession
    | null = null;
  private languageModelClone:
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

  enqueue(
    line: TranslationQueueEntry,
    options: TranslationEnqueueOptions = {},
  ): void {
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
      options.stopFlush !== true &&
      this.queue.length >=
        Math.max(1, queuedCapacity)
    ) {
      const dropped = this.queue.shift();

      if (dropped !== undefined) {
        console.warn(
          `[translate] dropped oldest pending committed clause (id=${dropped.id}, textLength=${dropped.text.length})`,
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

  async drain(): Promise<boolean> {
    if (this.destroyed) {
      return false;
    }

    try {
      await waitWithTimeout(
        this.waitForQueueToDrain(),
        TRANSLATOR_CREATE_TIMEOUT_MS,
        "Translation drain timed out",
      );
      return true;
    } catch (error) {
      if (!isTimeoutError(error)) {
        throw error;
      }

      this.destroy();
      return false;
    }
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.queue.splice(0, this.queue.length);
    this.recentHistory.splice(
      0,
      this.recentHistory.length,
    );
    this.languageModelSlowSamples.splice(
      0,
      this.languageModelSlowSamples.length,
    );
    this.resolveDrainWaiters();
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
      const result =
        line.skipTranslation === true
          ? {
              ja: line.text,
              recordHistory: true,
            }
          : await this.translateWithFallback(
              line.text,
            );

      if (
        this.destroyed ||
        result === null
      ) {
        return;
      }

      if (result.recordHistory) {
        this.recordHistory(
          line.text,
          result.ja,
        );
      }

      this.options.onTranslated(
        line,
        result.ja,
      );
    } finally {
      this.processing = false;
      this.runQueue();
      this.resolveDrainWaitersIfIdle();
    }
  }

  private async translateWithFallback(
    text: string,
  ): Promise<TranslationAttemptResult | null> {
    while (
      !this.destroyed &&
      this.path !== null &&
      this.path !== "none"
    ) {
      const attemptedPath = this.path;
      const startedAt = performance.now();

      try {
        const result =
          await this.translateUsingPath(
            attemptedPath,
            text,
          );
        const normalized = result.ja.trim();

        if (normalized === "") {
          throw new Error(
            "Translation returned an empty result",
          );
        }

        return {
          ...result,
          ja: normalized,
        };
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
      } finally {
        console.info(
          "[translate] latency",
          {
            ms: Math.round(
              performance.now() -
                startedAt,
            ),
            path: attemptedPath,
          },
        );
      }
    }

    return null;
  }

  private async translateUsingPath(
    path: TranslationPath,
    text: string,
  ): Promise<TranslationAttemptResult> {
    switch (path) {
      case "offscreen-translator":
        if (this.translator === null) {
          throw new Error(
            "Offscreen Translator is not initialized",
          );
        }

        return {
          ja: await this.translator.translate(
            text,
          ),
          recordHistory: true,
        };

      case "content-translator": {
        const response =
          await this.options
            .requestContentTranslation(text);

        if (!response.available) {
          throw new Error(
            "Content-script Translator became unavailable",
          );
        }

        return {
          ja: response.ja,
          recordHistory: true,
        };
      }

      case "language-model":
        return this.translateWithLanguageModel(
          text,
        );

      case "none":
        throw new Error(
          "No translation path is active",
        );
    }
  }

  private async translateWithLanguageModel(
    text: string,
  ): Promise<TranslationAttemptResult> {
    const context = this.readContext();
    const prompt = createTranslationPrompt(
      text,
      context,
    );
    const startedAt = performance.now();
    let rawResponse: string;

    try {
      rawResponse =
        await this.promptLanguageModel(
          prompt,
        );
    } catch (error) {
      const elapsedMs =
        performance.now() - startedAt;

      await this.observeLanguageModelLatency(
        elapsedMs,
      );

      if (
        !this.destroyed &&
        isTimeoutError(error)
      ) {
        console.warn(
          "[translate]",
          "LanguageModel prompt timed out; using line rescue",
          error,
        );
        return this.rescueLanguageModelLine(
          text,
        );
      }

      throw error;
    }

    await this.observeLanguageModelLatency(
      performance.now() - startedAt,
    );

    const normalized =
      normalizeLanguageModelResponse(
        rawResponse,
      );

    if (
      isBadLanguageModelResponse(
        normalized,
        text,
        context.properNouns,
      )
    ) {
      console.info(
        "[translate]",
        "LanguageModel returned an invalid translation; using line rescue",
        {
          responseLength:
            Array.from(normalized).length,
          sourceLength:
            Array.from(text).length,
        },
      );
      return this.rescueLanguageModelLine(
        text,
      );
    }

    return {
      ja: normalized,
      recordHistory: true,
    };
  }

  private async promptLanguageModel(
    prompt: string,
  ): Promise<string> {
    try {
      return await this.promptLanguageModelOnce(
        prompt,
      );
    } catch (error) {
      if (
        this.destroyed ||
        isTimeoutError(error)
      ) {
        throw error;
      }

      console.warn(
        "[translate]",
        "LanguageModel session failed; recreating the base session once",
        error,
      );

      const recreated =
        await this.recreateLanguageModel();

      if (!recreated) {
        throw error;
      }

      return this.promptLanguageModelOnce(
        prompt,
      );
    }
  }

  private async promptLanguageModelOnce(
    prompt: string,
  ): Promise<string> {
    const base = this.languageModel;

    if (base === null) {
      throw new Error(
        "LanguageModel is not initialized",
      );
    }

    const clone = await base.clone();

    if (this.destroyed) {
      destroyLanguageModelSession(
        clone,
        "LanguageModel clone",
      );
      throw new DOMException(
        "Translation session was stopped",
        "AbortError",
      );
    }

    this.languageModelClone = clone;

    try {
      return await clone.prompt(
        prompt,
        {
          signal: AbortSignal.timeout(
            LANGUAGE_MODEL_PROMPT_TIMEOUT_MS,
          ),
        },
      );
    } finally {
      if (
        this.languageModelClone === clone
      ) {
        this.languageModelClone = null;
        destroyLanguageModelSession(
          clone,
          "LanguageModel clone",
        );
      }
    }
  }

  private async recreateLanguageModel(): Promise<boolean> {
    this.destroyLanguageModel();
    this.languageModelCreateAttempted =
      false;
    this.failedPaths.delete(
      "language-model",
    );

    return this.prepareLanguageModel();
  }

  private async observeLanguageModelLatency(
    elapsedMs: number,
  ): Promise<void> {
    this.languageModelSlowSamples.push(
      elapsedMs >
        LANGUAGE_MODEL_SLOW_THRESHOLD_MS,
    );

    if (
      this.languageModelSlowSamples.length >
      LANGUAGE_MODEL_LATENCY_WINDOW
    ) {
      this.languageModelSlowSamples.shift();
    }

    const slowCount =
      this.languageModelSlowSamples.filter(
        Boolean,
      ).length;

    if (
      this.destroyed ||
      this.languageModelSlowSamples.length <
        LANGUAGE_MODEL_LATENCY_WINDOW ||
      this.failedPaths.has(
        "language-model",
      ) ||
      slowCount <
        LANGUAGE_MODEL_SLOW_LIMIT
    ) {
      return;
    }

    console.warn(
      "[translate]",
      "LanguageModel latency guard triggered; selecting a Translator path",
      {
        slowCount,
        window:
          this.languageModelSlowSamples
            .length,
      },
    );

    this.failPath("language-model");
    await this.selectBestPath();
  }

  private async rescueLanguageModelLine(
    text: string,
  ): Promise<TranslationAttemptResult> {
    for (
      const rescuePath of [
        "offscreen-translator",
        "content-translator",
      ] as const
    ) {
      if (this.failedPaths.has(rescuePath)) {
        continue;
      }

      const prepared =
        rescuePath ===
        "offscreen-translator"
          ? await this
              .prepareOffscreenTranslator()
          : await this
              .prepareContentTranslator();

      if (!prepared || this.destroyed) {
        continue;
      }

      try {
        const result =
          rescuePath ===
          "offscreen-translator"
            ? await this.translator
                ?.translate(text)
            : await this.options
                .requestContentTranslation(
                  text,
                );

        const ja =
          typeof result === "string"
            ? result.trim()
            : (
                result?.available === true
                  ? result.ja.trim()
                  : ""
              );

        if (ja === "") {
          throw new Error(
            "Translator rescue returned an empty result",
          );
        }

        return {
          ja,
          recordHistory: true,
        };
      } catch (error) {
        console.warn(
          "[translate]",
          "Translator line rescue failed",
          {
            path: rescuePath,
            error,
          },
        );

        const wasActive =
          this.path === rescuePath;
        this.failPath(rescuePath);

        if (wasActive) {
          await this.selectBestPath();
        }
      }
    }

    return {
      ja: text,
      recordHistory: false,
    };
  }

  private readContext(): TranslationContext {
    const supplied =
      this.options.getContext();

    return {
      recentPairs:
        this.recentHistory.map(
          (pair) => ({ ...pair }),
        ),
      properNouns:
        supplied.properNouns
          .map((term) => term.trim())
          .filter(
            (term, index, terms) =>
              term !== "" &&
              terms.indexOf(term) === index,
          ),
    };
  }

  private recordHistory(
    en: string,
    ja: string,
  ): void {
    this.recentHistory.push({
      en,
      ja,
    });

    if (this.recentHistory.length > 2) {
      this.recentHistory.shift();
    }
  }

  private async selectBestPath(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    if (
      this.options.backend ===
        "prompt-api" &&
      !this.failedPaths.has(
        "language-model",
      ) &&
      await this.prepareLanguageModel()
    ) {
      this.setPath("language-model");
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
      this.options.backend === "auto" &&
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
        await factory.availability({
          expectedOutputs:
            LANGUAGE_MODEL_EXPECTED_OUTPUTS,
        });

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
          expectedOutputs:
            LANGUAGE_MODEL_EXPECTED_OUTPUTS,
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

    if (this.path === path) {
      this.path = null;
    }
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
    this.resolveDrainWaitersIfIdle();
  }

  private waitForQueueToDrain():
    Promise<void> {
    if (
      !this.processing &&
      this.queue.length === 0
    ) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.drainResolvers.add(resolve);
    });
  }

  private resolveDrainWaitersIfIdle():
    void {
    if (
      this.processing ||
      this.queue.length > 0
    ) {
      return;
    }

    this.resolveDrainWaiters();
  }

  private resolveDrainWaiters(): void {
    const resolvers = [
      ...this.drainResolvers,
    ];
    this.drainResolvers.clear();

    for (const resolve of resolvers) {
      resolve();
    }
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
    const clone = this.languageModelClone;
    const session = this.languageModel;

    this.languageModelClone = null;
    this.languageModel = null;

    if (clone !== null) {
      destroyLanguageModelSession(
        clone,
        "LanguageModel clone",
      );
    }

    if (session !== null) {
      destroyLanguageModelSession(
        session,
        "LanguageModel",
      );
    }
  }
}

export function createTranslationPrompt(
  text: string,
  context: TranslationContext,
): string {
  const blocks: string[] = [];

  if (context.properNouns.length > 0) {
    blocks.push(
      [
        "[固有名詞（訳さず右の表記をそのまま出力に使う）]",
        ...context.properNouns.map(
          (term) => `${term} → ${term}`,
        ),
        "これらは固有名詞であり、一般語・地名・別の固有名詞として解釈しない。",
      ].join("\n"),
    );
  }

  if (context.recentPairs.length > 0) {
    blocks.push(
      [
        "[直前の文脈]",
        ...context.recentPairs.flatMap(
          (pair) => [
            `EN: ${pair.en}`,
            `JA: ${pair.ja}`,
          ],
        ),
      ].join("\n"),
    );
  }

  blocks.push(
    [
      "[今訳す節]",
      text,
    ].join("\n"),
  );

  return blocks.join("\n");
}

export function stripCodeFence(
  text: string,
): string {
  const sameLine = text.match(
    /^```([^\r\n]*?)```$/u,
  );

  if (sameLine !== null) {
    return sameLine[1].trim();
  }

  // The info string only exists when a
  // newline follows: without one, the
  // whole response would be consumed as
  // an info string.
  return text
    .replace(
      /^```[^\r\n]*\r?\n/u,
      "",
    )
    .replace(
      /\r?\n?```$/u,
      "",
    )
    .trim();
}

export function stripTranslationLabel(
  text: string,
): string {
  return text
    .replace(
      /^(?:翻訳|日本語訳|訳)\s*[:：]\s*/u,
      "",
    )
    .trim();
}

const WRAPPING_PAIRS: ReadonlyMap<
  string,
  string
> = new Map([
  ["「", "」"],
  ["『", "』"],
  ["“", "”"],
  ["‘", "’"],
  ['"', '"'],
  ["'", "'"],
]);

export function stripBalancedWrappingPair(
  text: string,
): string {
  const characters = Array.from(text);

  if (characters.length < 2) {
    return text;
  }

  const opener = characters[0];
  const closer =
    WRAPPING_PAIRS.get(opener);

  if (
    closer === undefined ||
    characters[characters.length - 1] !==
      closer
  ) {
    return text;
  }

  const inner = characters.slice(1, -1);

  if (opener === closer) {
    // Symmetric quotes cannot be paired
    // unambiguously, so only strip when
    // the inside has none of them.
    if (inner.includes(opener)) {
      return text;
    }

    return inner.join("").trim();
  }

  // The outer pair must be the one that
  // closes at the very end: if the depth
  // returns to zero earlier, the leading
  // opener pairs with an inner closer
  // (「A」とB) and must stay.
  let depth = 1;

  for (const character of inner) {
    if (character === opener) {
      depth += 1;
    } else if (character === closer) {
      depth -= 1;

      if (depth === 0) {
        return text;
      }
    }
  }

  if (depth !== 1) {
    return text;
  }

  return inner.join("").trim();
}

export function normalizeLanguageModelResponse(
  response: string,
): string {
  return stripBalancedWrappingPair(
    stripTranslationLabel(
      stripCodeFence(
        response.trim(),
      ),
    ),
  );
}

export function isBadLanguageModelResponse(
  response: string,
  source: string,
  properNouns: readonly string[],
): boolean {
  if (response === "") {
    return true;
  }

  if (
    response.includes("→") ||
    response.includes("[固有名詞（") ||
    response.includes("[直前の文脈]") ||
    response.includes("[今訳す節]")
  ) {
    return true;
  }

  if (
    Array.from(response).length >
    Array.from(source).length * 4
  ) {
    return true;
  }

  const withoutProperNouns =
    removeProperNouns(
      response,
      properNouns,
    );
  const characters =
    Array.from(withoutProperNouns)
      .filter(
        (character) =>
          !/\s/u.test(character),
      );

  if (characters.length === 0) {
    return false;
  }

  const latinCharacters =
    characters.filter(
      (character) =>
        /[A-Za-z]/u.test(character),
    ).length;

  return (
    latinCharacters /
      characters.length >
    0.5
  );
}

function removeProperNouns(
  response: string,
  properNouns: readonly string[],
): string {
  const exclusions = new Set<string>();

  for (const term of properNouns) {
    const trimmed = term.trim();

    if (trimmed === "") {
      continue;
    }

    exclusions.add(trimmed);

    for (
      const word of
      trimmed.match(/[A-Za-z]+/gu) ?? []
    ) {
      exclusions.add(word);
    }
  }

  const candidates =
    Array.from(exclusions)
      .sort(
        (left, right) =>
          right.length - left.length,
      );

  if (candidates.length === 0) {
    return response;
  }

  const pattern = candidates
    .map(escapeRegExp)
    .join("|");

  return response.replace(
    new RegExp(pattern, "giu"),
    "",
  );
}

function escapeRegExp(value: string): string {
  return value.replace(
    /[.*+?^${}()|[\]\\]/gu,
    "\\$&",
  );
}

function isTimeoutError(
  error: unknown,
): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "TimeoutError"
  );
}

function destroyLanguageModelSession(
  session: LanguageModelSession,
  label: string,
): void {
  try {
    session.destroy();
  } catch (error) {
    console.warn(
      "[translate]",
      `${label} cleanup failed`,
      error,
    );
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

      const timerId = globalThis.setTimeout(
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
