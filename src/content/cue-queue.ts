export interface CueQueueEntry {
  readonly cueId: string;
  readonly units: number;
}

export interface CueQueueConstants {
  readonly maxWaitingCues: number;
  readonly maxCueUnits: number;
  readonly accelerationThreshold: number;
  readonly mergeSeparatorUnits: number;
}

export interface CueQueueDecision {
  readonly mergeIndices: readonly number[];
  readonly dropCount: number;
  readonly acceleratedUntilDrained: boolean;
  readonly shouldReschedule: boolean;
}

export function decideCueQueueDiscipline(
  cues: readonly CueQueueEntry[],
  acceleratedUntilDrained: boolean,
  constants: CueQueueConstants,
): CueQueueDecision {
  const simulated = cues.map(
    (cue): CueQueueEntry => ({
      cueId: cue.cueId,
      units: cue.units,
    }),
  );
  const mergeIndices: number[] = [];

  while (
    simulated.length >
    constants.maxWaitingCues
  ) {
    let mergeIndex: number | null = null;

    for (
      let index = 0;
      index < simulated.length - 1;
      index += 1
    ) {
      const left = simulated[index];
      const right = simulated[index + 1];

      if (
        left === undefined ||
        right === undefined
      ) {
        continue;
      }

      const combinedUnits =
        left.units +
        constants.mergeSeparatorUnits +
        right.units;

      if (
        combinedUnits >
        constants.maxCueUnits
      ) {
        continue;
      }

      simulated.splice(
        index,
        2,
        {
          cueId:
            `${left.cueId}+${right.cueId}`,
          units: combinedUnits,
        },
      );
      mergeIndex = index;
      mergeIndices.push(index);
      break;
    }

    if (mergeIndex === null) {
      break;
    }
  }

  const dropCount = Math.max(
    0,
    simulated.length -
      constants.maxWaitingCues,
  );
  const accelerationRequested =
    cues.length >=
      constants.accelerationThreshold ||
    dropCount > 0;
  const nextAcceleratedUntilDrained =
    acceleratedUntilDrained ||
    accelerationRequested;

  return {
    mergeIndices,
    dropCount,
    acceleratedUntilDrained:
      nextAcceleratedUntilDrained,
    shouldReschedule:
      !acceleratedUntilDrained &&
      nextAcceleratedUntilDrained,
  };
}

export function cueDisplayDurationMs(
  acceleratedUntilDrained: boolean,
  minimumDisplayMs: number,
  acceleratedDisplayMs: number,
): number {
  return acceleratedUntilDrained
    ? acceleratedDisplayMs
    : minimumDisplayMs;
}

export function retainAccelerationUntilDrained(
  acceleratedUntilDrained: boolean,
  waitingCueCount: number,
): boolean {
  return (
    acceleratedUntilDrained &&
    waitingCueCount > 0
  );
}
