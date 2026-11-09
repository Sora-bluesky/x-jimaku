import { describe, expect, it } from "vitest";
import { cueQueueObservations } from "./cue-queue-observations.mjs";

describe("cue queue observations", () => {
  it("uses run-wide samples rather than only the pages eligible for quality gates", () => {
    const samples = [99, ...Array.from({ length: 10 }, (_, i) => i)].map((waitingCues, i) =>
      ({ sampledAtMs: i === 0 ? 0 : 1000 + i, waitingCues }));
    const events = [{ sampledAtMs: 900, waitingCues: 99, cueDrops: 10, cueMerges: 10 },
      { sampledAtMs: 1100, waitingCues: 3, cueDrops: 2, cueMerges: 3 },
      { sampledAtMs: 1200, waitingCues: 12, cueDrops: 2, cueMerges: 4 }];
    const result = cueQueueObservations({ samples, events, drops: [{}, {}], replayStartedAtMs: 1000 });
    expect(result.cueQueue).toMatchObject({ samples: 10, maxWaitingCues: 12, p90WaitingCues: 9, waitingAtStop: 12 });
    expect(result.cueQueue.timeline[0]).toEqual({ sampledAtMs: 1001, waitingCues: 0 });
    expect(result.cueDrops).toBe(2);
    expect(result.cueMerges).toBe(4);
  });

  it("distinguishes missing observation from an observed empty queue", () => {
    expect(cueQueueObservations({ replayStartedAtMs: 0 })).toMatchObject({
      cueQueue: { samples: 0, maxWaitingCues: null, p90WaitingCues: null, waitingAtStop: null }, cueDrops: null, cueMerges: null,
    });
    expect(cueQueueObservations({ samples: [{ sampledAtMs: 1, waitingCues: 0 }], drops: [], replayStartedAtMs: 0 }))
      .toMatchObject({ cueQueue: { maxWaitingCues: 0, p90WaitingCues: 0, waitingAtStop: 0 }, cueDrops: 0, cueMerges: 0 });
  });

  it("uses cumulative queue drops when the stored log has reached its cap", () => {
    const events = [
      { sampledAtMs: 999, waitingCues: 0, cueDrops: 999, cueMerges: 0 },
      { sampledAtMs: 1000, waitingCues: 6, cueDrops: 405, cueMerges: 0 },
      { sampledAtMs: 1001, waitingCues: 0, cueDrops: 400, cueMerges: 0 },
    ];
    expect(cueQueueObservations({ events, drops: Array.from({ length: 400 }, () => ({})),
      replayStartedAtMs: 1000 }).cueDrops).toBe(405);
    expect(cueQueueObservations({ events, replayStartedAtMs: 1000 }).cueDrops).toBe(405);
  });

  it("preserves the stored drop count when it is larger or queue events are absent", () => {
    const drops = [{}, {}, {}];
    expect(cueQueueObservations({ drops, events: [
      { sampledAtMs: 1000, waitingCues: 0, cueDrops: 2, cueMerges: 0 },
    ], replayStartedAtMs: 1000 }).cueDrops).toBe(3);
    expect(cueQueueObservations({ drops, replayStartedAtMs: 1000 }).cueDrops).toBe(3);
  });

  it.each([
    { samples: [{ sampledAtMs: 1100, waitingCues: 1 }], events: [{ sampledAtMs: 1200, waitingCues: 0, cueDiscards: 1 }], expected: 1 },
    { samples: [{ sampledAtMs: 1100, waitingCues: 1 }], events: [{ sampledAtMs: 1200, waitingCues: 0, cueDiscards: 0 }], expected: 0 },
    { samples: [{ sampledAtMs: 1200, waitingCues: 0 }], events: [{ sampledAtMs: 1100, waitingCues: 4 }], expected: 0 },
    { samples: [{ sampledAtMs: 1200, waitingCues: 3 }, { sampledAtMs: 1100, waitingCues: 5 }], expected: 3 },
    { events: [{ sampledAtMs: 1200, waitingCues: 2 }, { sampledAtMs: 1100, waitingCues: 5 }], expected: 2 },
  ])("walks samples and events in time order for waitingAtStop: %j", ({ expected, ...data }) => {
    expect(cueQueueObservations({ ...data, replayStartedAtMs: 1000 }).cueQueue.waitingAtStop).toBe(expected);
  });

  it("reports cues queued after the last sample and discarded at disposal", () => {
    const result = cueQueueObservations({
      replayStartedAtMs: 1000,
      samples: [{ sampledAtMs: 1000, waitingCues: 0 }],
      events: [
        { sampledAtMs: 1100, waitingCues: 6, cueDrops: 0, cueMerges: 0, cueDiscards: 0 },
        { sampledAtMs: 1200, waitingCues: 0, cueDrops: 0, cueMerges: 0, cueDiscards: 6 },
        { sampledAtMs: 1210, waitingCues: 0, cueDrops: 0, cueMerges: 0, cueDiscards: 6 },
      ],
    });
    expect(result.cueQueue.waitingAtStop).toBe(6);
    expect(result.cueDiscards).toBe(6);
  });

  it("reports no final queue observation for pre-run or invalid rows", () => {
    expect(cueQueueObservations({
      samples: [{ sampledAtMs: 999, waitingCues: 5 }, { sampledAtMs: 1100, waitingCues: NaN }],
      events: [{ sampledAtMs: 1200 }, { sampledAtMs: NaN, waitingCues: 2 }],
      replayStartedAtMs: 1000,
    }).cueQueue.waitingAtStop).toBeNull();
  });
});
