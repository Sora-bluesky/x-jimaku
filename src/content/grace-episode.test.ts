import {
  describe,
  expect,
  it,
} from "vitest";
import {
  ContentGraceEpisode,
  GRACE_PERIOD_MS,
  type GraceEpisodeCloseReason,
} from "./grace-episode";

describe("ContentGraceEpisode", () => {
  it("transitions from open through resume", () => {
    const grace =
      new ContentGraceEpisode();
    const opened = grace.open(
      "request-1",
      100,
      "held-tap",
    );

    expect(opened).toEqual({
      requestId: "request-1",
      generation: 1,
      deadlineAt:
        100 + GRACE_PERIOD_MS,
      phase: "open",
      flavor: "held-tap",
    });

    const identity =
      grace.resumeRequested(
        "request-1",
        200,
      );

    expect(identity).toEqual({
      requestId: "request-1",
      generation: 1,
      deadlineAt:
        100 + GRACE_PERIOD_MS,
    });
    expect(
      grace.getCurrent()?.phase,
    ).toBe("resume-requested");

    expect(
      grace.close(
        "resumed",
        identity ?? undefined,
      ),
    ).toEqual({
      episode: {
        ...opened,
        phase: "resume-requested",
      },
      reason: "resumed",
    });
    expect(grace.getCurrent()).toBeNull();
  });

  it("expires at the original deadline", () => {
    const grace =
      new ContentGraceEpisode();
    const opened = grace.open(
      "request-1",
      100,
      "held-tap",
    );

    expect(
      grace.expire(
        opened,
        opened.deadlineAt - 1,
      ),
    ).toBeNull();
    expect(
      grace.isExpired(
        opened.deadlineAt - 1,
      ),
    ).toBe(false);
    expect(
      grace.expire(
        opened,
        opened.deadlineAt,
      ),
    ).toEqual({
      episode: opened,
      reason: "expired",
    });
    expect(grace.getCurrent()).toBeNull();
  });

  it("keeps the deadline on repeated open", () => {
    const grace =
      new ContentGraceEpisode();
    const first = grace.open(
      "request-1",
      100,
      "held-tap",
    );
    const second = grace.open(
      "request-1",
      2_000,
      "held-tap",
    );

    expect(second).toEqual(first);
    expect(second.deadlineAt).toBe(
      100 + GRACE_PERIOD_MS,
    );
    expect(second.generation).toBe(1);
  });

  it("ignores stale full identities", () => {
    const grace =
      new ContentGraceEpisode();
    const stale = grace.open(
      "request-1",
      100,
      "held-tap",
    );

    grace.close(
      "explicit-stop",
      stale,
    );

    const current = grace.open(
      "request-1",
      200,
      "held-tap",
    );

    expect(
      grace.expire(
        stale,
        stale.deadlineAt + 10_000,
      ),
    ).toBeNull();
    expect(
      grace.close(
        "expired",
        stale,
      ),
    ).toBeNull();
    expect(grace.getCurrent()).toEqual(
      current,
    );
  });

  it("closes before a different request", () => {
    const grace =
      new ContentGraceEpisode();
    const opened = grace.open(
      "request-1",
      100,
      "held-tap",
    );

    expect(
      grace.close(
        "different-request",
        opened,
      ),
    ).toEqual({
      episode: opened,
      reason: "different-request",
    });
    expect(grace.getCurrent()).toBeNull();
  });

  it("tracks ended-awaiting-resume", () => {
    const grace =
      new ContentGraceEpisode();

    grace.open(
      "request-1",
      100,
      "held-tap",
    );
    grace.setFlavor(
      "request-1",
      "ended-awaiting-resume",
    );

    expect(grace.getCurrent()).toEqual({
      requestId: "request-1",
      generation: 1,
      deadlineAt:
        100 + GRACE_PERIOD_MS,
      phase: "open",
      flavor:
        "ended-awaiting-resume",
    });

    expect(
      grace.resumeRequested(
        "request-1",
        200,
      ),
    ).not.toBeNull();
  });

  it.each<GraceEpisodeCloseReason>([
    "resumed",
    "expired",
    "explicit-stop",
    "different-request",
    "context-dead",
  ])(
    "records the %s close reason",
    (reason) => {
      const grace =
        new ContentGraceEpisode();
      const opened = grace.open(
        "request-1",
        100,
        "held-tap",
      );

      expect(
        grace.close(
          reason,
          opened,
        )?.reason,
      ).toBe(reason);
      expect(
        grace.getCurrent(),
      ).toBeNull();
    },
  );
});
