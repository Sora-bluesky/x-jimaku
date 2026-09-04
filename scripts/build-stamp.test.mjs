import { describe, expect, it } from "vitest";
import {
  checkProvenance,
  describeBuild,
} from "./build-stamp.mjs";

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

describe("checkProvenance", () => {
  const clean = {
    version: "0.7.0",
    revision: "dad9fca",
    dirty: false,
    builtAt: "2026-09-04T04:15:19Z",
  };
  const matching = {
    manifestVersion: "0.7.0",
    headRevision: "dad9fca",
    allowDirty: false,
  };

  it("passes a build that matches the checkout", () => {
    expect(checkProvenance(clean, matching)).toBeNull();
  });

  it("refuses a build made from an uncommitted tree", () => {
    expect(
      checkProvenance({ ...clean, dirty: true }, matching),
    ).toMatch(/uncommitted/u);
  });

  it("lets --allow-dirty through", () => {
    expect(
      checkProvenance(
        { ...clean, dirty: true },
        { ...matching, allowDirty: true },
      ),
    ).toBeNull();
  });

  it("refuses a build made before the version was raised", () => {
    // dist/ is gitignored, so a 0.6.0 build survives the bump. Packaging it
    // produces x-jimaku-0.6.0.zip from a tree that says 0.7.0, and every
    // check downstream agrees with the archive.
    expect(
      checkProvenance(
        { ...clean, version: "0.6.0" },
        matching,
      ),
    ).toMatch(/0\.6\.0/u);
  });

  it("refuses a build left over from another commit", () => {
    // A clean build outlives a checkout or a pull. Nothing about it looks
    // stale: the -dirty marker is absent and the version still matches.
    expect(
      checkProvenance(clean, {
        ...matching,
        headRevision: "cfbcf4f",
      }),
    ).toMatch(/HEAD is cfbcf4f/u);
  });

  it("refuses when the commit cannot be read", () => {
    // Not knowing is not the same as matching. A release artifact that
    // cannot be traced to a commit is the thing this exists to prevent.
    expect(
      checkProvenance(clean, {
        ...matching,
        headRevision: null,
      }),
    ).toMatch(/git checkout/u);
  });
});
