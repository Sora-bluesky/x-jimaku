import { describe, expect, it } from "vitest";
import { describeBuild } from "./build-stamp.mjs";

describe("describeBuild", () => {
  it("reads a clean build", () => {
    expect(
      describeBuild("0.7.0 dad9fca 2026-09-04T04:15:19Z"),
    ).toEqual({
      version: "0.7.0",
      revision: "dad9fca",
      dirty: false,
      builtAt: "2026-09-04T04:15:19Z",
    });
  });

  it("separates the dirty marker from the commit", () => {
    // The marker sits against the commit with no space, so a reader that
    // splits on whitespace hands back `dad9fca-dirty` as the revision and
    // reports every build as clean.
    expect(
      describeBuild("0.7.0 dad9fca-dirty 2026-09-04T04:15:19Z"),
    ).toEqual({
      version: "0.7.0",
      revision: "dad9fca",
      dirty: true,
      builtAt: "2026-09-04T04:15:19Z",
    });
  });

  it("returns nothing for a manifest with no stamp", () => {
    // An unstamped manifest means the build did not run to the end. Guessing
    // a value here would let the zip builder wave it through.
    expect(describeBuild(undefined)).toBeNull();
    expect(describeBuild("0.7.0")).toBeNull();
  });
});
