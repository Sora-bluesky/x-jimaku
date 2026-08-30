import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  TranslationEngineOptions,
} from "./translate";
import {
  createMaskPlan,
  remaskPlannedTerms,
  restoreMaskedTranslation,
} from "./term-masking";
import {
  TranslationEngine,
} from "./translate";

function installTranslator(
  respond: (
    text: string,
  ) => Promise<string>,
): ReturnType<typeof vi.fn> {
  const translate = vi.fn(respond);

  vi.stubGlobal("Translator", {
    availability: vi.fn(
      async () => "available",
    ),
    create: vi.fn(async () => ({
      translate,
      destroy: vi.fn(),
    })),
  });

  return translate;
}

function installLanguageModel(
  respond: (
    prompt: string,
  ) => Promise<string>,
): ReturnType<typeof vi.fn> {
  const prompt = vi.fn(respond);

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

  return prompt;
}

function createTestEngine(
  backend: "prompt-api" | "translator",
  properNouns: string[],
  onTranslated:
    TranslationEngineOptions["onTranslated"],
): TranslationEngine {
  return new TranslationEngine({
    backend,
    getContext: () => ({
      recentPairs: [],
      properNouns,
    }),
    requestContentTranslation:
      vi.fn(async () => ({
        available: false,
        ja: "",
      })),
    onTranslated,
    onPathChanged: vi.fn(),
  });
}

