import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  getActionClickDisposition,
  isCaptureRequestActiveOrDraining,
  isRecognitionRequestCurrent,
  presentCaptionIfAllowed,
} from "./explicit-stop-drain";
import {
  isM1Message,
} from "./messages";
import {
  createCaptureState,
} from "./state";

describe("explicit-stop action handling", () => {
  it("keeps clicks during stopping ignored", () => {
    expect(
      getActionClickDisposition(
        "stopping",
      ),
    ).toBe("ignore");
    expect(
      getActionClickDisposition("running"),
    ).toBe("stop");
  });
});

describe("draining request separation", () => {
  it("does not treat an old draining request as the new current capture", () => {
    expect(
      isCaptureRequestActiveOrDraining(
        "stopping",
        "capture:new",
        "capture:old",
        "capture:old",
      ),
    ).toBe(false);

    expect(
      isCaptureRequestActiveOrDraining(
        "stopping",
        "capture:old",
        "capture:old",
        "capture:old",
      ),
    ).toBe(true);

    expect(
      isCaptureRequestActiveOrDraining(
        "running",
        "capture:new",
        null,
        "capture:new",
      ),
    ).toBe(true);
  });

  it("accepts legacy OFF_RECOG without requestId but rejects a known stale id", () => {
    expect(
      isRecognitionRequestCurrent(
        undefined,
        "capture:new",
      ),
    ).toBe(true);
    expect(
      isRecognitionRequestCurrent(
        "capture:old",
        "capture:new",
      ),
    ).toBe(false);
  });
});

describe("late-caption presentation gate", () => {
  it("does not invoke presentation after stop, so ensureOverlay cannot resurrect", () => {
    const present = vi.fn();

    expect(
      presentCaptionIfAllowed(
        "idle",
        null,
        present,
      ),
    ).toBe(false);
    expect(
      presentCaptionIfAllowed(
        "stopping",
        null,
        present,
      ),
    ).toBe(false);
    expect(present).not.toHaveBeenCalled();
  });

  it("allows the draining request while stopping", () => {
    const present = vi.fn();

    expect(
      presentCaptionIfAllowed(
        "stopping",
        "capture:old",
        present,
      ),
    ).toBe(true);
    expect(present).toHaveBeenCalledOnce();
  });
});

describe("drain message compatibility", () => {
  it("accepts missing drain flags and rejects malformed flags", () => {
    expect(
      isM1Message({
        t: "OFF_STOP",
        requestId: "capture:1",
      }),
    ).toBe(true);
    expect(
      isM1Message({
        t: "OFF_STOP",
        requestId: "capture:1",
        drain: "yes",
      }),
    ).toBe(false);

    expect(
      isM1Message({
        t: "OFF_STATE",
        state:
          createCaptureState(
            "stopping",
            {
              requestId: "capture:1",
            },
          ),
      }),
    ).toBe(true);
    expect(
      isM1Message({
        t: "OFF_STATE",
        state:
          createCaptureState(
            "stopping",
            {
              requestId: "capture:1",
            },
          ),
        drain: 1,
      }),
    ).toBe(false);
  });

  it("keeps legacy OFF_RECOG messages type-compatible", () => {
    expect(
      isM1Message({
        t: "OFF_RECOG",
        id: 1,
        text: "legacy",
        final: true,
        at: "2026-08-30T00:00:00.000Z",
      }),
    ).toBe(true);
  });
});
