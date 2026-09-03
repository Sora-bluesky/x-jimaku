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
  KEEP_LATIN_ALL_TERMS,
  KEEP_LATIN_MASK_TERMS,
  allowKeepLatinMaskOccurrence,
} from "./glossary";
import {
  createMaskPlan,
  MAX_MASKED_OCCURRENCES,
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

function planKeepLatin(
  clause: string,
  properNouns: readonly string[] = [],
) {
  return createMaskPlan(
    clause,
    properNouns,
    KEEP_LATIN_ALL_TERMS,
    (hit) =>
      allowKeepLatinMaskOccurrence(
        clause,
        hit,
        properNouns,
      ),
  );
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

  it("masks a non-ambiguous glossary name and restores it in Latin", () => {
    const result = createMaskPlan(
      "Claude is here",
      [],
      KEEP_LATIN_MASK_TERMS,
    );

    expect(result.masked).toBe(
      "%%1%% is here",
    );
    expect(result.maskPlan?.entries).toEqual([
      { number: 1, term: "Claude" },
    ]);
    expect(
      restoreMaskedTranslation(
        "%%1%%です",
        result.maskPlan,
      ),
    ).toBe("Claudeです");
  });

  it("does not mask an ambiguous glossary name", () => {
    const original = "The Opus premiered";

    expect(
      createMaskPlan(
        original,
        [],
        KEEP_LATIN_MASK_TERMS,
      ),
    ).toEqual({
      original,
      masked: original,
      maskPlan: null,
    });
  });

  it("masks Opus 4.5 and leaves ordinary opus", () => {
    expect(
      planKeepLatin("Opus 4.5").masked,
    ).toBe("%%1%% 4.5");
    expect(
      planKeepLatin("Fable 5.1").masked,
    ).toBe("%%1%% 5.1");
    expect(
      planKeepLatin("Sonnet 4").masked,
    ).toBe("%%1%% 4");

    const ordinary = "his greatest opus";
    expect(
      planKeepLatin(ordinary),
    ).toEqual({
      original: ordinary,
      masked: ordinary,
      maskPlan: null,
    });

    const capital = "The Opus premiered";
    expect(
      planKeepLatin(capital),
    ).toEqual({
      original: capital,
      masked: capital,
      maskPlan: null,
    });
  });

  it("masks Claude Opus on the neighbouring family name", () => {
    const result = planKeepLatin(
      "Claude Opus",
    );

    expect(result.masked).toBe(
      "%%1%% %%2%%",
    );
    expect(
      result.maskPlan?.entries,
    ).toEqual([
      { number: 1, term: "Claude" },
      { number: 2, term: "Opus" },
    ]);
    expect(
      planKeepLatin("Anthropic's Opus")
        .masked,
    ).toBe("Anthropic's %%1%%");
    expect(
      planKeepLatin("Claude 4 Opus")
        .masked,
    ).toBe("%%1%% 4 %%2%%");
  });

  it("masks an ambiguous term the page names", () => {
    const result = planKeepLatin(
      "We shipped Opus today",
      ["Opus 4.5"],
    );

    expect(result.masked).toBe(
      "We shipped %%1%% today",
    );
    expect(
      result.maskPlan?.entries,
    ).toEqual([
      { number: 1, term: "Opus" },
    ]);
  });

  it("does not mask Roman history or the Roman Space Telescope", () => {
    const history = "Roman history";
    const telescope =
      "the Roman Space Telescope";

    expect(
      planKeepLatin(history),
    ).toEqual({
      original: history,
      masked: history,
      maskPlan: null,
    });
    expect(
      planKeepLatin(telescope),
    ).toEqual({
      original: telescope,
      masked: telescope,
      maskPlan: null,
    });
  });

  it("does not drop page nouns to make room for evidenced Opus", () => {
    const result = planKeepLatin(
      "Theo Theo Theo Theo Opus 4.5",
      ["Theo"],
    );

    expect(result.masked).toBe(
      "%%1%% %%2%% %%3%% %%4%% Opus 4.5",
    );
  });

  it("does not treat a family name in the same clause as beside", () => {
    expect(
      planKeepLatin(
        "Hugging Face released Opus.",
      ).masked,
    ).toBe("%%1%% released Opus.");
  });

  it("masks four glossary names and leaves NVIDIA", () => {
    const result = createMaskPlan(
      "Anthropic Claude OpenAI Google NVIDIA",
      [],
      KEEP_LATIN_MASK_TERMS,
    );

    expect(result.masked).toBe(
      "%%1%% %%2%% %%3%% %%4%% NVIDIA",
    );
    expect(
      result.maskPlan?.entries.map(
        (entry) => entry.term,
      ),
    ).toEqual([
      "Anthropic",
      "Claude",
      "OpenAI",
      "Google",
    ]);
    expect(
      result.maskPlan?.entries,
    ).toHaveLength(MAX_MASKED_OCCURRENCES);
  });

  it("keeps a page noun masked when glossary names would exceed the cap", () => {
    const result = createMaskPlan(
      "Theo and Claude and Anthropic and OpenAI and Google",
      ["Theo"],
      KEEP_LATIN_MASK_TERMS,
    );

    expect(result.masked).toBe(
      "%%1%% and %%2%% and %%3%% and %%4%% and Google",
    );
    expect(
      result.maskPlan?.entries.map(
        (entry) => entry.term,
      ),
    ).toEqual([
      "Theo",
      "Claude",
      "Anthropic",
      "OpenAI",
    ]);
  });

  it("does not drop page nouns to make room for a glossary name", () => {
    const result = createMaskPlan(
      "Theo Theo Theo Theo Claude",
      ["Theo"],
      KEEP_LATIN_MASK_TERMS,
    );

    expect(result.masked).toBe(
      "%%1%% %%2%% %%3%% %%4%% Claude",
    );
    expect(
      result.maskPlan?.entries.every(
        (entry) => entry.term === "Theo",
      ),
    ).toBe(true);
  });

  it("still passes through a page-noun overflow when glossary names are present", () => {
    const original =
      "Theo Theo Theo Theo Theo Claude";

    expect(
      createMaskPlan(
        original,
        ["Theo"],
        KEEP_LATIN_MASK_TERMS,
      ),
    ).toEqual({
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

  it("masks and restores a glossary name when the page list is empty", async () => {
    const prompt = installLanguageModel(
      async () => "%%1%%です",
    );
    const onTranslated = vi.fn();
    const engine = createTestEngine(
      "prompt-api",
      [],
      onTranslated,
    );

    await engine.initialize();
    await translateClause(
      engine,
      6,
      "Claude is here.",
    );

    const sent = String(
      prompt.mock.calls[0]?.[0] ?? "",
    );

    expect(sent).toContain(
      "[今訳す節]\n%%1%% is here.",
    );
    expect(sent).not.toContain("Claude");
    expect(onTranslated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 6 }),
      "Claudeです",
    );

    engine.destroy();
  });

  it("does not mask Opus in the LanguageModel prompt", async () => {
    const prompt = installLanguageModel(
      async () => "作品です",
    );
    const onTranslated = vi.fn();
    const engine = createTestEngine(
      "prompt-api",
      [],
      onTranslated,
    );

    await engine.initialize();
    await translateClause(
      engine,
      7,
      "The Opus premiered.",
    );

    const sent = String(
      prompt.mock.calls[0]?.[0] ?? "",
    );

    expect(sent).toContain(
      "[今訳す節]\nThe Opus premiered.",
    );
    expect(sent).not.toContain("%%");
    expect(sent).toContain(
      "モデル・製品・組織名のときだけ原綴り（一般語は訳す）: Opus",
    );
    expect(onTranslated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
      "作品です",
    );

    engine.destroy();
  });

  it("masks Opus 4.5 in the LanguageModel prompt", async () => {
    const prompt = installLanguageModel(
      async () => "%%1%%です",
    );
    const onTranslated = vi.fn();
    const engine = createTestEngine(
      "prompt-api",
      [],
      onTranslated,
    );

    await engine.initialize();
    await translateClause(
      engine,
      8,
      "Opus 4.5 shipped.",
    );

    const sent = String(
      prompt.mock.calls[0]?.[0] ?? "",
    );

    expect(sent).toContain(
      "[今訳す節]\n%%1%% 4.5 shipped.",
    );
    expect(sent).not.toContain("Opus");
    expect(onTranslated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 8 }),
      "Opusです",
    );

    engine.destroy();
  });

  it("masks Opus when the page names a phrase that contains it", async () => {
    const prompt = installLanguageModel(
      async () => "%%1%%です",
    );
    const onTranslated = vi.fn();
    const engine = createTestEngine(
      "prompt-api",
      ["Opus 4.5"],
      onTranslated,
    );

    await engine.initialize();
    await translateClause(
      engine,
      9,
      "We shipped Opus today.",
    );

    const sent = String(
      prompt.mock.calls[0]?.[0] ?? "",
    );

    expect(sent).toContain(
      "[今訳す節]\nWe shipped %%1%% today.",
    );
    expect(sent).not.toContain("Opus");
    expect(onTranslated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 9 }),
      "Opusです",
    );

    engine.destroy();
  });
});
