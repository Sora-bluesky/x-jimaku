import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  SILENT_INPUT_HINT_DELAY_MS,
  SILENT_INPUT_LEVEL_STALE_MS,
  SILENT_INPUT_RMS_THRESHOLD,
  SilentInputTracker,
} from "./silent-input-tracker";

const REQUEST_ID = "request-1";
const FRESH_SAMPLE_INTERVAL_MS = 1_000;

function createTracker(): {
  tracker: SilentInputTracker;
  isHintVisible(): boolean;
} {
  let showHint = false;
  const tracker = new SilentInputTracker(
    (nextShowHint) => {
      showHint = nextShowHint;
    },
  );

  return {
    tracker,
    isHintVisible: () => showHint,
  };
}

function keepQuietLevelFresh(
  tracker: SilentInputTracker,
  durationMs: number,
): void {
  tracker.acceptLevel(REQUEST_ID, 0);

  for (
    let elapsedMs =
      FRESH_SAMPLE_INTERVAL_MS;
    elapsedMs <= durationMs;
    elapsedMs += FRESH_SAMPLE_INTERVAL_MS
  ) {
    vi.advanceTimersByTime(
      FRESH_SAMPLE_INTERVAL_MS,
    );
    tracker.acceptLevel(REQUEST_ID, 0);
  }
}

describe("SilentInputTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it(
    "arms after ten seconds of fresh samples below the threshold",
    () => {
      const {
        tracker,
        isHintVisible,
      } = createTracker();

      keepQuietLevelFresh(
        tracker,
        SILENT_INPUT_HINT_DELAY_MS,
      );

      expect(isHintVisible()).toBe(true);
    },
  );

  it(
    "does not arm when level samples stop before ten seconds",
    () => {
      const {
        tracker,
        isHintVisible,
      } = createTracker();

      tracker.acceptLevel(REQUEST_ID, 0);
      vi.advanceTimersByTime(
        FRESH_SAMPLE_INTERVAL_MS,
      );
      tracker.acceptLevel(REQUEST_ID, 0);
      vi.advanceTimersByTime(
        SILENT_INPUT_HINT_DELAY_MS,
      );

      expect(isHintVisible()).toBe(false);
    },
  );

  it(
    "withdraws an active hint when the level stream becomes stale",
    () => {
      const {
        tracker,
        isHintVisible,
      } = createTracker();

      keepQuietLevelFresh(
        tracker,
        SILENT_INPUT_HINT_DELAY_MS,
      );
      expect(isHintVisible()).toBe(true);

      vi.advanceTimersByTime(
        SILENT_INPUT_LEVEL_STALE_MS,
      );

      expect(isHintVisible()).toBe(false);
    },
  );

  it(
    "clears an active hint for a sample at the threshold",
    () => {
      const {
        tracker,
        isHintVisible,
      } = createTracker();

      keepQuietLevelFresh(
        tracker,
        SILENT_INPUT_HINT_DELAY_MS,
      );

      tracker.acceptLevel(
        REQUEST_ID,
        SILENT_INPUT_RMS_THRESHOLD,
      );

      expect(isHintVisible()).toBe(false);
    },
  );

  it(
    "restarts the ten-second quiet window after a seek",
    () => {
      const {
        tracker,
        isHintVisible,
      } = createTracker();

      keepQuietLevelFresh(tracker, 9_000);
      tracker.mediaChanged(REQUEST_ID);
      keepQuietLevelFresh(tracker, 9_000);

      expect(isHintVisible()).toBe(false);

      vi.advanceTimersByTime(
        FRESH_SAMPLE_INTERVAL_MS,
      );

      expect(isHintVisible()).toBe(true);
    },
  );
});
