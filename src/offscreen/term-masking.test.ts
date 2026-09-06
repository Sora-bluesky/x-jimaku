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
  KEEP_LATIN_MATCH_CAP,
  allowKeepLatinMaskOccurrence,
  renderNameTerm,
} from "./glossary";
import { NAME_TERMS } from "./glossary.data";
import {
  countIntactPlaceholders,
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
  onTranslated: ReturnType<typeof vi.fn>,
  onDevLog?:
    TranslationEngineOptions["onDevLog"],
): TranslationEngine {
  return new TranslationEngine({
    backend,
    requestId:
      onDevLog === undefined
        ? undefined
        : "request-mask",
    getContext: () => ({
      recentPairs: [],
      properNouns,
    }),
    requestContentTranslation:
      vi.fn(async () => ({
        available: false,
        ja: "",
      })),
    onTranslated(line, ja) {
      // The existing assertions look at two arguments; the rung is dropped here.
      (onTranslated as unknown as (
        line: unknown,
        ja: string,
      ) => void)(line, ja);
    },
    onPathChanged: vi.fn(),
    onDevLog,
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

function keepLatinBlock(
  prompt: string,
): string {
  const start = prompt.indexOf("[原綴り]");

  if (start === -1) {
    return "";
  }

  // The block ends at the next header, whichever it is ([定訳], [用語],
  // [直前の文脈] or [今訳す節]).
  const nextHeader = prompt.indexOf(
    "\n[",
    start + 1,
  );
  const end = nextHeader === -1
    ? prompt.indexOf("[今訳す節]", start)
    : nextHeader + 1;

  return prompt.slice(
    start,
    end === -1 ? undefined : end,
  );
}

function keepLatinCrowding(
  longerThan: string,
): string[] {
  // Latin rows only: a fixed-Japanese row would land in [定訳], not [原綴り],
  // and the crowding exists to fill the [原綴り] cap.
  const latinTerms = new Set(
    NAME_TERMS.filter(
      (entry) => entry.render === "latin",
    ).map((entry) => entry.term),
  );
  return KEEP_LATIN_MASK_TERMS.filter(
    (term) =>
      latinTerms.has(term) &&
      term.length > longerThan.length,
  )
    .sort(
      (left, right) =>
        right.length - left.length,
    )
    .slice(0, KEEP_LATIN_MATCH_CAP);
}

async function languageModelRetryPrompts(
  text: string,
  properNouns: string[],
): Promise<{
  first: string;
  retry: string;
}> {
  const prompt = installLanguageModel(
    async (sent) =>
      sent.includes("%%")
        ? "ここです"
        : "到着した",
  );
  const engine = createTestEngine(
    "prompt-api",
    properNouns,
    vi.fn(),
  );

  await engine.initialize();
  await translateClause(
    engine,
    1,
    text,
  );
  engine.destroy();

  expect(prompt).toHaveBeenCalledTimes(2);

  return {
    first: String(
      prompt.mock.calls[0]?.[0] ?? "",
    ),
    retry: String(
      prompt.mock.calls[1]?.[0] ?? "",
    ),
  };
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
    renderNameTerm,
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
      { number: 1, term: "Roman", render: "Roman" },
      { number: 2, term: "Roman", render: "Roman" },
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
        render: "Kennedy Space Center",
      },
      { number: 2, term: "Kennedy", render: "Kennedy" },
      { number: 3, term: "U.S.", render: "U.S." },
    ]);
  });

  it("does not partially mask possessives or plurals", () => {
    const result = createMaskPlan(
      "Roman's Romans roman Roman is",
      ["Roman"],
    );

    expect(result.masked).toBe(
      "Roman's Romans %%1%% %%2%% is",
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
      { number: 1, term: "Claude", render: "Claude" },
    ]);
    expect(
      restoreMaskedTranslation(
        "%%1%%です",
        result.maskPlan,
      ),
    ).toBe("Claudeです");
  });

  it("masks Opus with no version, family name, or page name", () => {
    const result = planKeepLatin(
      "The Opus premiered",
    );

    expect(result.masked).toBe(
      "The %%1%% premiered",
    );
    expect(result.maskPlan?.entries).toEqual([
      { number: 1, term: "Opus", render: "Opus" },
    ]);
  });

  it("masks Clerk with no version, family name, or page name", () => {
    const result = planKeepLatin(
      "the clerk opened",
    );

    expect(result.masked).toBe(
      "the %%1%% opened",
    );
    expect(result.maskPlan?.entries).toEqual([
      { number: 1, term: "Clerk", render: "Clerk" },
    ]);
  });

  it("masks lowercase opus and restores Opus", () => {
    const result = planKeepLatin(
      "a new version of opus",
    );

    expect(result.masked).toBe(
      "a new version of %%1%%",
    );
    expect(result.maskPlan?.entries).toEqual([
      { number: 1, term: "Opus", render: "Opus" },
    ]);
    expect(
      restoreMaskedTranslation(
        "%%1%%です",
        result.maskPlan,
      ),
    ).toBe("Opusです");
  });

  it("masks lowercase opus 4.5 and fable 5.1", () => {
    const opus = planKeepLatin("opus 4.5");
    expect(opus.masked).toBe("%%1%% 4.5");
    expect(opus.maskPlan?.entries).toEqual([
      { number: 1, term: "Opus", render: "Opus" },
    ]);

    const fable = planKeepLatin("fable 5.1");
    expect(fable.masked).toBe("%%1%% 5.1");
    expect(fable.maskPlan?.entries).toEqual([
      { number: 1, term: "Fable", render: "Fable" },
    ]);

    expect(
      planKeepLatin("cursor 4.5").masked,
    ).toBe("%%1%% 4.5");
    expect(
      planKeepLatin("cursor 4.5").maskPlan
        ?.entries,
    ).toEqual([
      { number: 1, term: "Cursor", render: "Cursor" },
    ]);
  });

  it("does not mask ordinary meta; version evidence restores Meta", () => {
    const ordinary = "meta learning";
    expect(planKeepLatin(ordinary)).toEqual({
      original: ordinary,
      masked: ordinary,
      maskPlan: null,
    });

    const evidenced = planKeepLatin(
      "meta 4.5",
    );
    expect(evidenced.masked).toBe(
      "%%1%% 4.5",
    );
    expect(
      evidenced.maskPlan?.entries,
    ).toEqual([
      { number: 1, term: "Meta", render: "Meta" },
    ]);
    expect(
      restoreMaskedTranslation(
        "%%1%%です",
        evidenced.maskPlan,
      ),
    ).toBe("Metaです");
  });

  it("does not mask an ambiguous glossary name", () => {
    const original = "The Cursor moved";

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

  it("masks Cursor 4.5 and leaves ordinary cursor", () => {
    expect(
      planKeepLatin("Cursor 4.5").masked,
    ).toBe("%%1%% 4.5");
    expect(
      planKeepLatin("Cursor 4").masked,
    ).toBe("%%1%% 4");

    const ordinary = "the blinking cursor";
    expect(
      planKeepLatin(ordinary),
    ).toEqual({
      original: ordinary,
      masked: ordinary,
      maskPlan: null,
    });

    const capital = "The Cursor moved";
    expect(
      planKeepLatin(capital),
    ).toEqual({
      original: capital,
      masked: capital,
      maskPlan: null,
    });
  });

  it("masks NASA Roman on the neighbouring family name", () => {
    const result = planKeepLatin(
      "NASA Roman",
    );

    expect(result.masked).toBe(
      "%%1%% %%2%%",
    );
    expect(
      result.maskPlan?.entries,
    ).toEqual([
      { number: 1, term: "NASA", render: "NASA" },
      { number: 2, term: "Roman", render: "ローマン" },
    ]);
    expect(
      planKeepLatin("NASA's Roman")
        .masked,
    ).toBe("NASA's %%1%%");
    expect(
      planKeepLatin("NASA 4 Roman")
        .masked,
    ).toBe("%%1%% 4 %%2%%");
  });

  it("masks an ambiguous term the page names", () => {
    const result = planKeepLatin(
      "We shipped Cursor today",
      ["Cursor 4.5"],
    );

    expect(result.masked).toBe(
      "We shipped %%1%% today",
    );
    expect(
      result.maskPlan?.entries,
    ).toEqual([
      { number: 1, term: "Cursor", render: "Cursor" },
    ]);
  });

  it("lets the table override the same page-derived name", () => {
    const result = createMaskPlan(
      "Kennedy Space Center のチーム",
      ["Kennedy Space Center"],
      KEEP_LATIN_ALL_TERMS,
      undefined,
      renderNameTerm,
    );

    expect(result.masked).toBe(
      "%%1%% のチーム",
    );
    expect(result.maskPlan?.entries).toEqual([
      {
        number: 1,
        term: "Kennedy Space Center",
        render: "ケネディ宇宙センター",
      },
    ]);
    expect(
      restoreMaskedTranslation(
        "%%1%% のチーム",
        result.maskPlan,
      ),
    ).toBe("ケネディ宇宙センターのチーム");
    expect(
      remaskPlannedTerms(
        "ケネディ宇宙センターのチーム",
        result.maskPlan!,
      ),
    ).toBe("%%1%%のチーム");

    const latin = createMaskPlan(
      "Claude team",
      [],
      KEEP_LATIN_ALL_TERMS,
      undefined,
      renderNameTerm,
    );
    expect(
      restoreMaskedTranslation(
        "%%1%% team",
        latin.maskPlan,
      ),
    ).toBe("Claude team");
  });

  it("keeps the space between two restored names and drops it before a particle", () => {
    const plan = createMaskPlan(
      "at NASA Goddard, Roman will map the sky",
      ["NASA Goddard", "Roman"],
      KEEP_LATIN_ALL_TERMS,
      undefined,
      renderNameTerm,
    );
    const numbers = plan.maskPlan?.entries.map(
      (entry) => `${entry.number}:${entry.render}`,
    );
    expect(numbers).toEqual(["1:NASA", "2:ゴダード", "3:ローマン"]);
    expect(
      restoreMaskedTranslation(
        "%%1%% %%2%% %%3%%は空を地図化します",
        plan.maskPlan,
      ),
    ).toBe("NASA ゴダード ローマンは空を地図化します");
  });
  it("does not mask Roman history and masks the telescope as one term", () => {
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
    const telescopePlan =
      planKeepLatin(telescope);

    expect(telescopePlan.masked).toBe(
      "the %%1%%",
    );
    expect(
      telescopePlan.maskPlan?.entries,
    ).toEqual([
      {
        number: 1,
        term: "Roman Space Telescope",
        render: "ローマン宇宙望遠鏡",
      },
    ]);
  });

  it("does not drop page nouns to make room for evidenced Cursor", () => {
    const result = planKeepLatin(
      "Theo Theo Theo Theo Cursor 4.5",
      ["Theo"],
    );

    expect(result.masked).toBe(
      "%%1%% %%2%% %%3%% %%4%% Cursor 4.5",
    );
  });

  it("does not treat a family name in the same clause as beside", () => {
    expect(
      planKeepLatin(
        "Hugging Face released Cursor.",
      ).masked,
    ).toBe("%%1%% released Cursor.");
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
    const original = "hello stays";
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

  it("restores fullwidth percent placeholders", () => {
    const result = createMaskPlan(
      "Roman is here",
      ["Roman"],
    );

    expect(
      restoreMaskedTranslation(
        "％％1％％です",
        result.maskPlan,
      ),
    ).toBe("Romanです");
    expect(
      restoreMaskedTranslation(
        "％％ 1 ％％です",
        result.maskPlan,
      ),
    ).toBe("Romanです");
    expect(
      restoreMaskedTranslation(
        "％％1%%です",
        result.maskPlan,
      ),
    ).toBe("Romanです");
  });

  it("restores fullwidth digit placeholders", () => {
    const result = createMaskPlan(
      "Roman is here",
      ["Roman"],
    );

    expect(
      restoreMaskedTranslation(
        "%%１%%です",
        result.maskPlan,
      ),
    ).toBe("Romanです");
  });

  it("restores fullwidth placeholders to the numbered names", () => {
    const result = createMaskPlan(
      "Roman met NASA",
      ["Roman", "NASA"],
    );

    expect(result.masked).toBe(
      "%%1%% met %%2%%",
    );
    expect(
      restoreMaskedTranslation(
        "％％2％％と％％1％％",
        result.maskPlan,
      ),
    ).toBe("NASAとRoman");
    expect(
      restoreMaskedTranslation(
        "%%１%%と%%２%%",
        result.maskPlan,
      ),
    ).toBe("RomanとNASA");
  });

  it("counts how many planned placeholders came back", () => {
    const result = createMaskPlan(
      "Roman met NASA",
      ["Roman", "NASA"],
    );

    expect(
      countIntactPlaceholders(
        "%%1%%です",
        result.maskPlan,
      ),
    ).toEqual({ sent: 2, returned: 1 });
    expect(
      countIntactPlaceholders(
        "％％1％％と％％2％％",
        result.maskPlan,
      ),
    ).toEqual({ sent: 2, returned: 2 });
    expect(
      countIntactPlaceholders(
        "ここです",
        result.maskPlan,
      ),
    ).toEqual({ sent: 2, returned: 0 });
    expect(
      countIntactPlaceholders(
        "%1%です",
        result.maskPlan,
      ),
    ).toEqual({ sent: 2, returned: 0 });
  });

  it.each([
    ["unknown number", "%%2%%です"],
    ["duplicate number", "%%1%%%%1%%です"],
    ["missing number", "ここです"],
    ["unresolved marker", "%%x%%です"],
    ["single percent", "%1%です"],
    ["brace number", "{1}です"],
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

  it("remasks lowercase history and restores the canonical spelling", () => {
    const result = createMaskPlan(
      "opus met opus",
      [],
      KEEP_LATIN_MASK_TERMS,
    );

    expect(result.maskPlan?.entries).toEqual([
      { number: 1, term: "Opus", render: "Opus" },
      { number: 2, term: "Opus", render: "Opus" },
    ]);
    expect(
      remaskPlannedTerms(
        "opus followed Opus and opus's",
        result.maskPlan!,
      ),
    ).toBe(
      "%%1%% followed %%2%% and opus's",
    );
    expect(
      restoreMaskedTranslation(
        "%%1%% then %%2%%",
        result.maskPlan,
      ),
    ).toBe("Opus then Opus");
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
        "ローマンです",
      );

      engine.destroy();
    },
  );

  it("retries LanguageModel without the mask when placeholders are lost", async () => {
    const prompt = installLanguageModel(
      async (sent) =>
        sent.includes("%%")
          ? "ここです"
          : "ローマです",
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

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(onTranslated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 2 }),
      "ローマです",
    );

    engine.destroy();
  });

  it("records how many placeholders came back on a masked attempt", async () => {
    installLanguageModel(
      async (sent) =>
        sent.includes("%%")
          ? "ここです"
          : "ローマです",
    );
    const onTranslated = vi.fn();
    const onDevLog = vi.fn();
    const engine = createTestEngine(
      "prompt-api",
      ["Roman"],
      onTranslated,
      onDevLog,
    );

    await engine.initialize();
    await translateClause(
      engine,
      21,
      "Roman is here.",
    );

    const survival = onDevLog.mock.calls
      .map(([message]) => message)
      .filter(
        (message) =>
          message.data?.kind ===
          "placeholder-survival",
      );

    expect(survival).toEqual([
      {
        t: "OFF_DEV_LOG",
        level: "info",
        tag: "translate",
        message: "placeholder survival",
        data: {
          kind: "placeholder-survival",
          requestId: "request-mask",
          lineId: 21,
          path: "language-model",
          sent: 1,
          returned: 0,
        },
      },
    ]);
    expect(onTranslated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 21 }),
      "ローマです",
    );

    engine.destroy();
  });

  it("records a partial return against what went out", async () => {
    installLanguageModel(
      async () => "%%1%%です",
    );
    const onDevLog = vi.fn();
    const engine = createTestEngine(
      "prompt-api",
      ["Roman", "NASA"],
      vi.fn(),
      onDevLog,
    );

    await engine.initialize();
    await translateClause(
      engine,
      22,
      "Roman met NASA.",
    );

    const survival = onDevLog.mock.calls
      .map(([message]) => message)
      .filter(
        (message) =>
          message.data?.kind ===
          "placeholder-survival",
      );

    expect(survival[0]?.data).toEqual({
      kind: "placeholder-survival",
      requestId: "request-mask",
      lineId: 22,
      path: "language-model",
      sent: 2,
      returned: 1,
    });

    engine.destroy();
  });

  it("restores a fullwidth placeholder without retrying", async () => {
    const prompt = installLanguageModel(
      async () => "％％1％％です",
    );
    const onTranslated = vi.fn();
    const onDevLog = vi.fn();
    const engine = createTestEngine(
      "prompt-api",
      ["Roman"],
      onTranslated,
      onDevLog,
    );

    await engine.initialize();
    await translateClause(
      engine,
      23,
      "Roman is here.",
    );

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(onTranslated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 23 }),
      "ローマンです",
    );
    expect(
      onDevLog.mock.calls
        .map(([message]) => message)
        .filter(
          (message) =>
            message.data?.kind ===
            "placeholder-survival",
        )[0]?.data,
    ).toEqual({
      kind: "placeholder-survival",
      requestId: "request-mask",
      lineId: 23,
      path: "language-model",
      sent: 1,
      returned: 1,
    });

    engine.destroy();
  });

  it("retries when a single-percent mark is not a placeholder", async () => {
    const prompt = installLanguageModel(
      async (sent) =>
        sent.includes("%%")
          ? "コストは%1%です"
          : "ローマです",
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
      24,
      "Roman is here.",
    );

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(onTranslated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 24 }),
      "ローマです",
    );
    expect(
      onTranslated,
    ).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 24 }),
      "コストはローマンです",
    );

    engine.destroy();
  });

  it("puts a visible fixed Japanese name in the fixed block", async () => {
    const crowding = keepLatinCrowding(
      "Roman",
    );
    expect(crowding).toHaveLength(
      KEEP_LATIN_MATCH_CAP,
    );

    const { first } =
      await languageModelRetryPrompts(
        `${crowding.join(" ")} Roman arrived.`,
        ["Roman"],
      );

    expect(first).toContain(
      "[定訳]\nRoman = ローマン",
    );
    expect(keepLatinBlock(first)).not.toContain(
      "Roman",
    );
  });

  it("leaves masked keep-Latin terms out of the first prompt", async () => {
    const { first } =
      await languageModelRetryPrompts(
        "Claude is here.",
        [],
      );

    expect(first).toContain("%%");
    expect(first).not.toContain("[原綴り]");
    expect(first).not.toContain("Claude");
  });

  it("keeps fixed Japanese retry terms out of Latin wording", async () => {
    // The table now wins the mask slots, so a clause crowded with table
    // terms would never mask the page-derived Roman. A plain clause does.
    const { retry } =
      await languageModelRetryPrompts(
        "Roman arrived.",
        ["Roman"],
      );

    expect(retry).toContain(
      "[定訳]\nRoman = ローマン",
    );
    expect(keepLatinBlock(retry)).not.toContain(
      "Roman",
    );
  });

  it("adds no keep-Latin section when the dropped mask has none", async () => {
    const { retry } =
      await languageModelRetryPrompts(
        "U.S. is here.",
        ["U.S."],
      );

    expect(retry).toContain(
      "[今訳す節]\nU.S. is here.",
    );
    expect(retry).not.toContain("[原綴り]");
    expect(keepLatinBlock(retry)).toBe("");
  });

  it("retries Translator without the mask when placeholders are lost", async () => {
    installLanguageModel(
      async () => "ここです",
    );
    const translator = installTranslator(
      async (text) =>
        text.includes("%%")
          ? "ここです"
          : "ローマです",
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

    expect(translator).toHaveBeenCalledWith(
      "%%1%% is here.",
    );
    expect(translator).toHaveBeenCalledWith(
      "Roman is here.",
    );
    expect(onTranslated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 2 }),
      "ローマです",
    );

    engine.destroy();
  });

  it("returns the original English when unmasked retry cannot translate", async () => {
    installLanguageModel(
      async () => "Still entirely English.",
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
      "ローマンです",
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
      "ローマン NASA",
    );
    expect(onTranslated).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 5 }),
      "ローマンが去った",
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

  it("does not mask Cursor in the LanguageModel prompt", async () => {
    const prompt = installLanguageModel(
      async () => "動きました",
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
      "The Cursor moved.",
    );

    const sent = String(
      prompt.mock.calls[0]?.[0] ?? "",
    );

    expect(sent).toContain(
      "[今訳す節]\nThe Cursor moved.",
    );
    expect(sent).not.toContain("%%");
    expect(sent).toContain(
      "モデル・製品・組織名のときだけ原綴り（一般語は訳す）: Cursor",
    );
    expect(onTranslated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
      "動きました",
    );

    engine.destroy();
  });

  it("masks Cursor 4.5 in the LanguageModel prompt", async () => {
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
      "Cursor 4.5 shipped.",
    );

    const sent = String(
      prompt.mock.calls[0]?.[0] ?? "",
    );

    expect(sent).toContain(
      "[今訳す節]\n%%1%% 4.5 shipped.",
    );
    expect(sent).not.toContain("Cursor");
    expect(onTranslated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 8 }),
      "Cursorです",
    );

    engine.destroy();
  });

  it("masks Cursor when the page names a phrase that contains it", async () => {
    const prompt = installLanguageModel(
      async () => "%%1%%です",
    );
    const onTranslated = vi.fn();
    const engine = createTestEngine(
      "prompt-api",
      ["Cursor 4.5"],
      onTranslated,
    );

    await engine.initialize();
    await translateClause(
      engine,
      9,
      "We shipped Cursor today.",
    );

    const sent = String(
      prompt.mock.calls[0]?.[0] ?? "",
    );

    expect(sent).toContain(
      "[今訳す節]\nWe shipped %%1%% today.",
    );
    // The proper-noun block still names Cursor 4.5, because that is what the
    // page called it. What matters is that the clause handed to the model
    // carries a placeholder instead of the name.
    expect(
      sent.slice(
        sent.indexOf("[今訳す節]"),
      ),
    ).not.toContain("Cursor");
    expect(onTranslated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 9 }),
      "Cursorです",
    );

    engine.destroy();
  });
});
