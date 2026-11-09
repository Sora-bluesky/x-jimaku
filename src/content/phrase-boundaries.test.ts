import {
  describe,
  expect,
  it,
} from "vitest";
import { findJapanesePhraseBoundaries } from "./phrase-boundaries";

describe("findJapanesePhraseBoundaries", () => {
  it("returns no boundaries for empty, single-character, and ASCII input", () => {
    expect(
      findJapanesePhraseBoundaries(""),
    ).toEqual(new Set());
    expect(
      findJapanesePhraseBoundaries("空"),
    ).toEqual(new Set());
    expect(
      findJapanesePhraseBoundaries("😀"),
    ).toEqual(new Set());
    expect(
      findJapanesePhraseBoundaries(
        "Hello, world",
      ),
    ).toEqual(new Set());
  });

  it("matches the default Japanese parse of 今日は天気です。", () => {
    expect(
      [
        ...findJapanesePhraseBoundaries(
          "今日は天気です。",
        ),
      ].sort((left, right) => left - right),
    ).toEqual([3]);
  });

  it("returns code-point indices that index Array.from(text)", () => {
    const text = "😀今日は天気です。";
    const characters = Array.from(text);
    const boundaries =
      findJapanesePhraseBoundaries(text);

    expect(boundaries.has(4)).toBe(true);
    expect(
      characters.slice(0, 4).join(""),
    ).toBe("😀今日は");

    for (const boundary of boundaries) {
      expect(boundary).toBeGreaterThan(0);
      expect(boundary).toBeLessThan(
        characters.length,
      );
      expect(
        Array.from(
          characters
            .slice(0, boundary)
            .join(""),
        ),
      ).toHaveLength(boundary);
    }
  });

  it("breaks どんどん空いっぱい after どんどん and 空", () => {
    const boundaries =
      findJapanesePhraseBoundaries(
        "どんどん空いっぱい",
      );

    expect(boundaries.has(4)).toBe(true);
    expect(boundaries.has(5)).toBe(true);
  });
});
