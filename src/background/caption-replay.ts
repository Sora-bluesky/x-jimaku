import type {
  RecognitionPayload,
  SwCaptionMessage,
  SwRecognitionMessage,
} from "../shared/messages";

export interface CaptionReplayLine
  extends RecognitionPayload {
}

export type CaptionReplayPayload =
  SwCaptionMessage;

export function createRecognitionRelays(
  line: RecognitionPayload,
): {
  recognition: SwRecognitionMessage;
  caption: SwCaptionMessage;
} {
  const payload = {
    id: line.id,
    text: line.text,
    final: line.final,
    at: line.at,
    ...(line.ja === undefined
      ? {}
      : { ja: line.ja }),
    ...(line.fallback === undefined
      ? {}
      : { fallback: line.fallback }),
    ...(line.rung === undefined
      ? {}
      : { rung: line.rung }),
  };

  return {
    recognition: {
      t: "SW_RECOG",
      ...payload,
    },
    caption: {
      t: "SW_CAPTION",
      ...payload,
    },
  };
}

export function createCaptionReplay(
  lines: readonly CaptionReplayLine[],
): CaptionReplayPayload[] {
  return lines
    .filter((line) => line.final)
    .sort((left, right) =>
      left.id - right.id
    )
    .map(
      (line) =>
        createRecognitionRelays(line)
          .caption,
    );
}
