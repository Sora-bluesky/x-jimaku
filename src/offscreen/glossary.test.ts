import {
  describe,
  expect,
  it,
} from "vitest";

import {
  GLOSSARY_MATCH_CAP,
  KEEP_LATIN_ALL_TERMS,
  KEEP_LATIN_MASK_TERMS,
  KEEP_LATIN_MATCH_CAP,
  countKatakanaNameHits,
  glossaryPromptBlocks,
  keepLatinEntriesForTerms,
  selectGlossaryMatches,
} from "./glossary";

function keepLatinTerms(
  clause: string,
): string[] {
  return selectGlossaryMatches(clause)
    .keepLatin.map((entry) => entry.term);
}

function glossaryTerms(
  clause: string,
): string[] {
  return selectGlossaryMatches(clause)
    .glossary.map((entry) => entry.term);
}

describe("selectGlossaryMatches", () => {
  it("yields a product name and the same word as ordinary English, with conditional phrasing", () => {
    const product = selectGlossaryMatches(
      "GitHub released Cursor",
    );
    const ordinary = selectGlossaryMatches(
      "The Cursor moved",
    );

    expect(keepLatinTerms(
      "GitHub released Cursor",
    )).toEqual(["GitHub", "Cursor"]);
    expect(ordinary.keepLatin).toEqual([
      { term: "Cursor", ambiguous: true },
    ]);

    const productPrompt =
      glossaryPromptBlocks(product).join("\n");
    const ordinaryPrompt =
      glossaryPromptBlocks(ordinary).join("\n");

    expect(productPrompt).toContain("GitHub");
    expect(productPrompt).toContain(
      "モデル・製品・組織名のときだけ原綴り（一般語は訳す）: Cursor",
    );
    expect(ordinaryPrompt).toBe(
      "[原綴り]\nモデル・製品・組織名のときだけ原綴り（一般語は訳す）: Cursor",
    );
  });

  it("selects lowercase meta as the company entry without masking it", () => {
    expect(
      selectGlossaryMatches("meta learning")
        .keepLatin,
    ).toEqual([
      { term: "Meta", ambiguous: true },
    ]);
    expect(
      keepLatinTerms("Meta released Llama"),
    ).toEqual(["Meta", "Llama"]);
    expect(
      keepLatinTerms("meta llama"),
    ).toEqual(["Meta", "Llama"]);
  });

  it("matches lowercase opus 4.5 and fable 5.1", () => {
    expect(keepLatinTerms("opus 4.5"))
      .toEqual(["Opus"]);
    expect(keepLatinTerms("fable 5.1"))
      .toEqual(["Fable"]);
    expect(
      keepLatinTerms("using clerk"),
    ).toEqual(["Clerk"]);
    expect(
      keepLatinTerms("the blinking cursor"),
    ).toEqual(["Cursor"]);
  });

  it("matches Hugging Face as a phrase, not as two words", () => {
    expect(
      keepLatinTerms("Hugging Face released"),
    ).toEqual(["Hugging Face"]);
    expect(
      keepLatinTerms("Hugging the Face"),
    ).toEqual([]);
  });

  it("caps each list and keeps the most specific terms", () => {
    const keepLatin = keepLatinTerms(
      "Kennedy Space Center Hugging Face Anthropic DeepMind ChatGPT OpenAI Claude NVIDIA GitHub GPT API",
    );
    expect(keepLatin).toHaveLength(
      KEEP_LATIN_MATCH_CAP,
    );
    expect(keepLatin).toEqual([
      "Kennedy Space Center",
      "Hugging Face",
      "Anthropic",
      "DeepMind",
      "ChatGPT",
      "OpenAI",
    ]);

    const glossary = glossaryTerms(
      "agentic workflow extended thinking context window neural network machine learning open weights fine-tuning",
    );
    expect(glossary).toHaveLength(
      GLOSSARY_MATCH_CAP,
    );
    expect(glossary).toEqual([
      "agentic workflow",
      "extended thinking",
      "context window",
      "machine learning",
    ]);
  });

  it("matches xAI, GPT-4 hyphenation, and clause edges", () => {
    expect(
      keepLatinTerms("xAI shipped Grok"),
    ).toEqual(["xAI", "Grok"]);
    expect(
      keepLatinTerms("GPT-4 and GPU"),
    ).toEqual(["GPT", "GPU"]);
    expect(keepLatinTerms("Opus")).toEqual([
      "Opus",
    ]);
    expect(keepLatinTerms("Opus.")).toEqual([
      "Opus",
    ]);
  });

  it("adds no prompt section when the clause has no glossary term", () => {
    expect(
      selectGlossaryMatches("Hello everyone."),
    ).toEqual({
      keepLatin: [],
      glossary: [],
    });
    expect(
      glossaryPromptBlocks({
        keepLatin: [],
        glossary: [],
      }),
    ).toEqual([]);
  });
});

