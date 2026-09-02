import type {
  OffDevLogData,
  OffDevLogMessage,
  RecognitionPayload,
  TranslationPath,
} from "../shared/messages";
import type {
  TranslationBackend,
} from "../shared/settings";
import type {
  MaskPlan,
  MaskedTranslationLine,
} from "./term-masking";
import {
  createMaskPlan,
  remaskPlannedTerms,
  restoreMaskedTranslation,
} from "./term-masking";

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

interface QueuedTranslation
  extends TranslationQueueEntry {
  deadlineAt: number;
}

interface TranslationAttempt {
  generation: number;
  line: QueuedTranslation;
  timeoutId:
    | ReturnType<typeof globalThis.setTimeout>
    | null;
  stale: boolean;
}

type TranslationDevLogEvent =
  Omit<
    OffDevLogMessage,
    "t" | "data"
  > & {
    data: Omit<
      OffDevLogData,
      "requestId"
    >;
  };

export class PlaceholderVerificationError
  extends Error {
  constructor() {
    super(
      "Translator rescue failed placeholder verification",
    );
    this.name =
      "PlaceholderVerificationError";
  }
}

export interface TranslationEngineOptions {
  backend: TranslationBackend;
  requestId?: string;
  getContext(): TranslationContext;
  requestContentTranslation(
    text: string,
  ): Promise<ContentTranslationResponse>;
  onTranslated(
    line: RecognitionPayload,
    ja: string,
  ): void;
  onSettled?(ids: number[]): void;
  onPathChanged(path: TranslationPath): void;
  onDevLog?(
    message: OffDevLogMessage,
  ): void | Promise<void>;
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
  "あなたは英語動画の日本語字幕翻訳者。与えられた英語の節を、直前の文脈と固有名詞リストに整合する自然な日本語に訳す。出力は当該節の訳だけ。説明・引用符・前後の節の再訳は出力しない";

const MAX_PENDING_TRANSLATIONS = 2;
export const TRANSLATOR_CREATE_TIMEOUT_MS =
  8_000;
const LANGUAGE_MODEL_PROMPT_TIMEOUT_MS =
  10_000;
export const TRANSLATION_DEADLINE_MS =
  LANGUAGE_MODEL_PROMPT_TIMEOUT_MS + 2_000;
const LANGUAGE_MODEL_SLOW_THRESHOLD_MS =
  3_000;
const LANGUAGE_MODEL_LATENCY_WINDOW = 5;
const LANGUAGE_MODEL_SLOW_LIMIT = 3;

export class TranslationEngine {
  private readonly options:
    TranslationEngineOptions;
  private readonly queue:
    QueuedTranslation[] = [];
  private readonly failedPaths =
    new Set<TranslationPath>();
  private readonly terminalIds =
    new Set<number>();
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
  private generation = 0;
  private activeAttempt:
    | TranslationAttempt
    | null = null;

  constructor(
    options: TranslationEngineOptions,
  ) {
    this.options = options;
  }

  initialize(): Promise<void> {
    return Promise.resolve();
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
      this.terminalIds.has(line.id)
    ) {
      return;
    }

    if (
      this.path === "none" &&
      !skipTranslation
    ) {
      this.settleIds([line.id]);
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
        this.settleIds([dropped.id]);
        console.warn(
          `[translate] dropped oldest pending committed clause (id=${dropped.id}, textLength=${dropped.text.length})`,
        );
        this.emitDevLog({
          level: "warn",
          tag: "translate",
          message:
            "dropped oldest pending committed clause",
          data: {
            kind: "queue-drop",
            lineId: dropped.id,
          },
        });
      }
    }

