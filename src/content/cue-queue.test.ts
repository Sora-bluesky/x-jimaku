import {
  describe,
  expect,
  it,
} from "vitest";
import {
  cueDisplayDurationMs,
  decideCueQueueDiscipline,
  retainAccelerationUntilDrained,
  type CueQueueDecision,
  type CueQueueEntry,
} from "./cue-queue";

const MAX_WAITING_CUES = 6;
const MAX_CUE_UNITS = 28;
const ACCELERATION_THRESHOLD = 2;
const MERGE_SEPARATOR_UNITS = 0.5;
const CUE_MINIMUM_DISPLAY_MS = 1_500;
const CUE_ACCELERATED_DISPLAY_MS = 1_000;

const QUEUE_CONSTANTS = {
  maxWaitingCues: MAX_WAITING_CUES,
  maxCueUnits: MAX_CUE_UNITS,
  accelerationThreshold:
    ACCELERATION_THRESHOLD,
  mergeSeparatorUnits:
    MERGE_SEPARATOR_UNITS,
};

interface AppliedDecision {
  acceleratedUntilDrained: boolean;
  droppedCueIds: readonly string[];
}

function makeCues(
  prefix: string,
  count: number,
  units: number = MAX_CUE_UNITS,
): CueQueueEntry[] {
  return Array.from(
    { length: count },
    (_, index): CueQueueEntry => ({
      cueId: `${prefix}:${index}`,
      units,
    }),
  );
}

function applyDecision(
  queue: CueQueueEntry[],
  decision: CueQueueDecision,
): AppliedDecision {
  for (
    const index of decision.mergeIndices
  ) {
    const left = queue[index];
    const right = queue[index + 1];

    if (
      left === undefined ||
      right === undefined
    ) {
      throw new Error(
        "invalid merge decision",
      );
    }

    queue.splice(
      index,
      2,
      {
        cueId:
          `${left.cueId}+${right.cueId}`,
        units:
          left.units +
          MERGE_SEPARATOR_UNITS +
          right.units,
      },
    );
  }

  const dropped = queue.splice(
    0,
    decision.dropCount,
  );

  return {
    acceleratedUntilDrained:
      decision.acceleratedUntilDrained,
    droppedCueIds: dropped.map(
      (cue) => cue.cueId,
    ),
  };
}

function enforceQueue(
  queue: CueQueueEntry[],
  acceleratedUntilDrained: boolean,
): AppliedDecision {
  return applyDecision(
    queue,
    decideCueQueueDiscipline(
      queue,
      acceleratedUntilDrained,
      QUEUE_CONSTANTS,
    ),
  );
}

describe("cue queue discipline", () => {
  it("drains six waiting cues in six seconds", () => {
    const waiting = makeCues("cue", 6);
    const durations: number[] = [];
    let acceleratedUntilDrained = true;

    while (waiting.length > 0) {
      durations.push(
        cueDisplayDurationMs(
          acceleratedUntilDrained,
          CUE_MINIMUM_DISPLAY_MS,
          CUE_ACCELERATED_DISPLAY_MS,
        ),
      );
      waiting.shift();
      acceleratedUntilDrained =
        retainAccelerationUntilDrained(
          acceleratedUntilDrained,
          waiting.length,
        );
    }

    expect(durations).toEqual([
      1_000,
      1_000,
      1_000,
      1_000,
      1_000,
      1_000,
    ]);
    expect(
      durations.reduce(
        (total, duration) =>
          total + duration,
        0,
      ),
    ).toBe(6_000);
    expect(
      acceleratedUntilDrained,
    ).toBe(false);
  });

  it.each([
    {
      length: 1,
      alreadyAccelerated: false,
      expectedAccelerated: false,
      expectedReschedule: false,
    },
    {
      length: 2,
      alreadyAccelerated: false,
      expectedAccelerated: true,
      expectedReschedule: true,
    },
    {
      length: 1,
      alreadyAccelerated: true,
      expectedAccelerated: true,
      expectedReschedule: false,
    },
  ])(
    "resolves predictive acceleration at length $length",
    ({
      length,
      alreadyAccelerated,
      expectedAccelerated,
      expectedReschedule,
    }) => {
      const decision =
        decideCueQueueDiscipline(
          makeCues("cue", length),
          alreadyAccelerated,
          QUEUE_CONSTANTS,
        );

      expect(
        decision.acceleratedUntilDrained,
      ).toBe(expectedAccelerated);
      expect(
        decision.shouldReschedule,
      ).toBe(expectedReschedule);
    },
  );

  it("bounds consecutive bursts and drops the oldest cues", () => {
    const queue: CueQueueEntry[] = [];
    let acceleratedUntilDrained = false;
    let droppedCueCount = 0;
    let maximumRetained = 0;

    for (
      const cue of makeCues("first", 6)
    ) {
      queue.push(cue);

      const applied = enforceQueue(
        queue,
        acceleratedUntilDrained,
      );

      acceleratedUntilDrained =
        applied.acceleratedUntilDrained;
      droppedCueCount +=
        applied.droppedCueIds.length;
      maximumRetained = Math.max(
        maximumRetained,
        queue.length,
      );
    }

    queue.shift();
    acceleratedUntilDrained =
      retainAccelerationUntilDrained(
        acceleratedUntilDrained,
        queue.length,
      );

    for (
      const cue of makeCues("second", 6)
    ) {
      queue.push(cue);

      const applied = enforceQueue(
        queue,
        acceleratedUntilDrained,
      );

      acceleratedUntilDrained =
        applied.acceleratedUntilDrained;
      droppedCueCount +=
        applied.droppedCueIds.length;
      maximumRetained = Math.max(
        maximumRetained,
        queue.length,
      );
    }

    expect(maximumRetained).toBe(6);
    expect(queue).toEqual(
      makeCues("second", 6),
    );
    expect(droppedCueCount).toBe(5);
    expect(
      acceleratedUntilDrained,
    ).toBe(true);
  });

  it("tolerates split siblings that cannot merge", () => {
    const queue: CueQueueEntry[] = [
      {
        cueId: "line:0",
        units: 15,
      },
      {
        cueId: "line:1",
        units: 15,
      },
      ...makeCues("later", 5),
    ];
    const decision =
      decideCueQueueDiscipline(
        queue,
        false,
        QUEUE_CONSTANTS,
      );

    expect(decision.mergeIndices).toEqual(
      [],
    );
    expect(decision.dropCount).toBe(1);

    const applied = applyDecision(
      queue,
      decision,
    );

    expect(applied.droppedCueIds).toEqual([
      "line:0",
    ]);
    expect(queue).toHaveLength(6);
  });

  it.each([
    {
      waitingCueCount: 3,
      expected: true,
    },
    {
      waitingCueCount: 1,
      expected: true,
    },
    {
      waitingCueCount: 0,
      expected: false,
    },
  ])(
    "retains acceleration with $waitingCueCount waiting cues",
    ({
      waitingCueCount,
      expected,
    }) => {
      expect(
        retainAccelerationUntilDrained(
          true,
          waitingCueCount,
        ),
      ).toBe(expected);
    },
  );
});
