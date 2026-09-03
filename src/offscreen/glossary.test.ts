import {
  describe,
  expect,
  it,
} from "vitest";

import {
  GLOSSARY_MATCH_CAP,
  KEEP_LATIN_MATCH_CAP,
  glossaryPromptBlocks,
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
  it("yields a model name and the same word as ordinary English, with conditional phrasing", () => {
    const model = selectGlossaryMatches(
      "Anthropic released Opus",
    );
    const ordinary = selectGlossaryMatches(
      "The Opus premiered tonight",
    );

    expect(keepLatinTerms(
      "Anthropic released Opus",
    )).toEqual(["Anthropic", "Opus"]);
    expect(ordinary.keepLatin).toEqual([
      { term: "Opus", ambiguous: true },
    ]);

    const modelPrompt =
      glossaryPromptBlocks(model).join("\n");
    const ordinaryPrompt =
      glossaryPromptBlocks(ordinary).join("\n");

    expect(modelPrompt).toContain("Anthropic");
    expect(modelPrompt).toContain(
      "モデル・製品・組織名のときだけ原綴り（一般語は訳す）: Opus",
    );
    expect(ordinaryPrompt).toBe(
      "[原綴り]\nモデル・製品・組織名のときだけ原綴り（一般語は訳す）: Opus",
    );
  });

  it("matches Meta as a whole word and ignores lowercase meta", () => {
    expect(keepLatinTerms("meta learning"))
      .toEqual([]);
    expect(
      keepLatinTerms("Meta released Llama"),
    ).toEqual(["Meta", "Llama"]);
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
