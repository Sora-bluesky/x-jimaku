export type PcmSequenceGapLog =
  | {
      level: "info";
      message: string;
      payload: {
        expected: number;
        received: number;
      };
    }
  | {
      level: "warn";
      message: string;
      payload: {
        expected: number;
        received: number;
        lost: number;
      };
    };

export function describePcmSequenceGap(
  expected: number,
  received: number,
): PcmSequenceGapLog {
  if (received < expected) {
    return {
      level: "info",
      message:
        "[offscreen] pcm sequence restarted after recovery; audio during the disconnect was not captured",
      payload: {
        expected,
        received,
      },
    };
  }

  const lost = received - expected;

  return {
    level: "warn",
    message:
      `[offscreen] lost ${lost} pcm chunks in transit`,
    payload: {
      expected,
      received,
      lost,
    },
  };
}
