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
  TRANSLATOR_CREATE_TIMEOUT_MS,
  TranslationEngine,
} from "./translate";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve:
    | ((value: T) => void)
    | undefined;

  const promise = new Promise<T>(
    (promiseResolve) => {
      resolve = promiseResolve;
    },
  );

  return {
    promise,
    resolve(value) {
      resolve?.(value);
    },
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
