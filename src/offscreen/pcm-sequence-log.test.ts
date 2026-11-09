import {
  describe,
  expect,
  it,
} from "vitest";
import {
  describePcmSequenceGap,
} from "./pcm-sequence-log";

describe("describePcmSequenceGap", () => {
  it("classifies a sequence restart as info and preserves its payload", () => {
    expect(
      describePcmSequenceGap(12, 0),
    ).toEqual({
      level: "info",
      message:
        "[offscreen] pcm sequence restarted after recovery; audio during the disconnect was not captured",
      payload: {
        expected: 12,
        received: 0,
      },
    });
  });

  it("keeps forward chunk loss at warn", () => {
    expect(
      describePcmSequenceGap(12, 15),
    ).toEqual({
      level: "warn",
      message:
        "[offscreen] lost 3 pcm chunks in transit",
      payload: {
        expected: 12,
        received: 15,
        lost: 3,
      },
    });
  });
});
