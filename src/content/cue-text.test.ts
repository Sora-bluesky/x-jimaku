import {
  describe,
  expect,
  it,
} from "vitest";
import { findJapanesePhraseBoundaries } from "./phrase-boundaries";
import {
  createCaptionTextMeasurer,
  deriveLineUnitBudget,
  displayUnits,
  endsWithJapaneseParticle,
  isCaptionLayoutMeasured,
  MAX_LINE_UNITS,
  MIN_FITTING_LINE_UNITS,
  splitCueText,
  wrapCueText,
} from "./cue-text";

function normalizeCueText(
  text: string,
): string {
  return text
    .replace(/\s+/gu, " ")
    .trim();
}

function createSeededRandom(
  seed: number,
): () => number {
  let state = seed >>> 0;

  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;

    return state / 0x1_0000_0000;
  };
}

function createRandomText(
  random: () => number,
  length: number,
): string {
  const groups = [
    Array.from(
      "あいうえおかきくけこさしすせそ",
    ),
    Array.from(
      "字幕翻訳動画音声言葉境界日本語",
    ),
    Array.from(
      "abcdefghijklmnopqrstuvwxyz",
    ),
  ];
  const characters: string[] = [];

  while (characters.length < length) {
    const remaining =
      length - characters.length;

    if (
      remaining >= 24 &&
      random() < 0.16
    ) {
      const base =
        Array.from("https://example.com/");
      const urlLength =
        24 +
        Math.floor(
          random() * (remaining - 23),
        );
      const url = [
        ...base,
        ...Array.from(
          "a".repeat(
            Math.max(
              0,
              urlLength - base.length,
            ),
          ),
        ),
      ];

      characters.push(
        ...url.slice(0, remaining),
      );
      continue;
    }

    const group =
      groups[
        Math.floor(
          random() * groups.length,
        )
      ] ?? groups[0];
    const character =
      group[
        Math.floor(
          random() * group.length,
        )
      ] ?? "あ";

    characters.push(character);
  }

  return characters.join("");
}

function hasParticleAt(
  text: string,
  before: string,
): boolean {
  return endsWithJapaneseParticle(
    Array.from(text),
    0,
    Array.from(before).length,
  );
}

describe("wrapCueText", () => {
  it(
    "balances a normal cue without losing normalized characters",
    () => {
      const text =
        "alpha beta gamma delta epsilon zeta";
      const wrapped =
        wrapCueText(text);

      expect(wrapped).toBe(
        "alpha beta gamma \ndelta epsilon zeta",
      );
      expect(
        wrapped.split("\n").join(""),
      ).toBe(normalizeCueText(text));
    },
  );

  it(
    "force-cuts a forty-unit URL without dropping characters",
    () => {
      const url =
        `https://${"a".repeat(72)}`;

      expect(displayUnits(url)).toBe(40);

      const lines =
        wrapCueText(url).split("\n");

      expect(lines.length).toBeGreaterThan(2);
      expect(lines.join("")).toBe(url);

      for (const line of lines) {
        expect(
          displayUnits(line),
        ).toBeLessThanOrEqual(
          MAX_LINE_UNITS,
        );
      }
    },
  );

  it(
    "force-cuts before slicing when a protected URL crosses the target",
    () => {
      const text =
        `https://${"a".repeat(32)} あいうえおかき`;
      const normalized =
        normalizeCueText(text);
      const lines =
        wrapCueText(text).split("\n");

      expect(
        displayUnits(normalized),
      ).toBe(27.5);
      expect(lines).toHaveLength(2);
      expect(lines.join("")).toBe(
        normalized,
      );

      for (const line of lines) {
        expect(
          displayUnits(line),
        ).toBeLessThanOrEqual(
          MAX_LINE_UNITS,
        );
      }
    },
  );

  it(
    "never loses characters or returns a line above the unit limit for seeded random text",
    () => {
      const random =
        createSeededRandom(0x47c0ffee);

      for (
        let index = 0;
        index < 200;
        index += 1
      ) {
        const length =
          1 +
          Math.floor(random() * 120);
        const text =
          createRandomText(
            random,
            length,
          );
        const normalized =
          normalizeCueText(text);
        const lines =
          wrapCueText(text).split("\n");

        expect(
          lines.join(""),
        ).toBe(normalized);

        for (const line of lines) {
          expect(
            displayUnits(line),
          ).toBeLessThanOrEqual(
            MAX_LINE_UNITS,
          );
        }
      }
    },
  );
});