describe("keepLatinEntriesForTerms", () => {
  it("keeps conditional metadata and skips unknown terms", () => {
    expect(
      keepLatinEntriesForTerms([
        "Claude",
        "Roman",
        "roman",
        "U.S.",
      ]),
    ).toEqual([
      { term: "Claude" },
      { term: "Roman", ambiguous: true },
    ]);
    expect(
      keepLatinEntriesForTerms([]),
    ).toEqual([]);
  });
});

describe("KEEP_LATIN_MASK_TERMS", () => {
  it("omits ambiguous names that must not be masked", () => {
    expect(KEEP_LATIN_MASK_TERMS).toContain(
      "Claude",
    );
    expect(KEEP_LATIN_MASK_TERMS).toContain(
      "Hugging Face",
    );
    expect(
      KEEP_LATIN_MASK_TERMS,
    ).not.toContain("Cursor");
    expect(
      KEEP_LATIN_MASK_TERMS,
    ).not.toContain("Roman");
    expect(KEEP_LATIN_ALL_TERMS).toContain(
      "Cursor",
    );
    expect(KEEP_LATIN_ALL_TERMS).toContain(
      "Claude",
    );
  });

  it("holds Opus, Sonnet, Haiku, Fable, and Mythos in Latin unconditionally", () => {
    for (const term of [
      "Opus",
      "Sonnet",
      "Haiku",
      "Fable",
      "Mythos",
    ]) {
      expect(KEEP_LATIN_MASK_TERMS).toContain(
        term,
      );
      expect(
        selectGlossaryMatches(term).keepLatin,
      ).toEqual([{ term }]);
      expect(
        selectGlossaryMatches(
          term.toLowerCase(),
        ).keepLatin,
      ).toEqual([{ term }]);
    }
  });

  it("holds Clerk in Latin unconditionally", () => {
    expect(KEEP_LATIN_MASK_TERMS).toContain(
      "Clerk",
    );
    expect(
      selectGlossaryMatches("Clerk").keepLatin,
    ).toEqual([{ term: "Clerk" }]);
    expect(
      selectGlossaryMatches("clerk").keepLatin,
    ).toEqual([{ term: "Clerk" }]);
  });
});

describe("countKatakanaNameHits", () => {
  const renderings = [
    { term: "Opus", rendering: "オプス" },
    { term: "Cursor", rendering: "カーソル" },
  ];
  const text = "オプスとカーソルとオプス";

  it("buckets by the glossary flag so flipping an entry moves the count", () => {
    expect(
      countKatakanaNameHits(
        text,
        [
          { term: "Opus" },
          {
            term: "Cursor",
            ambiguous: true,
          },
        ],
        renderings,
      ),
    ).toEqual({
      ambiguous: 1,
      plain: 2,
    });
    expect(
      countKatakanaNameHits(
        text,
        [
          {
            term: "Opus",
            ambiguous: true,
          },
          {
            term: "Cursor",
            ambiguous: true,
          },
        ],
        renderings,
      ),
    ).toEqual({
      ambiguous: 3,
      plain: 0,
    });
  });
});
