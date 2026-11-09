import {
  describe,
  expect,
  it,
} from "vitest";

import {
  GLOSSARY_MATCH_CAP,
  KEEP_LATIN_MATCH_CAP,
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
  it("selects ambiguous names with their metadata", () => {
    const ordinary = selectGlossaryMatches(
      "The Cursor moved",
    );

    expect(keepLatinTerms(
      "GitHub released Cursor",
    )).toEqual(["GitHub", "Cursor"]);
    expect(ordinary.keepLatin).toHaveLength(1);
    expect(ordinary.keepLatin[0]).toMatchObject(
      { term: "Cursor", ambiguous: true },
    );

  });

  it("selects lowercase meta as the company entry with its ambiguity metadata", () => {
    const selected = selectGlossaryMatches(
      "meta learning",
    ).keepLatin;

    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject(
      { term: "Meta", ambiguous: true },
    );
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

  it("selects nothing when the clause has no glossary term", () => {
    expect(
      selectGlossaryMatches("Hello everyone."),
    ).toEqual({
      keepLatin: [],
      glossary: [],
    });
  });
});