describe("splitCueText", () => {
  it(
    "never emits a segment above its unit budget for unsplittable units",
    () => {
      const url =
        `https://${"a".repeat(72)}`;
      const katakana =
        "カ".repeat(40);
      const unitBudget = 10;

      for (
        const text of [
          url,
          katakana,
          `${url}${katakana}`,
        ]
      ) {
        const segments =
          splitCueText(
            text,
            unitBudget,
          );

        expect(
          segments.length,
        ).toBeGreaterThan(1);

        for (const segment of segments) {
          expect(
            displayUnits(segment),
          ).toBeLessThanOrEqual(
            unitBudget,
          );
        }
      }
    },
  );

  // A cue is NOT guaranteed to wrap into at most two lines. When the boundary
  // rules refuse the positions near the budget, wrapCueText breaks early and
  // spills into a third line, e.g. the 28-unit part
  // "おネち5ナbた1）6c オネz0と3そ4たく0 2ア pてせ、ぬ c ）、" wraps to
  // ["おネち5ナbた1）6c オネz0と3", "そ4たく0 2ア ", "pてせ、ぬ c ）、"].
  // The display has two fixed slots, so a three-line cue needs two pages.
  // What has to hold here is the per-line budget. The page path makes every
  // line reach the screen, and overlay.test.ts covers that behavior.
  it(
    "keeps every wrapped line within the unit budget across the boundary corpus",
    () => {
      const random =
        createSeededRandom(0x71c0ffee);
      const corpus = [
        `https://${"a".repeat(72)}`,
        "カ".repeat(40),
      ];

      for (
        let index = 0;
        index < 200;
        index += 1
      ) {
        corpus.push(
          createRandomText(
            random,
            1 +
              Math.floor(
                random() * 120,
              ),
          ),
        );
      }

      for (const text of corpus) {
        for (
          const part
          of splitCueText(text)
        ) {
          const lines = wrapCueText(
            part,
            MAX_LINE_UNITS,
          ).split("\n");

          expect(
            lines.length,
          ).toBeGreaterThan(0);

          for (const line of lines) {
            expect(
              displayUnits(line.trimEnd()),
            ).toBeLessThanOrEqual(
              MAX_LINE_UNITS,
            );
          }
        }
      }
    },
  );
});

describe(
  "Japanese particle boundary bonus",
  () => {
    it.each([
      {
        text: "本です",
        before: "本で",
      },
      {
        text: "本ですが",
        before: "本で",
      },
      {
        text: "猫でした",
        before: "猫で",
      },
      {
        text: "漢字ながら",
        before: "漢字なが",
      },
      {
        text: "学校でも",
        before: "学校で",
      },
    ])(
      "does not reward the word-internal boundary after $before",
      ({
        text,
        before,
      }) => {
        expect(
          hasParticleAt(text, before),
        ).toBe(false);
      },
    );

    it.each([
      {
        text: "自分でする",
        before: "自分で",
      },
      {
        text: "学校でもう一度学ぶ",
        before: "学校で",
      },
      {
        text: "庭でしようと思う",
        before: "庭で",
      },
    ])(
      "keeps the real particle boundary after $before despite a matching prefix",
      ({
        text,
        before,
      }) => {
        expect(
          hasParticleAt(text, before),
        ).toBe(true);
      },
    );

    it.each([
      {
        text: "漢字は",
        before: "漢字は",
      },
      {
        text: "漢字を",
        before: "漢字を",
      },
      {
        text: "カタカナが続く",
        before: "カタカナが",
      },
      {
        text: "AIと",
        before: "AIと",
      },
      {
        text: "駅まで",
        before: "駅まで",
      },
      {
        text: "漢字で",
        before: "漢字で",
      },
    ])(
      "keeps the real particle boundary after $before",
      ({
        text,
        before,
      }) => {
        expect(
          hasParticleAt(text, before),
        ).toBe(true);
      },
    );
  },
);


describe(
  "sub-character unit budgets",
  () => {
    it(
      "splitCueText consumes at least one character per segment",
      () => {
        expect(
          splitCueText("日", 0.5),
        ).toEqual(["日"]);
        expect(
          splitCueText("日本語", 0.5),
        ).toEqual(["日", "本", "語"]);
      },
    );

    it(
      "wrapCueText terminates and loses nothing",
      () => {
        const wrapped = wrapCueText(
          "日本",
          0.5,
        );

        expect(
          wrapped.split("\n").join(""),
        ).toBe("日本");
      },
    );
  },
);