async function translateClause(
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("term masking", () => {
  it("assigns a unique number to every occurrence", () => {
    const result = createMaskPlan(
      "Roman met Roman.",
      ["Roman"],
    );

    expect(result.masked).toBe(
      "%%1%% met %%2%%.",
    );
    expect(result.maskPlan?.entries).toEqual([
      { number: 1, term: "Roman" },
      { number: 2, term: "Roman" },
    ]);
  });

  it("prefers longer terms and escapes regex characters", () => {
    const result = createMaskPlan(
      "Kennedy Space Center met Kennedy and U.S.",
      [
        "Kennedy",
        "Kennedy Space Center",
        "U.S.",
      ],
    );

    expect(result.masked).toBe(
      "%%1%% met %%2%% and %%3%%",
    );
    expect(result.maskPlan?.entries).toEqual([
      {
        number: 1,
        term: "Kennedy Space Center",
      },
      { number: 2, term: "Kennedy" },
      { number: 3, term: "U.S." },
    ]);
  });

  it("does not partially mask possessives, plurals, or lowercase ASR text", () => {
    const result = createMaskPlan(
      "Roman's Romans roman Roman is",
      ["Roman"],
    );

    expect(result.masked).toBe(
      "Roman's Romans roman %%1%% is",
    );
  });

  it("passes through clauses with more than four occurrences", () => {
    const original =
      "Roman Roman Roman Roman Roman";
    const result = createMaskPlan(
      original,
      ["Roman"],
    );

    expect(result).toEqual({
      original,
      masked: original,
      maskPlan: null,
    });
  });

  it("leaves a no-match clause untouched", () => {
    const original = "roman stays";
    const result = createMaskPlan(
      original,
      ["Roman"],
    );

    expect(result).toEqual({
      original,
      masked: original,
      maskPlan: null,
    });
  });

  it("restores placeholders with internal whitespace", () => {
    const result = createMaskPlan(
      "Roman is here",
      ["Roman"],
    );

    expect(
      restoreMaskedTranslation(
        "%%  1  %%です",
        result.maskPlan,
      ),
    ).toBe("Romanです");
  });

  it.each([
    ["unknown number", "%%2%%です"],
    ["duplicate number", "%%1%%%%1%%です"],
    ["missing number", "ここです"],
    ["unresolved marker", "%%x%%です"],
  ])(
    "rejects %s",
    (_case, output) => {
      const result = createMaskPlan(
        "Roman is here",
        ["Roman"],
      );

      expect(
        restoreMaskedTranslation(
          output,
          result.maskPlan,
        ),
      ).toBeNull();
    },
  );

  it("rejects a literal placeholder collision", () => {
    const result = createMaskPlan(
      "Roman and %%9%%",
      ["Roman"],
    );

    expect(
      restoreMaskedTranslation(
        "%%1%% and %%9%%",
        result.maskPlan,
      ),
    ).toBeNull();
  });

  it("reuses the planned numbers when masking history", () => {
    const result = createMaskPlan(
      "Roman met Roman",
      ["Roman"],
    );

    expect(
      remaskPlannedTerms(
        "Roman followed Roman and Roman's",
        result.maskPlan!,
      ),
    ).toBe(
      "%%1%% followed %%2%% and Roman's",
    );
  });
});

describe("TranslationEngine masking ladder", () => {
  it.each([
    ["unknown number", "%%2%%です"],
    ["duplicate number", "%%1%%%%1%%です"],
    ["missing number", "ここです"],
  ])(
    "descends to Translator for a Nano %s",
    async (_case, nanoResponse) => {
      installLanguageModel(
        async () => nanoResponse,
      );
      const translator = installTranslator(
        async () => "%%1%%です",
      );
      const onTranslated = vi.fn();
      const engine = createTestEngine(
        "prompt-api",
        ["Roman"],
        onTranslated,
      );

      await engine.initialize();
      await translateClause(
        engine,
        1,
        "Roman is here.",
      );

      expect(translator).toHaveBeenCalledWith(
        "%%1%% is here.",
      );
      expect(onTranslated).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1 }),
        "Romanです",
      );

      engine.destroy();
    },
  );

  it("returns the original English when every masked translation fails", async () => {
    installLanguageModel(
      async () => "ここです",
    );
    const onTranslated = vi.fn();
    const engine = createTestEngine(
      "prompt-api",
      ["Roman"],
      onTranslated,
    );

    await engine.initialize();
    await translateClause(
      engine,
      2,
      "Roman is here.",
    );

    expect(onTranslated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 2 }),
      "Roman is here.",
    );

    engine.destroy();
  });

  it("masks and restores the Translator-primary path", async () => {
    const translator = installTranslator(
      async () => "%% 1 %%です",
    );
    const onTranslated = vi.fn();
    const engine = createTestEngine(
      "translator",
      ["Roman"],
      onTranslated,
    );

    await engine.initialize();
    await translateClause(
      engine,
      3,
      "Roman is here.",
    );

    expect(translator).toHaveBeenCalledWith(
      "%%1%% is here.",
    );
    expect(onTranslated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 3 }),
      "Romanです",
    );

    engine.destroy();
  });

  it("excludes masked terms from the noun block and remasks restored history", async () => {
    const responses = [
      "%%1%% NASA",
      "%%1%%が去った",
    ];
    const prompt = installLanguageModel(
      async () => responses.shift() ?? "",
    );
    const onTranslated = vi.fn();
    const engine = createTestEngine(
      "prompt-api",
      ["Roman", "NASA"],
      onTranslated,
    );

    await engine.initialize();
    await translateClause(
      engine,
      4,
      "Roman arrived.",
    );
    await translateClause(
      engine,
      5,
      "Roman left.",
    );

    const secondPrompt =
      prompt.mock.calls[1]?.[0] ?? "";

    expect(secondPrompt).toContain(
      "[固有名詞（原綴りのまま使う）]\nNASA",
    );
    expect(secondPrompt).toContain(
      "EN: %%1%% arrived.",
    );
    expect(secondPrompt).toContain(
      "JA: %%1%% NASA",
    );
    expect(secondPrompt).toContain(
      "[今訳す節]\n%%1%% left.",
    );
    expect(secondPrompt).not.toContain("Roman");
    expect(onTranslated).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: 4 }),
      "Roman NASA",
    );
    expect(onTranslated).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 5 }),
      "Romanが去った",
    );

    engine.destroy();
  });
});
