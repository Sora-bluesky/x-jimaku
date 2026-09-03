import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  normalizeLanguageModelResponse,
  stripBalancedWrappingPair,
  stripCodeFence,
  stripTranslationLabel,
  TRANSLATION_DEADLINE_MS,
  TRANSLATOR_CREATE_TIMEOUT_MS,
  TranslationEngine,
} from "./translate";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve:
    | ((value: T) => void)
    | undefined;
  let reject:
    | ((error: unknown) => void)
    | undefined;

  const promise = new Promise<T>(
    (
      promiseResolve,
      promiseReject,
    ) => {
      resolve = promiseResolve;
      reject = promiseReject;
    },
  );

  return {
    promise,
    resolve(value) {
      resolve?.(value);
    },
    reject(error) {
      reject?.(error);
    },
  };
}

function createGateEngine(
  backend:
    | "translator"
    | "prompt-api"
    | "auto" = "translator",
) {
  const onSettled = vi.fn();
  const onTranslated = vi.fn();
  const onPathChanged = vi.fn();
  const onDevLog = vi.fn();
  const engine =
    new TranslationEngine({
      backend,
      requestId: "request-gate",
      getContext: () => ({
        recentPairs: [],
        properNouns: [],
      }),
      requestContentTranslation:
        vi.fn(async () => ({
          available: false,
          ja: "",
        })),
      onSettled,
      onTranslated,
      onPathChanged,
      onDevLog,
    });

  return {
    engine,
    onSettled,
    onTranslated,
    onPathChanged,
    onDevLog,
  };
}

function installTranslator(
  translate: () => Promise<string>,
): ReturnType<typeof vi.fn> {
  const destroy = vi.fn();

  vi.stubGlobal("Translator", {
    availability: vi.fn(
      async () => "available",
    ),
    create: vi.fn(async () => ({
      translate: vi.fn(translate),
      destroy,
    })),
  });

  return destroy;
}

function createRescueHarness(
  translatorRespond: (
    text: string,
  ) => Promise<string>,
  contentRespond: (
    text: string,
  ) => Promise<{
    available: boolean;
    ja: string;
  }>,
) {
  const prompt = vi.fn(
    async () => "ここです",
  );
  const translator = {
    translate: vi.fn(translatorRespond),
    destroy: vi.fn(),
  };

  vi.stubGlobal("LanguageModel", {
    availability: vi.fn(
      async () => "available",
    ),
    create: vi.fn(async () => ({
      clone: vi.fn(async () => ({
        prompt,
        destroy: vi.fn(),
      })),
      destroy: vi.fn(),
    })),
  });
  vi.stubGlobal("Translator", {
    availability: vi.fn(
      async () => "available",
    ),
    create: vi.fn(
      async () => translator,
    ),
  });

  const requestContentTranslation =
    vi.fn(async (text: string) => {
      if (text === "") {
        return {
          available: true,
          ja: "",
        };
      }

      return contentRespond(text);
    });
  const onTranslated = vi.fn();
  const onDevLog = vi.fn();
  const engine =
    new TranslationEngine({
      backend: "prompt-api",
      requestId: "request-63",
      getContext: () => ({
        recentPairs: [],
        properNouns: ["Roman"],
      }),
      requestContentTranslation,
      onTranslated,
      onPathChanged: vi.fn(),
      onDevLog,
    });

  vi.spyOn(
    console,
    "warn",
  ).mockImplementation(() => {
  });

  return {
    engine,
    translator,
    requestContentTranslation,
    onTranslated,
    onDevLog,
  };
}