describe(
  "particle heuristic refinements",
  () => {
    it.each([
      { text: "きょうは", before: "きょうは" },
      { text: "わたしは", before: "わたしは" },
      { text: "うちにかえる", before: "うちに" },
    ])(
      "keeps genuine particles after hiragana words ($before)",
      ({ text, before }) => {
        expect(
          hasParticleAt(text, before),
        ).toBe(true);
      },
    );

    it.each([
      { text: "素敵ですか", before: "素敵で" },
      { text: "そうですよ", before: "そうで" },
      { text: "元気ですね", before: "元気で" },
    ])(
      "vetoes copulas followed by sentence-final particles ($text)",
      ({ text, before }) => {
        expect(
          hasParticleAt(text, before),
        ).toBe(false);
      },
    );
  },
);

describe(
  "copulas followed by connectives",
  () => {
    it.each([
      { text: "素敵ですので", before: "素敵で" },
      { text: "元気ですけど", before: "元気で" },
      { text: "本ですし", before: "本で" },
    ])(
      "vetoes copula + connective ($text)",
      ({ text, before }) => {
        expect(
          hasParticleAt(text, before),
        ).toBe(false);
      },
    );

    it(
      "keeps a genuine で before すぐ",
      () => {
        expect(
          hasParticleAt(
            "学校ですぐ帰る",
            "学校で",
          ),
        ).toBe(true);
      },
    );
  },
);

describe(
  "fourth review round refinements",
  () => {
    it.each([
      { text: "ことがわかる", before: "ことが" },
      { text: "これができる", before: "これが" },
      { text: "本ですが、", before: "本ですが" },
    ])(
      "keeps genuine が after hiragana ($before)",
      ({ text, before }) => {
        expect(
          hasParticleAt(text, before),
        ).toBe(true);
      },
    );

    it(
      "still vetoes the word-internal が in ながら",
      () => {
        expect(
          hasParticleAt(
            "歩きながら話す",
            "歩きなが",
          ),
        ).toBe(false);
      },
    );

    it(
      "does not mistake すのこ for the ので connective",
      () => {
        expect(
          hasParticleAt(
            "学校ですのこを作る",
            "学校で",
          ),
        ).toBe(true);
      },
    );

    it.each([
      { text: "素敵ですので行く", before: "素敵で" },
      { text: "元気ですのに休む", before: "元気で" },
      { text: "元気でしょうから", before: "元気で" },
      { text: "そうでしょうね", before: "そうで" },
      { text: "元気ですけど帰る", before: "元気で" },
      { text: "本ですし、", before: "本で" },
    ])(
      "still vetoes complete connectives ($text)",
      ({ text, before }) => {
        expect(
          hasParticleAt(text, before),
        ).toBe(false);
      },
    );

    it(
      "keeps a genuine で before すし",
      () => {
        expect(
          hasParticleAt(
            "店ですしを食べた",
            "店で",
          ),
        ).toBe(true);
      },
    );
  },
);

function glyphWidth(
  character: string,
): number {
  if (character === "W") {
    return 20;
  }

  return /[\u0000-\u00ff]/u.test(
    character,
  )
    ? 5
    : 10;
}

function measureByGlyph(
  text: string,
): number {
  let width = 0;

  for (const character of text) {
    width += glyphWidth(character);
  }

  return width;
}

