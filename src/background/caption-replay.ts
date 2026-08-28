export interface CaptionReplayLine {
  id: number;
  text: string;
  ja?: string;
  final: boolean;
  at: string;
}

export interface CaptionReplayPayload {
  t: "SW_CAPTION";
  id: number;
  text: string;
  ja?: string;
  final: boolean;
  at: string;
}

export function createCaptionReplay(
  lines: readonly CaptionReplayLine[],
): CaptionReplayPayload[] {
  return lines
    .filter((line) => line.final)
    .sort((left, right) =>
      left.id - right.id
    )
    .map((line) => ({
      t: "SW_CAPTION",
      id: line.id,
      text: line.text,
      final: line.final,
      at: line.at,
      ...(line.ja === undefined
        ? {}
        : { ja: line.ja }),
    }));
}
