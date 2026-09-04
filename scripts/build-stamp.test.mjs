import { describe, expect, it } from "vitest";
import {
  checkProvenance,
  describeBuild,
  missingOnnxAssets,
  missingReferences,
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

describe("missingReferences", () => {
  const manifest = {
    background: { service_worker: "background.js" },
    options_page: "options.html",
    content_scripts: [{ js: ["content.js"] }],
    web_accessible_resources: [
      { resources: ["ort/*", "pcm-worklet.js"] },
    ],
  };
  const complete = [
    "manifest.json",
    "background.js",
    "content.js",
    "options.html",
    "pcm-worklet.js",
    "ort/ort.mjs",
  ];

  it("is empty when the build finished", () => {
    expect(missingReferences(manifest, complete)).toEqual([]);
  });

  it("catches a second build pass that died", () => {
    // The first vite pass empties dist/ and writes the stamped manifest; the
    // second emits the content script. When the second fails, dist/ holds a
    // manifest naming a content.js nobody wrote, and the extension installs
    // and then does nothing on the page.
    expect(
      missingReferences(
        manifest,
        complete.filter((file) => file !== "content.js"),
      ),
    ).toEqual(["content.js"]);
  });

  it("treats a wildcard as satisfied by any one file", () => {
    expect(
      missingReferences(
        manifest,
        complete.filter((file) => !file.startsWith("ort/")),
      ),
    ).toEqual(["ort/*"]);
    expect(
      missingReferences(manifest, [
        ...complete,
        "ort/nested/deep.wasm",
      ]),
    ).toEqual([]);
  });

  it("ignores entries the manifest does not have", () => {
    expect(missingReferences({}, [])).toEqual([]);
  });
});

describe("missingOnnxAssets", () => {
  const source = [
    "ort.mjs",
    "ort-wasm-simd-threaded.wasm",
    "ort.all.min.mjs",
    "README.md",
    "types",
  ];

  it("is empty when every runtime file was copied", () => {
    expect(
      missingOnnxAssets(source, [
        "manifest.json",
        "ort/ort.mjs",
        "ort/ort-wasm-simd-threaded.wasm",
        "ort/ort.all.min.mjs",
      ]),
    ).toEqual([]);
  });

  it("catches a copy that stopped partway", () => {
    // The manifest asks for ort/*, and one file satisfies a wildcard, so a
    // half-finished copy reads as complete. The archive then installs and
    // recognition cannot start.
    expect(
      missingOnnxAssets(source, ["ort/ort.mjs"]),
    ).toEqual([
      "ort/ort-wasm-simd-threaded.wasm",
      "ort/ort.all.min.mjs",
    ]);
  });

  it("ignores what the build does not copy", () => {
    // copyOnnxRuntimeAssets takes only .wasm and .mjs, so a README next to
    // them must not be demanded of dist/.
    expect(
      missingOnnxAssets(["README.md", "types"], []),
    ).toEqual([]);
  });
});
