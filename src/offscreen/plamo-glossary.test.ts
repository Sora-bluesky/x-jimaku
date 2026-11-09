import { expect, it } from "vitest";
import { selectGlossaryMatches } from "./glossary";
import { selectPlamoGlossary } from "./plamo-glossary";

it("renders names and terminology using existing capped selection", () => {
  const clause = "Roman and Claude use a neural network and machine learning.";
  const pairs = selectPlamoGlossary(clause);
  expect(pairs).toContainEqual({ source: "Roman", target: "ローマン" });
  expect(pairs).toContainEqual({ source: "Claude", target: "Claude" });
  const selection = selectGlossaryMatches(clause);
  expect(pairs.map(pair => pair.source)).toEqual([...selection.keepLatin, ...selection.glossary].map(entry => entry.term));
  for (const entry of selection.glossary) expect(pairs).toContainEqual({ source: entry.term, target: entry.ja });
});

it("appends page terms in input order, matches whole words and deduplicates case-insensitively", () => {
  expect(selectPlamoGlossary("CLAUDE and Quasar use A+B, not Quasarish.", ["Quasar", "quasar", "Claude", "A+B", "Quas", "missing"])).toEqual([
    { source: "Claude", target: "Claude" }, { source: "Quasar", target: "Quasar" }, { source: "A+B", target: "A+B" },
  ]);
  expect(selectPlamoGlossary("Quasarish _Quasar Quasar2 前Quasar", ["Quasar"])).toEqual([]);
});

it("preserves the built-in caps with deterministic results", () => {
  const clause = "Anthropic Claude Opus Sonnet Haiku OpenAI GPT-4 ChatGPT Gemini Roman Goddard";
  const selection = selectGlossaryMatches(clause);
  expect(selectPlamoGlossary(clause)).toHaveLength(selection.keepLatin.length + selection.glossary.length);
  expect(selection.keepLatin.length).toBeLessThanOrEqual(6);
});
