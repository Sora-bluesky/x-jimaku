import {
  readFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  describe,
  expect,
  it,
} from "vitest";

// The extension has two version fields and only one of them is real: the store
// and the browser read public/manifest.json, and package.json is read by
// nobody. That asymmetry is what let them drift — package.json sat at 1.0.0
// while three releases shipped from a manifest in the 0.x range, and nothing
// anywhere noticed. Reading both files off disk is the point of this test: a
// constant compared against a constant would pass on the day someone bumps one
// file and forgets the other.
const here = path.dirname(
  fileURLToPath(import.meta.url),
);
const root = path.resolve(here, "../..");

function readVersion(
  relativePath: string,
): unknown {
  const parsed: unknown = JSON.parse(
    readFileSync(
      path.join(root, relativePath),
      "utf8",
    ),
  );

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("version" in parsed)
  ) {
    throw new Error(
      `${relativePath} has no version`,
    );
  }

  return parsed.version;
}

describe("release version", () => {
  it(
    "is the same in package.json " +
      "and the extension manifest",
    () => {
      expect(
        readVersion("package.json"),
      ).toBe(
        readVersion(
          "public/manifest.json",
        ),
      );
    },
  );

  it("is a plain three-part number", () => {
    // Chrome rejects an upload whose version is not one to four dot-separated
    // integers, and it rejects it after the zip is built and uploaded. Cheaper
    // to find out here.
    expect(
      readVersion("public/manifest.json"),
    ).toMatch(/^\d+\.\d+\.\d+$/u);
  });
});
