import {
  describe,
  expect,
  it,
} from "vitest";
import {
  displayUnits,
  endsWithJapaneseParticle,
  MAX_LINE_UNITS,
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