async function translateRescueClause(
  engine: TranslationEngine,
  id: number,
  text: string,
): Promise<void> {
  engine.enqueue({
    id,
    text,
    final: true,
    at: "2026-08-30T00:00:00.000Z",
  });

  await expect(
    engine.drain(),
  ).resolves.toBe(true);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("stripCodeFence", () => {
  it("strips a fenced block", () => {
    expect(
      stripCodeFence(
        "```\nこんにちは\n```",
      ),
    ).toBe("こんにちは");
  });

  it("strips a fence with a language tag", () => {
    expect(
      stripCodeFence(
        "```text\nこんにちは\n```",
      ),
    ).toBe("こんにちは");
  });

  it("strips CRLF fences", () => {
    expect(
      stripCodeFence(
        "```\r\nこんにちは\r\n```",
      ),
    ).toBe("こんにちは");
  });

  it("strips a same-line fence without eating the content", () => {
    expect(
      stripCodeFence(
        "```こんにちは```",
      ),
    ).toBe("こんにちは");
  });

  it("strips a fence whose closing has no newline", () => {
    expect(
      stripCodeFence(
        "```text\nこんにちは```",
      ),
    ).toBe("こんにちは");
  });

  it("leaves plain text alone", () => {
    expect(
      stripCodeFence("こんにちは"),
    ).toBe("こんにちは");
  });
});

describe("stripTranslationLabel", () => {
  it.each([
    ["翻訳: こんにちは"],
    ["翻訳： こんにちは"],
    ["訳: こんにちは"],
    ["日本語訳: こんにちは"],
  ])(
    "strips the label from %j",
    (input) => {
      expect(
        stripTranslationLabel(input),
      ).toBe("こんにちは");
    },
  );

  it("only strips at the start", () => {
    expect(
      stripTranslationLabel(
        "これは翻訳: です",
      ),
    ).toBe("これは翻訳: です");
  });

  it("leaves unlabeled text alone", () => {
    expect(
      stripTranslationLabel("こんにちは"),
    ).toBe("こんにちは");
  });
});

describe("stripBalancedWrappingPair", () => {
  it("strips a single wrapping かぎ括弧 pair", () => {
    expect(
      stripBalancedWrappingPair(
        "「こんにちは」",
      ),
    ).toBe("こんにちは");
  });

  it("strips a single wrapping 二重かぎ括弧 pair", () => {
    expect(
      stripBalancedWrappingPair(
        "『こんにちは』",
      ),
    ).toBe("こんにちは");
  });

  it("strips wrapping straight double quotes", () => {
    expect(
      stripBalancedWrappingPair(
        '"こんにちは"',
      ),
    ).toBe("こんにちは");
  });

  it("strips wrapping straight single quotes", () => {
    expect(
      stripBalancedWrappingPair(
        "'こんにちは'",
      ),
    ).toBe("こんにちは");
  });

  it("strips wrapping curly double quotes", () => {
    expect(
      stripBalancedWrappingPair(
        "“こんにちは”",
      ),
    ).toBe("こんにちは");
  });

  it("strips only one level", () => {
    expect(
      stripBalancedWrappingPair(
        "「「こんにちは」」",
      ),
    ).toBe("「こんにちは」");
  });

  it("keeps 「A」とB style inner brackets", () => {
    expect(
      stripBalancedWrappingPair(
        "「A」とB",
      ),
    ).toBe("「A」とB");
  });

  it("keeps an unmatched opening bracket", () => {
    expect(
      stripBalancedWrappingPair(
        "「今からが本番",
      ),
    ).toBe("「今からが本番");
  });

  it("keeps an unmatched closing bracket", () => {
    expect(
      stripBalancedWrappingPair(
        "終わりです」",
      ),
    ).toBe("終わりです」");
  });

  it("keeps crossed brackets", () => {
    expect(
      stripBalancedWrappingPair(
        "「A『B」C』",
      ),
    ).toBe("「A『B」C』");
  });

  it("keeps a pair closing before the end", () => {
    expect(
      stripBalancedWrappingPair(
        "「A」と「B」",
      ),
    ).toBe("「A」と「B」");
  });

  it("preserves nesting that spans the whole string", () => {
    expect(
      stripBalancedWrappingPair(
        "「彼は「B」と言った」",
      ),
    ).toBe("彼は「B」と言った");
  });

  it("keeps symmetric quotes reused inside", () => {
    expect(
      stripBalancedWrappingPair(
        '"A" と "B"',
      ),
    ).toBe('"A" と "B"');
  });

  it("keeps mismatched pair kinds", () => {
    expect(
      stripBalancedWrappingPair(
        "「こんにちは』",
      ),
    ).toBe("「こんにちは』");
  });

  it("leaves a lone bracket alone", () => {
    expect(
      stripBalancedWrappingPair("「"),
    ).toBe("「");
  });

  it("leaves an empty string alone", () => {
    expect(
      stripBalancedWrappingPair(""),
    ).toBe("");
  });
});

describe("normalizeLanguageModelResponse", () => {
  it("applies fence, label, and bracket steps in order", () => {
    expect(
      normalizeLanguageModelResponse(
        "```\n翻訳: 「こんにちは」\n```",
      ),
    ).toBe("こんにちは");
  });

  it("strips a label followed by a wrapped string", () => {
    expect(
      normalizeLanguageModelResponse(
        "日本語訳： 「こんにちは」",
      ),
    ).toBe("こんにちは");
  });

  it("keeps a continuing quotation opener", () => {
    expect(
      normalizeLanguageModelResponse(
        "「今からが本番",
      ),
    ).toBe("「今からが本番");
  });

  it("keeps 「A」とB style inputs intact", () => {
    expect(
      normalizeLanguageModelResponse(
        "「A」とB",
      ),
    ).toBe("「A」とB");
  });

  it("trims surrounding whitespace", () => {
    expect(
      normalizeLanguageModelResponse(
        "  こんにちは  ",
      ),
    ).toBe("こんにちは");
  });
});

describe("TranslationEngine initialization", () => {
  it(
    "prepares an available path without creating a downloadable Translator",
    async () => {
      const translatorAvailability =
        vi.fn(
          async () => "downloadable",
        );
      const translatorCreate =
        vi.fn(async () => ({
          translate: vi.fn(
            async () => "unused",
          ),
          destroy: vi.fn(),
        }));
      const languageModelCreate =
        vi.fn(async () => ({
          clone: vi.fn(),
          destroy: vi.fn(),
        }));

      vi.stubGlobal("Translator", {
        availability:
          translatorAvailability,
        create: translatorCreate,
      });
      vi.stubGlobal("LanguageModel", {
        availability: vi.fn(
          async () => "available",
        ),
        create: languageModelCreate,
      });

      const gate =
        createGateEngine("auto");

      await gate.engine.initialize();

      expect(translatorAvailability)
        .toHaveBeenCalledOnce();
      expect(translatorCreate)
        .not.toHaveBeenCalled();
      expect(languageModelCreate)
        .toHaveBeenCalledOnce();
      expect(gate.engine.getPath())
        .toBe("language-model");
      expect(gate.onPathChanged)
        .toHaveBeenCalledWith(
          "language-model",
        );

      gate.engine.destroy();
    },
  );

  it(
    "shares in-flight preparation with initialize callers and a clause",
    async () => {
      vi.useFakeTimers();
      const availability =
        createDeferred<"downloadable">();
      const availabilityCheck =
        vi.fn(
          () => availability.promise,
        );
      const create = vi.fn();

      vi.stubGlobal("Translator", {
        availability: availabilityCheck,
        create,
      });

      const gate = createGateEngine();
      const initialization =
        gate.engine.initialize();

      expect(gate.engine.initialize())
        .toBe(initialization);

      await vi.advanceTimersByTimeAsync(0);
      expect(availabilityCheck)
        .toHaveBeenCalledOnce();

      gate.engine.enqueue({
        id: 1,
        text: "wait for preparation",
        final: true,
        at: "2026-09-02T00:00:01.000Z",
      });

      await vi.advanceTimersByTimeAsync(
        TRANSLATION_DEADLINE_MS,
      );

      expect(availabilityCheck)
        .toHaveBeenCalledOnce();
      expect(create).not.toHaveBeenCalled();
      expect(gate.onSettled)
        .toHaveBeenCalledWith([1]);

      gate.engine.destroy();
      availability.resolve("downloadable");
      await initialization;
    },
  );

  it(
    "destroys a Translator created after initialization is cancelled",
    async () => {
      const translator = {
        translate: vi.fn(
          async () => "unused",
        ),
        destroy: vi.fn(),
      };
      const created =
        createDeferred<typeof translator>();
      const create =
        vi.fn(() => created.promise);

      vi.stubGlobal("Translator", {
        availability: vi.fn(
          async () => "available",
        ),
        create,
      });

      const gate = createGateEngine();
      const initialization =
        gate.engine.initialize();

      await vi.waitFor(() => {
        expect(create)
          .toHaveBeenCalledOnce();
      });

      gate.engine.destroy();
      created.resolve(translator);
      await initialization;

      expect(translator.destroy)
        .toHaveBeenCalledOnce();
      expect(gate.engine.getPath())
        .toBeNull();
      expect(gate.onPathChanged)
        .not.toHaveBeenCalled();
    },
  );

  it(
    "does not block recognizer startup on preparation",
    async () => {
      const availability =
        createDeferred<"downloadable">();
      const availabilityCheck =
        vi.fn(
          () => availability.promise,
        );
      const order: string[] = [];

      vi.stubGlobal("Translator", {
        availability: availabilityCheck,
        create: vi.fn(),
      });

      const gate = createGateEngine();
      const initialization =
        gate.engine
          .initialize()
          .then(() => {
            order.push("translation");
          });
      const recognizerStarted =
        Promise.resolve().then(() => {
          order.push("recognizer");
        });

      await recognizerStarted;

      expect(availabilityCheck)
        .toHaveBeenCalledOnce();
      expect(order)
        .toEqual(["recognizer"]);

      gate.engine.destroy();
      availability.resolve("downloadable");
      await initialization;
    },
  );
});

describe(
  "TranslationEngine rescue classification",
  () => {
    it(
      "tries the second path after a semantic failure without failing the first path",
      async () => {
        const harness =
          createRescueHarness(
            async () => "ここです",
            async () => ({
              available: true,
              ja: "%%1%%です",
            }),
          );

        await harness.engine.initialize();
        await translateRescueClause(
          harness.engine,
          1,
          "Roman is here.",
        );

        expect(
          harness.translator.translate,
        ).toHaveBeenCalledWith(
          "%%1%% is here.",
        );
        expect(
          harness.requestContentTranslation,
        ).toHaveBeenCalledWith(
          "%%1%% is here.",
        );
        expect(
          harness.translator.destroy,
        ).not.toHaveBeenCalled();
        expect(
          harness.onTranslated,
        ).toHaveBeenCalledWith(
          expect.objectContaining({ id: 1 }),
          "Romanです",
        );

        harness.engine.destroy();
      },
    );

    it(
      "keeps both paths alive for the next line after persistent semantic failures",
      async () => {
        const harness =
          createRescueHarness(
            async () => "ここです",
            async () => ({
              available: true,
              ja: "ここです",
            }),
          );

        await harness.engine.initialize();
        await translateRescueClause(
          harness.engine,
          11,
          "Roman is here.",
        );
        await translateRescueClause(
          harness.engine,
          12,
          "Roman is there.",
        );

        expect(
          harness.translator.translate,
        ).toHaveBeenCalledTimes(2);
        expect(
          harness.requestContentTranslation
            .mock.calls.filter(
              ([text]) => text !== "",
            ),
        ).toHaveLength(2);
        expect(
          harness.translator.destroy,
        ).not.toHaveBeenCalled();
        expect(
          harness.onTranslated,
        ).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({ id: 11 }),
          "Roman is here.",
        );
        expect(
          harness.onTranslated,
        ).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({ id: 12 }),
          "Roman is there.",
        );
        expect(
          harness.onDevLog,
        ).toHaveBeenCalledWith({
          t: "OFF_DEV_LOG",
          level: "info",
          tag: "translate",
          message:
            "Translator line rescue exhausted; passing through original",
          data: {
            kind: "passthrough",
            requestId: "request-63",
            lineId: 11,
          },
        });

        harness.engine.destroy();
      },
    );

    it.each([
      {
        name: "an empty result",
        respond: async (
          _text: string,
        ) => "",
      },
      {
        name: "an undefined result",
        respond: async (
          _text: string,
        ) =>
          undefined as unknown as string,
      },
      {
        name: "an infrastructure exception",
        respond: async (
          _text: string,
        ) => {
          throw new Error(
            "Translator failed",
          );
        },
      },
    ])(
      "fails the path after $name",
      async ({ respond }) => {
        const harness =
          createRescueHarness(
            respond,
            async () => ({
              available: true,
              ja: "%%1%%です",
            }),
          );

        await harness.engine.initialize();
        await translateRescueClause(
          harness.engine,
          21,
          "Roman is here.",
        );
        await translateRescueClause(
          harness.engine,
          22,
          "Roman is there.",
        );

        expect(
          harness.translator.translate,
        ).toHaveBeenCalledTimes(1);
        expect(
          harness.translator.destroy,
        ).toHaveBeenCalledOnce();
        expect(
          harness.onTranslated,
        ).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({ id: 21 }),
          "Romanです",
        );
        expect(
          harness.onTranslated,
        ).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({ id: 22 }),
          "Romanです",
        );

        harness.engine.destroy();
      },
    );

    it(
      "fails an unavailable content rescue path instead of treating it as semantic",
      async () => {
        const harness =
          createRescueHarness(
            async () => "ここです",
            async () => ({
              available: false,
              ja: "",
            }),
          );

        await harness.engine.initialize();
        await translateRescueClause(
          harness.engine,
          31,
          "Roman is here.",
        );
        await translateRescueClause(
          harness.engine,
          32,
          "Roman is there.",
        );

        expect(
          harness.translator.translate,
        ).toHaveBeenCalledTimes(2);
        expect(
          harness.requestContentTranslation,
        ).toHaveBeenCalledTimes(2);
        expect(
          harness.onTranslated,
        ).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({ id: 31 }),
          "Roman is here.",
        );
        expect(
          harness.onTranslated,
        ).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({ id: 32 }),
          "Roman is there.",
        );

        harness.engine.destroy();
      },
    );
  },
);

