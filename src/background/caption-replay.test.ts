import {
  describe,
  expect,
  it,
} from "vitest";
import {
  createCaptionReplay,
  type CaptionReplayLine,
} from "./caption-replay";

interface ReplayCase {
  name: string;
  input: CaptionReplayLine[];
  expected: ReturnType<
    typeof createCaptionReplay
  >;
}

describe("createCaptionReplay", () => {
  it.each<ReplayCase>([
    {
      name:
        "restores ascending order from unordered input",
      input: [
        {
          id: 3,
          text: "three",
          final: true,
          at: "2026-08-28T00:00:03.000Z",
        },
        {
          id: 1,
          text: "one",
          final: true,
          at: "2026-08-28T00:00:01.000Z",
        },
        {
          id: 2,
          text: "two",
          final: true,
          at: "2026-08-28T00:00:02.000Z",
        },
      ],
      expected: [
        {
          t: "SW_CAPTION",
          id: 1,
          text: "one",
          final: true,
          at: "2026-08-28T00:00:01.000Z",
        },
        {
          t: "SW_CAPTION",
          id: 2,
          text: "two",
          final: true,
          at: "2026-08-28T00:00:02.000Z",
        },
        {
          t: "SW_CAPTION",
          id: 3,
          text: "three",
          final: true,
          at: "2026-08-28T00:00:03.000Z",
        },
      ],
    },
    {
      name: "excludes non-final lines",
      input: [
        {
          id: 1,
          text: "partial",
          final: false,
          at: "2026-08-28T00:00:01.000Z",
        },
        {
          id: 2,
          text: "final",
          final: true,
          at: "2026-08-28T00:00:02.000Z",
        },
      ],
      expected: [
        {
          t: "SW_CAPTION",
          id: 2,
          text: "final",
          final: true,
          at: "2026-08-28T00:00:02.000Z",
        },
      ],
    },
    {
      name:
        "preserves present ja and omits absent ja",
      input: [
        {
          id: 2,
          text: "without translation",
          final: true,
          at: "2026-08-28T00:00:02.000Z",
        },
        {
          id: 1,
          text: "with translation",
          ja: "翻訳あり",
          final: true,
          at: "2026-08-28T00:00:01.000Z",
        },
      ],
      expected: [
        {
          t: "SW_CAPTION",
          id: 1,
          text: "with translation",
          ja: "翻訳あり",
          final: true,
          at: "2026-08-28T00:00:01.000Z",
        },
        {
          t: "SW_CAPTION",
          id: 2,
          text: "without translation",
          final: true,
          at: "2026-08-28T00:00:02.000Z",
        },
      ],
    },
    {
      name: "returns empty output for empty input",
      input: [],
      expected: [],
    },
  ])("$name", ({ input, expected }) => {
    expect(
      createCaptionReplay(input),
    ).toEqual(expected);
  });
});
