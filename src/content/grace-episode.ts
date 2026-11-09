export const GRACE_PERIOD_MS = 3_000;

export type GraceEpisodePhase =
  | "open"
  | "resume-requested";

export type GraceEpisodeFlavor =
  | "held-tap"
  | "ended-awaiting-resume";

export type GraceEpisodeCloseReason =
  | "resumed"
  | "expired"
  | "explicit-stop"
  | "different-request"
  | "context-dead";

export interface GraceEpisodeIdentity {
  requestId: string;
  generation: number;
  deadlineAt: number;
}

export interface GraceEpisodeSnapshot
  extends GraceEpisodeIdentity {
  phase: GraceEpisodePhase;
  flavor: GraceEpisodeFlavor;
}

export interface GraceEpisodeTransition {
  episode: GraceEpisodeSnapshot;
  reason: GraceEpisodeCloseReason;
}

export class ContentGraceEpisode {
  private current:
    | GraceEpisodeSnapshot
    | null = null;

  private nextGeneration = 1;

  getCurrent():
    | GraceEpisodeSnapshot
    | null {
    return this.current === null
      ? null
      : {
          ...this.current,
        };
  }

  open(
    requestId: string,
    now: number,
    flavor: GraceEpisodeFlavor,
  ): GraceEpisodeSnapshot {
    if (this.current !== null) {
      return {
        ...this.current,
      };
    }

    this.current = {
      requestId,
      generation: this.nextGeneration,
      deadlineAt: now + GRACE_PERIOD_MS,
      phase: "open",
      flavor,
    };

    this.nextGeneration += 1;

    return {
      ...this.current,
    };
  }

  resumeRequested(
    requestId: string,
    now: number,
  ): GraceEpisodeIdentity | null {
    if (
      this.current === null ||
      this.current.requestId !== requestId ||
      now >= this.current.deadlineAt
    ) {
      return null;
    }

    this.current = {
      ...this.current,
      phase: "resume-requested",
    };

    return toIdentity(this.current);
  }

  setFlavor(
    requestId: string,
    flavor: GraceEpisodeFlavor,
  ): GraceEpisodeSnapshot | null {
    if (
      this.current === null ||
      this.current.requestId !== requestId
    ) {
      return null;
    }

    this.current = {
      ...this.current,
      flavor,
    };

    return {
      ...this.current,
    };
  }

  isExpired(now: number): boolean {
    return (
      this.current !== null &&
      now >= this.current.deadlineAt
    );
  }

  matches(
    identity: GraceEpisodeIdentity,
  ): boolean {
    return (
      this.current !== null &&
      sameIdentity(
        this.current,
        identity,
      )
    );
  }

  expire(
    identity: GraceEpisodeIdentity,
    now: number,
  ): GraceEpisodeTransition | null {
    if (
      !this.matches(identity) ||
      this.current === null ||
      now < this.current.deadlineAt
    ) {
      return null;
    }

    return this.close(
      "expired",
      identity,
    );
  }

  close(
    reason: GraceEpisodeCloseReason,
    identity?: GraceEpisodeIdentity,
  ): GraceEpisodeTransition | null {
    if (
      this.current === null ||
      (
        identity !== undefined &&
        !sameIdentity(
          this.current,
          identity,
        )
      )
    ) {
      return null;
    }

    const transition: GraceEpisodeTransition = {
      episode: {
        ...this.current,
      },
      reason,
    };

    this.current = null;

    return transition;
  }
}

function toIdentity(
  episode: GraceEpisodeSnapshot,
): GraceEpisodeIdentity {
  return {
    requestId: episode.requestId,
    generation: episode.generation,
    deadlineAt: episode.deadlineAt,
  };
}

function sameIdentity(
  left: GraceEpisodeIdentity,
  right: GraceEpisodeIdentity,
): boolean {
  return (
    left.requestId === right.requestId &&
    left.generation === right.generation &&
    left.deadlineAt === right.deadlineAt
  );
}
