import { describe, expect, it } from "vitest";
import {
  CUE_ACCELERATED_DISPLAY_MS,
  CUE_MINIMUM_DISPLAY_MS,
} from "../shared/explicit-stop-drain";
import { cueDwellMs, DEFAULT_CUE_DWELL_POLICY, readCueDwellPolicy } from "./cue-dwell";

describe("cue dwell", () => {
  it.each([false, true])("preserves flat defaults (accelerated=%s)", accelerated => {
    for (const length of [0, 10, 35, 1000]) {
      expect(cueDwellMs(["字".repeat(length), ""], accelerated)).toBe(
        accelerated ? CUE_ACCELERATED_DISPLAY_MS : CUE_MINIMUM_DISPLAY_MS,
      );
    }
  });

  const policy = { dwellFloorMs: 1500, dwellRate: 4, dwellAccelFloorMs: 1000, dwellAccelRate: 7 };
  it.each([false, true])("uses the floor or length/rate (accelerated=%s)", accelerated => {
    expect(cueDwellMs(["字", ""], accelerated, policy)).toBe(accelerated ? 1000 : 1500);
    const long = cueDwellMs(["字".repeat(35), ""], accelerated, policy);
    expect(long).toBe(accelerated ? 5000 : 8750);
    expect(long).toBeGreaterThan(cueDwellMs(["字".repeat(10), ""], accelerated, policy));
  });

  it("counts Unicode code points and spaces exactly as the bench does", () => {
    const lines = ["字 😀 e\u0301", "字幕"] as const;
    expect(cueDwellMs(lines, false, { ...policy, dwellFloorMs: 0, dwellRate: 1 }))
      .toBe(8000);
  });

  it("accepts zero rates to disable length-based dwell", () => {
    expect(readCueDwellPolicy(DEFAULT_CUE_DWELL_POLICY)).toEqual(DEFAULT_CUE_DWELL_POLICY);
  });

  it.each([null, {}, { ...policy, dwellRate: -1 }, { ...policy, dwellFloorMs: NaN },
    { ...policy, dwellAccelRate: Infinity }, { ...policy, dwellAccelFloorMs: "1000" }])(
    "rejects incomplete or invalid policies: %j", value => {
      expect(readCueDwellPolicy(value)).toBeNull();
    },
  );
});