describe(
  "TranslationEngine queue capacity",
  () => {
    it(
      "keeps stop-flush clauses when the live queue is full",
      async () => {
        const first =
          createDeferred<string>();
        const second =
          createDeferred<string>();
        const third =
          createDeferred<string>();
        const pending = [
          first,
          second,
          third,
        ];
        const translate = vi.fn(() => {
          const next = pending.shift();

          if (next === undefined) {
            return Promise.reject(
              new Error(
                "Unexpected translation call",
              ),
            );
          }

          return next.promise;
        });

        installTranslator(translate);

        const warning = vi
          .spyOn(console, "warn")
          .mockImplementation(() => {
          });
        const onTranslated = vi.fn();
        const engine =
          new TranslationEngine({
            backend: "translator",
            getContext: () => ({
              recentPairs: [],
              properNouns: [],
            }),
            requestContentTranslation:
              vi.fn(async () => ({
                available: false,
                ja: "",
              })),
            onTranslated,
            onPathChanged: vi.fn(),
          });

        await engine.initialize();

        engine.enqueue({
          id: 1,
          text: "first",
          final: true,
          at: "2026-08-30T00:00:00.000Z",
        });
        engine.enqueue({
          id: 2,
          text: "second",
          final: true,
          at: "2026-08-30T00:00:01.000Z",
        });
        engine.enqueue(
          {
            id: 3,
            text: "third",
            final: true,
            at: "2026-08-30T00:00:02.000Z",
          },
          { stopFlush: true },
        );

        const drainPromise = engine.drain();

        expect(warning).not.toHaveBeenCalled();

        first.resolve("一");
        await vi.waitFor(() => {
          expect(translate).toHaveBeenCalledTimes(
            2,
          );
        });

        second.resolve("二");
        await vi.waitFor(() => {
          expect(translate).toHaveBeenCalledTimes(
            3,
          );
        });

        third.resolve("三");

        await expect(
          drainPromise,
        ).resolves.toBe(true);
        expect(
          onTranslated,
        ).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({ id: 1 }),
          "一",
        );
        expect(
          onTranslated,
        ).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({ id: 2 }),
          "二",
        );
        expect(
          onTranslated,
        ).toHaveBeenNthCalledWith(
          3,
          expect.objectContaining({ id: 3 }),
          "三",
        );

        engine.destroy();
      },
    );

    it(
      "keeps the live-path drop and logs only id and text length",
      async () => {
        const first =
          createDeferred<string>();
        const third =
          createDeferred<string>();
        const pending = [first, third];
        const translate = vi.fn(() => {
          const next = pending.shift();

          if (next === undefined) {
            return Promise.reject(
              new Error(
                "Unexpected translation call",
              ),
            );
          }

          return next.promise;
        });

        installTranslator(translate);

        const warning = vi
          .spyOn(console, "warn")
          .mockImplementation(() => {
          });
        const onTranslated = vi.fn();
        const engine =
          new TranslationEngine({
            backend: "translator",
            getContext: () => ({
              recentPairs: [],
              properNouns: [],
            }),
            requestContentTranslation:
              vi.fn(async () => ({
                available: false,
                ja: "",
              })),
            onTranslated,
            onPathChanged: vi.fn(),
          });

        await engine.initialize();

        engine.enqueue({
          id: 1,
          text: "first",
          final: true,
          at: "2026-08-30T00:00:00.000Z",
        });
        engine.enqueue({
          id: 2,
          text: "second",
          final: true,
          at: "2026-08-30T00:00:01.000Z",
        });
        engine.enqueue({
          id: 3,
          text: "third",
          final: true,
          at: "2026-08-30T00:00:02.000Z",
        });

        expect(warning.mock.calls).toEqual([
          [
            "[translate] dropped oldest pending committed clause (id=2, textLength=6)",
          ],
        ]);

        const drainPromise = engine.drain();

        first.resolve("一");
        await vi.waitFor(() => {
          expect(translate).toHaveBeenCalledTimes(
            2,
          );
        });

        third.resolve("三");

        await expect(
          drainPromise,
        ).resolves.toBe(true);
        expect(
          onTranslated,
        ).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({ id: 1 }),
          "一",
        );
        expect(
          onTranslated,
        ).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({ id: 3 }),
          "三",
        );
        expect(
          onTranslated,
        ).not.toHaveBeenCalledWith(
          expect.objectContaining({ id: 2 }),
          expect.anything(),
        );

        engine.destroy();
      },
    );
  },
);

