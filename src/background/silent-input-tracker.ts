export const SILENT_INPUT_RMS_THRESHOLD =
  0.001;
export const SILENT_INPUT_HINT_DELAY_MS =
  10_000;
export const SILENT_INPUT_LEVEL_STALE_MS =
  2_000;

interface SilentInputObservation {
  requestId: string;
  quietStartedAtMs: number;
  lastLevelAtMs: number;
}

export class SilentInputTracker {
  private observation:
    | SilentInputObservation
    | null = null;
  private hintActive = false;
  private timerId:
    | ReturnType<typeof globalThis.setTimeout>
    | null = null;

  constructor(
    private readonly onHintChange: (
      showHint: boolean,
    ) => void,
  ) {
  }

  isHintActive(): boolean {
    return this.hintActive;
  }

  acceptLevel(
    requestId: string,
    rms: number,
  ): void {
    if (
      rms >= SILENT_INPUT_RMS_THRESHOLD
    ) {
      this.reset();
      return;
    }

    const now = Date.now();
    const current = this.observation;
    const continuesObservation =
      current !== null &&
      current.requestId === requestId &&
      now - current.lastLevelAtMs <
        SILENT_INPUT_LEVEL_STALE_MS;

    this.observation = {
      requestId,
      quietStartedAtMs:
        continuesObservation
          ? current.quietStartedAtMs
          : now,
      lastLevelAtMs: now,
    };

    if (!continuesObservation) {
      this.setHintActive(false);
    }

    this.scheduleCheck();
  }

  mediaChanged(requestId: string): void {
    if (
      this.observation?.requestId !==
      requestId
    ) {
      return;
    }

    this.reset();
  }

  reset(): void {
    this.clearTimer();
    this.observation = null;
    this.setHintActive(false);
  }

  private scheduleCheck(): void {
    this.clearTimer();

    const observation = this.observation;

    if (observation === null) {
      return;
    }

    const hintAtMs = this.hintActive
      ? Number.POSITIVE_INFINITY
      : observation.quietStartedAtMs +
        SILENT_INPUT_HINT_DELAY_MS;
    const staleAtMs =
      observation.lastLevelAtMs +
      SILENT_INPUT_LEVEL_STALE_MS;
    const delayMs = Math.max(
      0,
      Math.min(hintAtMs, staleAtMs) -
        Date.now(),
    );

    this.timerId = globalThis.setTimeout(
      () => {
        this.timerId = null;
        this.checkObservation(observation);
      },
      delayMs,
    );
  }

  private checkObservation(
    observation: SilentInputObservation,
  ): void {
    if (this.observation !== observation) {
      return;
    }

    const now = Date.now();

    if (
      now - observation.lastLevelAtMs >=
      SILENT_INPUT_LEVEL_STALE_MS
    ) {
      this.reset();
      return;
    }

    if (
      now - observation.quietStartedAtMs >=
      SILENT_INPUT_HINT_DELAY_MS
    ) {
      this.setHintActive(true);
    }

    this.scheduleCheck();
  }

  private setHintActive(
    showHint: boolean,
  ): void {
    if (this.hintActive === showHint) {
      return;
    }

    this.hintActive = showHint;
    this.onHintChange(showHint);
  }

  private clearTimer(): void {
    if (this.timerId === null) {
      return;
    }

    globalThis.clearTimeout(this.timerId);
    this.timerId = null;
  }
}