describe("measured wrapping", () => {
  const wideLayout = {
    availableWidth: 50,
    measure: measureByGlyph,
  };
  const mixedLayout = {
    availableWidth: 40,
    measure: measureByGlyph,
  };
  const unitLayout = {
    availableWidth: MAX_LINE_UNITS * 10,
    measure: (text: string) =>
      displayUnits(text) * 10,
  };
  const mixedPropertyLayout = {
    availableWidth: 140,
    measure: (text: string) => {
      let width = 0;

      for (const character of text) {
        width +=
          character === "W"
            ? 12
            : /[\u0000-\u00ff]/u.test(
                character,
              )
              ? 5
              : 10;
      }

      return width;
    },
  };

  it(
    "breaks a wide ASCII run the unit model would keep",
    () => {
      const text = "WWWWWWWW";

      expect(wrapCueText(text, 1000))
        .toBe(text);
      expect(
        wrapCueText(
          text,
          1000,
          wideLayout,
        ).split("\n"),
      ).toEqual(["WW", "WW", "WW", "WW"]);
      expect(splitCueText(text, 1000))
        .toEqual([text]);
      expect(
        splitCueText(
          text,
          1000,
          wideLayout,
        ),
      ).toEqual(["WWW", "WWWWW"]);
    },
  );

  it(
    "breaks a CJK and Latin mix the unit model would keep",
    () => {
      const text = "W幅W幅W幅W幅";

      expect(wrapCueText(text)).toBe(text);
      expect(
        wrapCueText(
          text,
          MAX_LINE_UNITS,
          mixedLayout,
        ).split("\n"),
      ).toEqual([
        "W幅",
        "W幅",
        "W幅",
        "W幅",
      ]);
    },
  );

  it(
    "matches today's wrapping when measurement is unavailable",
    () => {
      const text =
        "alpha beta gamma delta epsilon zeta";
      const unavailable = {
        availableWidth: 1,
        measure: () => null,
      };

      expect(
        isCaptionLayoutMeasured(
          unavailable,
        ),
      ).toBe(false);
      expect(
        wrapCueText(
          text,
          MAX_LINE_UNITS,
          unavailable,
        ),
      ).toBe(wrapCueText(text));
      expect(
        splitCueText(text, 28, unavailable),
      ).toEqual(splitCueText(text));
    },
  );

  it(
    "createCaptionTextMeasurer stays on the unit path without a canvas",
    () => {
      const measurer =
        createCaptionTextMeasurer();
      measurer.setFont("650 16px sans-serif");

      expect(measurer.isMeasured()).toBe(
        false,
      );
      expect(measurer.measure("W")).toBe(
        null,
      );
      expect(measurer.measureLineBox()).toBe(
        null,
      );
    },
  );

  it(
    "keeps #47 properties under measurement, including katakana and URL runs",
    () => {
      const random =
        createSeededRandom(0x47c0ffee);
      const corpus = [
        `https://${"a".repeat(72)}`,
        "カ".repeat(40),
      ];

      for (
        let index = 0;
        index < 200;
        index += 1
      ) {
        corpus.push(
          createRandomText(
            random,
            1 +
              Math.floor(random() * 120),
          ),
        );
      }

      for (const text of corpus) {
        const normalized =
          normalizeCueText(text);

        expect(
          wrapCueText(
            text,
            MAX_LINE_UNITS,
            unitLayout,
          ),
        ).toBe(wrapCueText(text));

        for (
          const layout of [
            unitLayout,
            mixedPropertyLayout,
          ]
        ) {
          const parts = splitCueText(
            text,
            MAX_LINE_UNITS * 2,
            layout,
          );
          expect(
            parts.length,
          ).toBeGreaterThan(0);

          for (const part of parts) {
            const partWidth =
              layout.measure(part);
            expect(partWidth).not.toBeNull();
            expect(partWidth ?? Infinity)
              .toBeLessThanOrEqual(
                layout.availableWidth * 2,
              );

            const wrapped = wrapCueText(
              part,
              MAX_LINE_UNITS,
              layout,
            );
            const lines =
              wrapped.split("\n");

            expect(
              lines.length,
            ).toBeGreaterThan(0);
            expect(lines.join("")).toBe(
              part,
            );

            for (const line of lines) {
              const width = layout.measure(
                line.trimEnd(),
              );
              expect(width).not.toBeNull();
              expect(width ?? Infinity)
                .toBeLessThanOrEqual(
                  layout.availableWidth,
                );
            }
          }
        }

        expect(
          wrapCueText(
            text,
            MAX_LINE_UNITS,
            mixedPropertyLayout,
          ).split("\n").join(""),
        ).toBe(normalized);
      }
    },
  );
});

describe("deriveLineUnitBudget", () => {
  it(
    "follows inner width and has no upper clamp",
    () => {
      expect(
        deriveLineUnitBudget(200, 10),
      ).toBe(20);
      expect(
        deriveLineUnitBudget(400, 10),
      ).toBe(40);
      expect(
        deriveLineUnitBudget(4000, 10),
      ).toBe(400);
      expect(
        deriveLineUnitBudget(400, 10),
      ).toBeGreaterThan(
        deriveLineUnitBudget(200, 10),
      );
    },
  );

  it(
    "clamps to MIN_FITTING_LINE_UNITS below 18px at 18.75px",
    () => {
      expect(
        deriveLineUnitBudget(18, 18.75),
      ).toBe(MIN_FITTING_LINE_UNITS);
      expect(
        deriveLineUnitBudget(0, 18.75),
      ).toBe(MIN_FITTING_LINE_UNITS);
      expect(
        deriveLineUnitBudget(1, 18.75),
      ).toBe(MIN_FITTING_LINE_UNITS);
      expect(
        deriveLineUnitBudget(37.5, 18.75),
      ).toBe(2);
    },
  );

  it(
    "falls back to MAX_LINE_UNITS for a non-positive font size",
    () => {
      expect(
        deriveLineUnitBudget(500, 0),
      ).toBe(MAX_LINE_UNITS);
      expect(
        deriveLineUnitBudget(500, -8),
      ).toBe(MAX_LINE_UNITS);
    },
  );
});