describe("TranslationEngine terminal protocol", () => {
  it.each([
    {
      name: "translated",
      translate: async () => "訳",
      advanceMs: 0,
      outcome: "translated",
      deadlineExpired: false,
    },
    {
      name: "deadline fallback",
      translate: () =>
        new Promise<string>(() => {
        }),
      advanceMs: TRANSLATION_DEADLINE_MS,
      outcome: "fallback",
      deadlineExpired: true,
    },
  ])(
    "emits one clause timing entry for $name",
    async ({
      translate,
      advanceMs,
      outcome,
      deadlineExpired,
    }) => {
      vi.useFakeTimers();
      installTranslator(translate);
      const gate = createGateEngine();

      await gate.engine.initialize();

      gate.engine.enqueue({
        id: 61,
        text: "measure this clause",
        final: true,
        at: "2026-09-02T00:00:01.000Z",
      });
      await vi.advanceTimersByTimeAsync(
        advanceMs,
      );
      await expect(
        gate.engine.drain(),
      ).resolves.toBe(true);

      const timingEntries =
        gate.onDevLog.mock.calls
          .map(([message]) => message)
          .filter(
            (message) =>
              message.data?.kind ===
              "clause-timing",
          );

      expect(timingEntries).toHaveLength(1);

      const timing = timingEntries[0];

      expect(timing).toEqual({
        t: "OFF_DEV_LOG",
        level: "info",
        tag: "translate",
        message:
          "translation clause reached terminal state",
        data: {
          kind: "clause-timing",
          requestId: "request-gate",
          lineId: 61,
          path: "offscreen-translator",
          outcome,
          enqueueToTerminalMs:
            expect.any(Number),
          modelCallMs: expect.any(Number),
          deadlineExpired,
        },
      });
      expect(
        timing.data.enqueueToTerminalMs,
      ).toBeGreaterThanOrEqual(0);
      expect(
        timing.data.enqueueToTerminalMs,
      ).toBeLessThanOrEqual(
        TRANSLATION_DEADLINE_MS,
      );
      expect(
        timing.data.modelCallMs,
      ).toBeGreaterThanOrEqual(0);
      expect(
        timing.data.modelCallMs,
      ).toBeLessThanOrEqual(
        timing.data.enqueueToTerminalMs,
      );

      if (outcome === "translated") {
        expect(gate.onTranslated)
          .toHaveBeenCalledWith(
            expect.objectContaining({
              id: 61,
            }),
            "訳",
          );
      } else {
        expect(gate.onSettled)
          .toHaveBeenCalledWith([61]);
      }

      gate.engine.destroy();
    },
  );

  it("A-6-4(b') settles drop, destroy, and drain timeout in id order", async () => {
    vi.useFakeTimers();
    const never =
      new Promise<string>(() => {
      });

    installTranslator(() => never);
    const first = createGateEngine();

    first.engine.enqueue({
      id: 1,
      text: "one",
      final: true,
      at: "2026-09-02T00:00:01.000Z",
    });
    first.engine.enqueue({
      id: 2,
      text: "two",
      final: true,
      at: "2026-09-02T00:00:02.000Z",
    });
    first.engine.enqueue({
      id: 3,
      text: "three",
      final: true,
      at: "2026-09-02T00:00:03.000Z",
    });

    expect(first.onSettled.mock.calls)
      .toEqual([[[2]]]);

    first.engine.destroy();

    expect(first.onSettled.mock.calls)
      .toEqual([
        [[2]],
        [[1, 3]],
      ]);

    installTranslator(() => never);
    const timed = createGateEngine();
    timed.engine.enqueue({
      id: 4,
      text: "four",
      final: true,
      at: "2026-09-02T00:00:04.000Z",
    });
    const drain = timed.engine.drain();

    await vi.advanceTimersByTimeAsync(
      TRANSLATOR_CREATE_TIMEOUT_MS,
    );

    await expect(drain).resolves.toBe(
      false,
    );
    expect(timed.onSettled)
      .toHaveBeenCalledWith([4]);
  });

  it("A-6-4(b''') settles null result and none-path queue splice", async () => {
    const gate = createGateEngine();

    gate.engine.enqueue({
      id: 1,
      text: "one",
      final: true,
      at: "2026-09-02T00:00:01.000Z",
    });
    gate.engine.enqueue(
      {
        id: 2,
        text: "two",
        final: true,
        at: "2026-09-02T00:00:02.000Z",
      },
      { stopFlush: true },
    );
    gate.engine.enqueue(
      {
        id: 3,
        text: "three",
        final: true,
        at: "2026-09-02T00:00:03.000Z",
      },
      { stopFlush: true },
    );

    await vi.waitFor(() => {
      expect(gate.onPathChanged)
        .toHaveBeenCalledWith("none");
    });

    expect(gate.onSettled.mock.calls)
      .toEqual([
        [[2, 3]],
        [[1]],
      ]);
  });

  it.each([
    "translate",
    "selectBestPath",
    "create",
  ] as const)(
    "A-6-4(b'''-2) releases a hung %s attempt and processes id 2",
    async (hangAt) => {
      vi.useFakeTimers();
      const never =
        new Promise<string>(() => {
        });
      let backend:
        | "translator"
        | "prompt-api" = "translator";

      if (hangAt === "translate") {
        let callCount = 0;
        installTranslator(async () => {
          callCount += 1;
          return callCount === 1
            ? never
            : "二";
        });
      } else {
        backend = "prompt-api";
        installTranslator(async () => "二");

        if (
          hangAt === "selectBestPath"
        ) {
          const availability = vi
            .fn()
            .mockImplementationOnce(
              () => never,
            )
            .mockResolvedValue(
              "unavailable",
            );

          vi.stubGlobal("LanguageModel", {
            availability,
            create: vi.fn(),
          });
        } else {
          vi.stubGlobal("LanguageModel", {
            availability: vi.fn(
              async () => "available",
            ),
            create: vi.fn(
              () => never,
            ),
          });
        }
      }

      const gate =
        createGateEngine(backend);

      gate.engine.enqueue({
        id: 1,
        text: "hung",
        final: true,
        at: "2026-09-02T00:00:01.000Z",
      });

      await vi.advanceTimersByTimeAsync(
        TRANSLATION_DEADLINE_MS - 1_000,
      );

      gate.engine.enqueue({
        id: 2,
        text: "next",
        final: true,
        at: "2026-09-02T00:00:02.000Z",
      });

      await vi.advanceTimersByTimeAsync(
        1_000,
      );

      await vi.waitFor(() => {
        expect(gate.onTranslated)
          .toHaveBeenCalledWith(
            expect.objectContaining({
              id: 2,
            }),
            "二",
          );
      });

      expect(gate.onSettled)
        .toHaveBeenCalledWith([1]);
      expect(
        (
          gate.engine as unknown as {
            processing: boolean;
          }
        ).processing,
      ).toBe(false);

      gate.engine.destroy();
    },
  );

  it(
    "does not create a LanguageModel after stale availability resolves",
    async () => {
      vi.useFakeTimers();
      const availability =
        createDeferred<"available">();
      const create = vi.fn(
        async () => ({
          clone: vi.fn(),
          destroy: vi.fn(),
        }),
      );

      vi.stubGlobal("LanguageModel", {
        availability: vi.fn(
          () => availability.promise,
        ),
        create,
      });

      const gate =
        createGateEngine("prompt-api");

      gate.engine.enqueue({
        id: 1,
        text: "late availability",
        final: true,
        at: "2026-09-02T00:00:01.000Z",
      });

      await vi.advanceTimersByTimeAsync(
        TRANSLATION_DEADLINE_MS,
      );

      expect(gate.onSettled)
        .toHaveBeenCalledWith([1]);

      availability.resolve("available");
      await vi.advanceTimersByTimeAsync(0);

      const internal =
        gate.engine as unknown as {
          languageModel: unknown;
          languageModelCreateAttempted:
            boolean;
          path: unknown;
        };

      expect(create).not.toHaveBeenCalled();
      expect(internal.languageModel)
        .toBeNull();
      expect(
        internal.languageModelCreateAttempted,
      ).toBe(false);
      expect(internal.path).toBeNull();
      expect(gate.onPathChanged)
        .not.toHaveBeenCalled();

      gate.engine.destroy();
    },
  );

  it(
    "destroys a LanguageModel created after its attempt expires",
    async () => {
      vi.useFakeTimers();
      const languageModel = {
        clone: vi.fn(),
        destroy: vi.fn(),
      };
      const created =
        createDeferred<typeof languageModel>();
      const create = vi.fn(
        () => created.promise,
      );

      vi.stubGlobal("LanguageModel", {
        availability: vi.fn(
          async () => "available",
        ),
        create,
      });

      const gate =
        createGateEngine("prompt-api");

      gate.engine.enqueue({
        id: 1,
        text: "late model",
        final: true,
        at: "2026-09-02T00:00:01.000Z",
      });

      await vi.waitFor(() => {
        expect(create)
          .toHaveBeenCalledOnce();
      });

      await vi.advanceTimersByTimeAsync(
        TRANSLATION_DEADLINE_MS,
      );

      expect(gate.onSettled)
        .toHaveBeenCalledWith([1]);

      created.resolve(languageModel);
      await vi.advanceTimersByTimeAsync(0);

      expect(languageModel.destroy)
        .toHaveBeenCalledOnce();
      expect(
        (
          gate.engine as unknown as {
            languageModel: unknown;
          }
        ).languageModel,
      ).toBeNull();
      expect(gate.onPathChanged)
        .not.toHaveBeenCalled();

      gate.engine.destroy();
    },
  );

  it(
    "destroys a Translator created after its attempt expires",
    async () => {
      vi.useFakeTimers();
      const availability =
        createDeferred<"available">();
      const translator = {
        translate: vi.fn(
          async () => "unused",
        ),
        destroy: vi.fn(),
      };
      const created =
        createDeferred<typeof translator>();
      const create = vi.fn(
        () => created.promise,
      );

      vi.stubGlobal("Translator", {
        availability: vi.fn(
          () => availability.promise,
        ),
        create,
      });

      const gate = createGateEngine();

      gate.engine.enqueue({
        id: 1,
        text: "late translator",
        final: true,
        at: "2026-09-02T00:00:01.000Z",
      });

      await vi.advanceTimersByTimeAsync(
        5_000,
      );
      availability.resolve("available");
      await vi.advanceTimersByTimeAsync(0);

      expect(create)
        .toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(
        TRANSLATION_DEADLINE_MS - 5_000,
      );

      expect(gate.onSettled)
        .toHaveBeenCalledWith([1]);

      created.resolve(translator);
      await vi.advanceTimersByTimeAsync(0);

      expect(translator.destroy)
        .toHaveBeenCalledOnce();
      expect(
        (
          gate.engine as unknown as {
            translator: unknown;
          }
        ).translator,
      ).toBeNull();

      gate.engine.destroy();
    },
  );

  it(
    "destroys a Translator that resolves after its create timeout",
    async () => {
      vi.useFakeTimers();
      vi.spyOn(
        console,
        "warn",
      ).mockImplementation(() => {
      });

      const translator = {
        translate: vi.fn(
          async () => "unused",
        ),
        destroy: vi.fn(),
      };
      const created =
        createDeferred<typeof translator>();
      const create = vi.fn(
        () => created.promise,
      );

      vi.stubGlobal("Translator", {
        availability: vi.fn(
          async () => "available",
        ),
        create,
      });

      const gate = createGateEngine();

      gate.engine.enqueue({
        id: 1,
        text: "timed out translator",
        final: true,
        at: "2026-09-02T00:00:01.000Z",
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(create)
        .toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(
        TRANSLATOR_CREATE_TIMEOUT_MS,
      );

      expect(gate.onSettled)
        .toHaveBeenCalledWith([1]);

      created.resolve(translator);
      await vi.advanceTimersByTimeAsync(0);

      expect(translator.destroy)
        .toHaveBeenCalledOnce();
      expect(
        (
          gate.engine as unknown as {
            translator: unknown;
          }
        ).translator,
      ).toBeNull();

      gate.engine.destroy();
    },
  );

  it(
    "destroys a LanguageModel clone that resolves after its attempt expires",
    async () => {
      vi.useFakeTimers();
      const clone = {
        prompt: vi.fn(
          async () => "unused",
        ),
        destroy: vi.fn(),
      };
      const cloneReady =
        createDeferred<typeof clone>();
      const base = {
        clone: vi.fn(
          () => cloneReady.promise,
        ),
        destroy: vi.fn(),
      };

      vi.stubGlobal("LanguageModel", {
        availability: vi.fn(
          async () => "available",
        ),
        create: vi.fn(
          async () => base,
        ),
      });

      const gate =
        createGateEngine("prompt-api");

      gate.engine.enqueue({
        id: 1,
        text: "late clone",
        final: true,
        at: "2026-09-02T00:00:01.000Z",
      });

      await vi.waitFor(() => {
        expect(base.clone)
          .toHaveBeenCalledOnce();
      });

      await vi.advanceTimersByTimeAsync(
        TRANSLATION_DEADLINE_MS,
      );

      expect(gate.onSettled)
        .toHaveBeenCalledWith([1]);

      cloneReady.resolve(clone);
      await vi.advanceTimersByTimeAsync(0);

      expect(clone.destroy)
        .toHaveBeenCalledOnce();
      expect(
        (
          gate.engine as unknown as {
            languageModelClone: unknown;
          }
        ).languageModelClone,
      ).toBeNull();

      gate.engine.destroy();
    },
  );

  it.each([
    "success",
    "failure",
  ] as const)(
    "A-6-4(b'''-3) ignores stale late %s without mutating engine state",
    async (lateKind) => {
      vi.useFakeTimers();
      const late = createDeferred<string>();
      const secondPrompt =
        new Promise<string>(() => {
        });
      const firstClone = {
        prompt: vi.fn(
          () => late.promise,
        ),
        destroy: vi.fn(),
      };
      const secondClone = {
        prompt: vi.fn(
          () => secondPrompt,
        ),
        destroy: vi.fn(),
      };
      const base = {
        clone: vi.fn()
          .mockResolvedValueOnce(
            firstClone,
          )
          .mockResolvedValueOnce(
            secondClone,
          ),
        destroy: vi.fn(),
      };

      vi.stubGlobal("LanguageModel", {
        availability: vi.fn(
          async () => "available",
        ),
        create: vi.fn(
          async () => base,
        ),
      });

      const gate =
        createGateEngine("prompt-api");

      gate.engine.enqueue({
        id: 1,
        text: "late",
        final: true,
        at: "2026-09-02T00:00:01.000Z",
      });

      await vi.advanceTimersByTimeAsync(
        TRANSLATION_DEADLINE_MS - 1_000,
      );

      gate.engine.enqueue({
        id: 2,
        text: "current",
        final: true,
        at: "2026-09-02T00:00:02.000Z",
      });

      await vi.advanceTimersByTimeAsync(
        1_000,
      );
      await vi.waitFor(() => {
        expect(base.clone)
          .toHaveBeenCalledTimes(2);
      });

      const internal =
        gate.engine as unknown as {
          recentHistory: unknown[];
          languageModel: unknown;
          languageModelClone: unknown;
          path: unknown;
          queue: unknown[];
          processing: boolean;
          drainResolvers: Set<unknown>;
        };
      const drain = gate.engine.drain();
      const snapshot = {
        history: [...internal.recentHistory],
        model: internal.languageModel,
        clone: internal.languageModelClone,
        path: internal.path,
        queueLength: internal.queue.length,
        processing: internal.processing,
        drainWaiters:
          internal.drainResolvers.size,
        pathCalls:
          gate.onPathChanged.mock.calls
            .length,
      };

      if (lateKind === "success") {
        late.resolve("遅延");
      } else {
        late.reject(
          new Error("late failure"),
        );
      }

      await vi.advanceTimersByTimeAsync(0);

      expect(internal.recentHistory)
        .toEqual(snapshot.history);
      expect(internal.languageModel)
        .toBe(snapshot.model);
      expect(internal.languageModelClone)
        .toBe(snapshot.clone);
      expect(internal.path)
        .toBe(snapshot.path);
      expect(internal.queue)
        .toHaveLength(
          snapshot.queueLength,
        );
      expect(internal.processing)
        .toBe(snapshot.processing);
      expect(internal.drainResolvers.size)
        .toBe(snapshot.drainWaiters);
      expect(gate.onPathChanged)
        .toHaveBeenCalledTimes(
          snapshot.pathCalls,
        );
      expect(gate.onTranslated)
        .not.toHaveBeenCalled();
      expect(gate.onSettled.mock.calls)
        .toEqual([[[1]]]);
      expect(firstClone.destroy)
        .toHaveBeenCalledOnce();
      expect(secondClone.destroy)
        .not.toHaveBeenCalled();
      expect(base.destroy)
        .not.toHaveBeenCalled();

      gate.engine.destroy();
      await drain;
    },
  );
});

describe("TranslationEngine drain", () => {
  it("delivers the final clause before a successful drain completes", async () => {
    const translated =
      createDeferred<string>();
    installTranslator(
      () => translated.promise,
    );

    const onTranslated = vi.fn();
    const engine =
      new TranslationEngine({
        backend: "translator",
        getContext: () => ({
          recentPairs: [],
          properNouns: [],
        }),
        requestContentTranslation:
          vi.fn(async () => ({
            available: false,
            ja: "",
          })),
        onTranslated,
        onPathChanged: vi.fn(),
      });

    await engine.initialize();

    engine.enqueue({
      id: 41,
      text: "the final clause",
      final: true,
      at: "2026-08-30T00:00:00.000Z",
    });

    const drainPromise = engine.drain();

    expect(onTranslated).not.toHaveBeenCalled();

    translated.resolve("最後の節");

    await expect(
      drainPromise,
    ).resolves.toBe(true);
    expect(onTranslated).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 41,
        text: "the final clause",
      }),
      "最後の節",
    );

    engine.destroy();
  });

  it("destroys the engine and returns false when drain reaches the shared 8s timeout", async () => {
    vi.useFakeTimers();

    const neverTranslated =
      new Promise<string>(() => {
      });
    const destroyTranslator =
      installTranslator(
        () => neverTranslated,
      );
    const onTranslated = vi.fn();
    const engine =
      new TranslationEngine({
        backend: "translator",
        getContext: () => ({
          recentPairs: [],
          properNouns: [],
        }),
        requestContentTranslation:
          vi.fn(async () => ({
            available: false,
            ja: "",
          })),
        onTranslated,
        onPathChanged: vi.fn(),
      });

    await engine.initialize();

    engine.enqueue({
      id: 42,
      text: "never resolves",
      final: true,
      at: "2026-08-30T00:00:01.000Z",
    });

    const drainPromise = engine.drain();

    await vi.advanceTimersByTimeAsync(
      TRANSLATOR_CREATE_TIMEOUT_MS,
    );

    await expect(
      drainPromise,
    ).resolves.toBe(false);
    expect(
      destroyTranslator,
    ).toHaveBeenCalledOnce();
    expect(onTranslated).not.toHaveBeenCalled();
  });
});