    this.queue.push({
      ...line,
      final: true,
      skipTranslation,
      deadlineAt:
        performance.now() +
        TRANSLATION_DEADLINE_MS,
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

    const pendingIds = [
      ...(this.activeAttempt === null
        ? []
        : [this.activeAttempt.line.id]),
      ...this.queue.map((line) => line.id),
    ];

    if (this.activeAttempt !== null) {
      this.activeAttempt.stale = true;
      this.clearAttemptDeadline(
        this.activeAttempt,
      );
    }

    this.destroyed = true;
    this.activeAttempt = null;
    this.processing = false;
    this.queue.splice(0, this.queue.length);
    this.settleIds(pendingIds);
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

    const line = this.queue.shift();

    if (line === undefined) {
      return;
    }

    const attempt: TranslationAttempt = {
      generation: ++this.generation,
      line,
      timeoutId: null,
      stale: false,
    };

    this.processing = true;
    this.activeAttempt = attempt;
    attempt.timeoutId =
      globalThis.setTimeout(
        () => this.expireAttempt(attempt),
        Math.ceil(
          Math.max(
            0,
            line.deadlineAt -
              performance.now(),
          ),
        ),
      );
    void this.processClause(attempt);
  }

  private async processClause(
    attempt: TranslationAttempt,
  ): Promise<void> {
    const { line } = attempt;

    try {
      if (
        line.skipTranslation !== true &&
        this.path === null
      ) {
        await this.selectBestPath(attempt);
      }

      if (!this.isAttemptCurrent(attempt)) {
        return;
      }

      const result =
        line.skipTranslation === true
          ? {
              ja: line.text,
              recordHistory: true,
            }
          : await this.translateWithFallback(
              line,
              attempt,
            );

      if (!this.isAttemptCurrent(attempt)) {
        return;
      }

      if (result === null) {
        this.settleIds([line.id]);
        return;
      }

      if (!this.markTerminal(line.id)) {
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
      if (!this.isAttemptCurrent(attempt)) {
        return;
      }

      attempt.stale = true;
      this.clearAttemptDeadline(attempt);
      this.activeAttempt = null;
      this.processing = false;
      this.runQueue();
      this.resolveDrainWaitersIfIdle();
    }
  }

  private expireAttempt(
    attempt: TranslationAttempt,
  ): void {
    if (!this.isAttemptCurrent(attempt)) {
      return;
    }

    const clone = this.languageModelClone;
    this.languageModelClone = null;

    if (clone !== null) {
      destroyLanguageModelSession(
        clone,
        "LanguageModel clone",
      );
    }

    attempt.stale = true;
    this.clearAttemptDeadline(attempt);
    this.activeAttempt = null;
    this.processing = false;
    this.settleIds([attempt.line.id]);
    this.runQueue();
    this.resolveDrainWaitersIfIdle();
  }

  private isAttemptCurrent(
    attempt: TranslationAttempt,
  ): boolean {
    return (
      !this.destroyed &&
      !attempt.stale &&
      this.processing &&
      this.activeAttempt === attempt &&
      this.generation ===
        attempt.generation
    );
  }

  private assertAttemptCurrent(
    attempt: TranslationAttempt,
  ): void {
    if (this.isAttemptCurrent(attempt)) {
      return;
    }

    throw new DOMException(
      "Translation attempt expired",
      "AbortError",
    );
  }

  private clearAttemptDeadline(
    attempt: TranslationAttempt,
  ): void {
    if (attempt.timeoutId === null) {
      return;
    }

    globalThis.clearTimeout(
      attempt.timeoutId,
    );
    attempt.timeoutId = null;
  }

  private markTerminal(id: number): boolean {
    if (this.terminalIds.has(id)) {
      return false;
    }

    this.terminalIds.add(id);
    return true;
  }

  private settleIds(
    ids: readonly number[],
  ): void {
    const settled = [...new Set(ids)]
      .sort((left, right) => left - right)
      .filter((id) =>
        this.markTerminal(id)
      );

    if (settled.length > 0) {
      this.options.onSettled?.(settled);
    }
  }

  private async translateWithFallback(
    line: TranslationQueueEntry,
    attempt: TranslationAttempt,
  ): Promise<TranslationAttemptResult | null> {
    const context = this.readContext();
    const request = createMaskPlan(
      line.text,
      context.properNouns,
    );

    while (
      this.isAttemptCurrent(attempt) &&
      this.path !== null &&
      this.path !== "none"
    ) {
      const attemptedPath = this.path;
      const startedAt = performance.now();

      try {
        const result =
          await this.translateUsingPath(
            attemptedPath,
            request,
            context,
            line.id,
            attempt,
          );

        if (!this.isAttemptCurrent(attempt)) {
          return null;
        }

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
        if (!this.isAttemptCurrent(attempt)) {
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

        this.failPath(
          attemptedPath,
          attempt,
        );
        await this.selectBestPath(attempt);
      } finally {
        if (!this.isAttemptCurrent(attempt)) {
          continue;
        }

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
    request: MaskedTranslationLine,
    context: TranslationContext,
    lineId: number,
    attempt: TranslationAttempt,
  ): Promise<TranslationAttemptResult> {
    switch (path) {
      case "offscreen-translator":
        if (request.maskPlan !== null) {
          return this.rescueLanguageModelLine(
            request,
            lineId,
            attempt,
          );
        }

        if (this.translator === null) {
          throw new Error(
            "Offscreen Translator is not initialized",
          );
        }

        return {
          ja: await this.translator.translate(
            request.original,
          ),
          recordHistory: true,
        };

      case "content-translator": {
        if (request.maskPlan !== null) {
          return this.rescueLanguageModelLine(
            request,
            lineId,
            attempt,
          );
        }

        const response =
          await this.options
            .requestContentTranslation(
              request.original,
            );

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
          request,
          context,
          lineId,
          attempt,
        );

      case "none":
        throw new Error(
          "No translation path is active",
        );
    }
  }

  private async translateWithLanguageModel(
    request: MaskedTranslationLine,
    context: TranslationContext,
    lineId: number,
    attempt: TranslationAttempt,
  ): Promise<TranslationAttemptResult> {
    const prompt = createTranslationPrompt(
      request.masked,
      context,
      request.maskPlan,
    );
    const startedAt = performance.now();
    let rawResponse: string;

    try {
      rawResponse =
        await this.promptLanguageModel(
          prompt,
          attempt,
        );
      this.assertAttemptCurrent(attempt);
    } catch (error) {
      const elapsedMs =
        performance.now() - startedAt;

      await this.observeLanguageModelLatency(
        elapsedMs,
        attempt,
      );
      this.assertAttemptCurrent(attempt);

      if (
        isTimeoutError(error)
      ) {
        console.warn(
          "[translate]",
          "LanguageModel prompt timed out; using line rescue",
          error,
        );
        return this.rescueLanguageModelLine(
          request,
          lineId,
          attempt,
        );
      }

      throw error;
    }

    await this.observeLanguageModelLatency(
      performance.now() - startedAt,
      attempt,
    );
    this.assertAttemptCurrent(attempt);

    const normalized =
      normalizeLanguageModelResponse(
        rawResponse,
      );
    const restored =
      restoreMaskedTranslation(
        normalized,
        request.maskPlan,
      );

    if (restored === null) {
      console.info(
        "[translate]",
        "LanguageModel placeholder verification failed; using line rescue",
        {
          responseLength:
            Array.from(normalized).length,
          sourceLength:
            Array.from(request.original).length,
        },
      );
      return this.rescueLanguageModelLine(
        request,
        lineId,
        attempt,
      );
    }

    if (
      isBadLanguageModelResponse(
        restored,
        request.original,
        context.properNouns,
      )
    ) {
      console.info(
        "[translate]",
        "LanguageModel returned an invalid translation; using line rescue",
        {
          responseLength:
            Array.from(restored).length,
          sourceLength:
            Array.from(request.original).length,
        },
      );
      return this.rescueLanguageModelLine(
        request,
        lineId,
        attempt,
      );
    }

    return {
      ja: restored,
      recordHistory: true,
    };
  }

  private async promptLanguageModel(
    prompt: string,
    attempt: TranslationAttempt,
  ): Promise<string> {
    try {
      return await this.promptLanguageModelOnce(
        prompt,
        attempt,
      );
    } catch (error) {
      if (
        !this.isAttemptCurrent(attempt) ||
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
        await this.recreateLanguageModel(
          attempt,
        );

      if (!recreated) {
        throw error;
      }

      return this.promptLanguageModelOnce(
        prompt,
        attempt,
      );
    }
  }

  private async promptLanguageModelOnce(
    prompt: string,
    attempt: TranslationAttempt,
  ): Promise<string> {
    const base = this.languageModel;

    if (base === null) {
      throw new Error(
        "LanguageModel is not initialized",
      );
    }

    const clone = await base.clone();

    if (!this.isAttemptCurrent(attempt)) {
      destroyLanguageModelSession(
        clone,
        "LanguageModel clone",
      );
      this.assertAttemptCurrent(attempt);
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
        this.isAttemptCurrent(attempt) &&
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

  private async recreateLanguageModel(
    attempt: TranslationAttempt,
  ): Promise<boolean> {
    this.assertAttemptCurrent(attempt);
    this.destroyLanguageModel(attempt);
    this.languageModelCreateAttempted =
      false;
    this.failedPaths.delete(
      "language-model",
    );

    return this.prepareLanguageModel(
      attempt,
    );
  }

  private async observeLanguageModelLatency(
    elapsedMs: number,
    attempt: TranslationAttempt,
  ): Promise<void> {
    if (!this.isAttemptCurrent(attempt)) {
      return;
    }

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
      !this.isAttemptCurrent(attempt) ||
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

    this.failPath(
      "language-model",
      attempt,
    );
    await this.selectBestPath(attempt);
  }

  private async rescueLanguageModelLine(
    request: MaskedTranslationLine,
    lineId: number,
    attempt: TranslationAttempt,
  ): Promise<TranslationAttemptResult> {
    for (
      const rescuePath of [
        "offscreen-translator",
        "content-translator",
      ] as const
    ) {
      this.assertAttemptCurrent(attempt);

      if (this.failedPaths.has(rescuePath)) {
        continue;
      }

      const prepared =
        rescuePath ===
        "offscreen-translator"
          ? await this
              .prepareOffscreenTranslator(
                attempt,
              )
          : await this
              .prepareContentTranslator(
                attempt,
              );

      this.assertAttemptCurrent(attempt);

      if (!prepared) {
        continue;
      }

      try {
        const result =
          rescuePath ===
          "offscreen-translator"
            ? await this.translator
                ?.translate(request.masked)
            : await this.options
                .requestContentTranslation(
                  request.masked,
                );

        this.assertAttemptCurrent(attempt);

        if (result === undefined) {
          throw new Error(
            "Translator rescue is not initialized",
          );
        }

        if (
          typeof result !== "string" &&
          !result.available
        ) {
          throw new Error(
            "Content-script Translator rescue became unavailable",
          );
        }

        const ja =
          (
            typeof result === "string"
              ? result
              : result.ja
          ).trim();

        if (ja === "") {
          throw new Error(
            "Translator rescue returned an empty result",
          );
        }

        const restored =
          restoreMaskedTranslation(
            ja,
            request.maskPlan,
          );

        if (restored === null) {
          throw new PlaceholderVerificationError();
        }

        return {
          ja: restored,
          recordHistory: true,
        };
      } catch (error) {
        this.assertAttemptCurrent(attempt);

        console.warn(
          "[translate]",
          "Translator line rescue failed",
          {
            path: rescuePath,
            error,
          },
        );
        this.emitDevLog(
          {
            level: "warn",
            tag: "translate",
            message:
              "Translator line rescue failed",
            data: {
              kind: "rescue-failure",
              lineId,
              path: rescuePath,
            },
          },
          attempt,
        );

        if (
          error instanceof
          PlaceholderVerificationError
        ) {
          continue;
        }

        const wasActive =
          this.path === rescuePath;
        this.failPath(
          rescuePath,
          attempt,
        );

        if (wasActive) {
          await this.selectBestPath(attempt);
        }
      }
    }

    this.assertAttemptCurrent(attempt);
    this.emitDevLog(
      {
        level: "info",
        tag: "translate",
        message:
          "Translator line rescue exhausted; passing through original",
        data: {
          kind: "passthrough",
          lineId,
        },
      },
      attempt,
    );

    return {
      ja: request.original,
      recordHistory: false,
    };
  }

  private emitDevLog(
    event: TranslationDevLogEvent,
    attempt?: TranslationAttempt,
  ): void {
    if (
      attempt !== undefined &&
      !this.isAttemptCurrent(attempt)
    ) {
      return;
    }

    try {
      const requestId =
        this.options.requestId;
      const onDevLog =
        this.options.onDevLog;

      if (
        requestId === undefined ||
        onDevLog === undefined
      ) {
        return;
      }

      const message: OffDevLogMessage = {
        t: "OFF_DEV_LOG",
        level: event.level,
        tag: event.tag,
        message: event.message,
        data: {
          kind: event.data.kind,
          requestId,
          lineId: event.data.lineId,
          ...(event.data.path === undefined
            ? {}
            : { path: event.data.path }),
        },
      };
      const pending = onDevLog(message);

      if (pending !== undefined) {
        void Promise.resolve(pending).catch(
          () => undefined,
        );
      }
    } catch {
      return;
    }
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

  private async selectBestPath(
    attempt: TranslationAttempt,
  ): Promise<void> {
    if (!this.isAttemptCurrent(attempt)) {
      return;
    }

    if (
      this.options.backend ===
        "prompt-api" &&
      !this.failedPaths.has(
        "language-model",
      )
    ) {
      const prepared =
        await this.prepareLanguageModel(
          attempt,
        );

      if (!this.isAttemptCurrent(attempt)) {
        return;
      }

      if (prepared) {
        this.setPath(
          "language-model",
          attempt,
        );
        return;
      }
    }

    if (
      !this.failedPaths.has(
        "offscreen-translator",
      )
    ) {
      const prepared =
        await this.prepareOffscreenTranslator(
          attempt,
        );

      if (!this.isAttemptCurrent(attempt)) {
        return;
      }

      if (prepared) {
        this.setPath(
          "offscreen-translator",
          attempt,
        );
        return;
      }
    }

    if (
      !this.failedPaths.has(
        "content-translator",
      )
    ) {
      const prepared =
        await this.prepareContentTranslator(
          attempt,
        );

      if (!this.isAttemptCurrent(attempt)) {
        return;
      }

      if (prepared) {
        this.setPath(
          "content-translator",
          attempt,
        );
        return;
      }
    }

    if (
      this.options.backend === "auto" &&
      !this.failedPaths.has(
        "language-model",
      )
    ) {
      const prepared =
        await this.prepareLanguageModel(
          attempt,
        );

      if (!this.isAttemptCurrent(attempt)) {
        return;
      }

      if (prepared) {
        this.setPath(
          "language-model",
          attempt,
        );
        return;
      }
    }

    this.setPath("none", attempt);
  }

  private async prepareOffscreenTranslator(
    attempt: TranslationAttempt,
  ): Promise<boolean> {
    if (!this.isAttemptCurrent(attempt)) {
      return false;
    }

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
        !this.isAttemptCurrent(attempt) ||
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
        const translator =
          await waitWithTimeout(
            createPromise,
            TRANSLATOR_CREATE_TIMEOUT_MS,
            "Offscreen Translator creation timed out",
          );

        if (!this.isAttemptCurrent(attempt)) {
          destroyTranslatorInstance(
            translator,
          );
          return false;
        }

        this.translator = translator;
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

      return true;
    } catch (error) {
      if (!this.isAttemptCurrent(attempt)) {
        return false;
      }

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

  private async prepareContentTranslator(
    attempt: TranslationAttempt,
  ): Promise<boolean> {
    if (!this.isAttemptCurrent(attempt)) {
      return false;
    }

    try {
      const response =
        await this.options
          .requestContentTranslation("");

      return (
        this.isAttemptCurrent(attempt) &&
        response.available
      );
    } catch (error) {
      if (!this.isAttemptCurrent(attempt)) {
        return false;
      }

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

  private async prepareLanguageModel(
    attempt: TranslationAttempt,
  ): Promise<boolean> {
    if (!this.isAttemptCurrent(attempt)) {
      return false;
    }

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
        !this.isAttemptCurrent(attempt) ||
        availability !== "available"
      ) {
        return false;
      }

      this.languageModelCreateAttempted =
        true;
      const languageModel =
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

      if (!this.isAttemptCurrent(attempt)) {
        destroyLanguageModelSession(
          languageModel,
          "LanguageModel",
        );
        return false;
      }

      this.languageModel = languageModel;
      return true;
    } catch (error) {
      if (!this.isAttemptCurrent(attempt)) {
        return false;
      }

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
    attempt: TranslationAttempt,
  ): void {
    if (!this.isAttemptCurrent(attempt)) {
      return;
    }

    this.failedPaths.add(path);

    if (path === "offscreen-translator") {
      this.destroyTranslator(attempt);
    }

    if (path === "language-model") {
      this.destroyLanguageModel(attempt);
    }

    if (this.path === path) {
      this.path = null;
    }
  }

  private setPath(
    path: TranslationPath,
    attempt: TranslationAttempt,
  ): void {
    if (
      !this.isAttemptCurrent(attempt) ||
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
      const fallbackIds =
        this.queue
          .filter(
            (line) =>
              line.skipTranslation !== true,
          )
          .map((line) => line.id);

      this.settleIds(fallbackIds);

      if (!this.isAttemptCurrent(attempt)) {
        return;
      }

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

  private destroyTranslator(
    attempt?: TranslationAttempt,
  ): void {
    if (
      attempt !== undefined &&
      !this.isAttemptCurrent(attempt)
    ) {
      return;
    }

    const instance = this.translator;
    this.translator = null;

    if (instance !== null) {
      destroyTranslatorInstance(
        instance,
      );
    }
  }

  private destroyLanguageModel(
    attempt?: TranslationAttempt,
  ): void {
    if (
      attempt !== undefined &&
      !this.isAttemptCurrent(attempt)
    ) {
      return;
    }

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

function createTranslationPrompt(
  text: string,
  context: TranslationContext,
  maskPlan: MaskPlan | null,
): string {
  const blocks: string[] = [];
  const maskedTerms = new Set(
    maskPlan?.entries.map(
      (entry) => entry.term,
    ) ?? [],
  );
  const promptProperNouns =
    context.properNouns.filter(
      (term) => !maskedTerms.has(term),
    );
  const renderHistoryText = (
    value: string,
  ): string =>
    maskPlan === null
      ? value
      : remaskPlannedTerms(
          value,
          maskPlan,
        );

  if (promptProperNouns.length > 0) {
    blocks.push(
      [
        "[固有名詞（原綴りのまま使う）]",
        promptProperNouns.join(", "),
      ].join("\n"),
    );
  }

  if (context.recentPairs.length > 0) {
    blocks.push(
      [
        "[直前の文脈]",
        ...context.recentPairs.flatMap(
          (pair) => [
            `EN: ${renderHistoryText(pair.en)}`,
            `JA: ${renderHistoryText(pair.ja)}`,
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

function isBadLanguageModelResponse(
  response: string,
  source: string,
  properNouns: readonly string[],
): boolean {
  if (response === "") {
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