describe(
  "non-default line unit budget properties",
  () => {
    it(
      "loses nothing, stays in budget, and terminates",
      () => {
        const random =
          createSeededRandom(0x47c0ffee);
        const corpus = [
          `https://${"a".repeat(72)}`,
          "カ".repeat(40),
        ];

        for (
          let index = 0;
          index < 200;
          index += 1
        ) {
          corpus.push(
            createRandomText(
              random,
              1 +
                Math.floor(
                  random() * 120,
                ),
            ),
          );
        }

        for (
          const lineBudget of [10, 30]
        ) {
          const cueBudget =
            lineBudget * 2;

          for (const text of corpus) {
            const parts = splitCueText(
              text,
              cueBudget,
            );

            expect(
              parts.length,
            ).toBeGreaterThan(0);

            for (const part of parts) {
              expect(
                displayUnits(part),
              ).toBeLessThanOrEqual(
                cueBudget,
              );

              const wrapped = wrapCueText(
                part,
                lineBudget,
              );
              const lines =
                wrapped.split("\n");

              expect(
                lines.length,
              ).toBeGreaterThan(0);
              expect(
                lines.join(""),
              ).toBe(part);

              for (const line of lines) {
                expect(
                  displayUnits(
                    line.trimEnd(),
                  ),
                ).toBeLessThanOrEqual(
                  lineBudget,
                );
              }
            }
          }
        }
      },
    );
  },
);

describe("phrase boundary wrapping", () => {
  const phraseText =
    "どんどん空いっぱい光る夜景色";

  it(
    "breaks a particle-free sentence at a phrase boundary instead of the width limit",
    () => {
      const first =
        wrapCueText(
          phraseText,
          6,
        ).split("\n")[0] ?? "";
      const firstLength =
        Array.from(first).length;
      const boundaries =
        findJapanesePhraseBoundaries(
          phraseText,
        );

      expect(firstLength).toBeLessThan(6);
      expect(
        boundaries.has(firstLength),
      ).toBe(true);
      expect(
        wrapCueText(phraseText, 6)
          .split("\n")
          .join(""),
      ).toBe(phraseText);
    },
  );

  it(
    "does not take a phrase boundary past the width limit",
    () => {
      const first =
        wrapCueText(
          phraseText,
          4,
        ).split("\n")[0] ?? "";
      const boundaries =
        findJapanesePhraseBoundaries(
          phraseText,
        );

      expect(boundaries.has(5)).toBe(true);
      expect(first).not.toBe(
        "どんどん空",
      );
      expect(
        displayUnits(first),
      ).toBeLessThanOrEqual(4);
    },
  );

  it(
    "does not break a protected URL at a phrase boundary inside it",
    () => {
      const text =
        "https://今日は天気ですよ続きの文章を足していく確認作業";
      const first =
        wrapCueText(
          text,
          12,
        ).split("\n")[0] ?? "";
      const boundaries =
        findJapanesePhraseBoundaries(
          text,
        );

      expect(boundaries.has(11)).toBe(
        true,
      );
      expect(first).not.toBe(
        "https://今日は",
      );
      expect(
        Array.from(first).length,
      ).toBeGreaterThan(11);
      expect(
        displayUnits(first),
      ).toBeLessThanOrEqual(12);
    },
  );

  it(
    "prefers a clause break after 、 over a phrase boundary at the same distance",
    () => {
      const text =
        "一二三、どんどん空いまる";
      const boundaries =
        findJapanesePhraseBoundaries(
          text,
        );

      expect(boundaries.has(8)).toBe(
        true,
      );
      expect(
        wrapCueText(
          text,
          10,
        ).split("\n")[0],
      ).toBe("一二三、");
    },
  );
});
