import {
  describe,
  expect,
  it,
} from "vitest";

import {
  normalizeLanguageModelResponse,
  stripBalancedWrappingPair,
  stripCodeFence,
  stripTranslationLabel,
} from "./translate";

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
