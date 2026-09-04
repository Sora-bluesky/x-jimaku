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
import {
  isChromeVersion,
} from "./manifest";

// The extension stores its version in four places and only one of them is
// real: the store and the browser read public/manifest.json, and nothing reads
// the rest. That asymmetry is what let them drift — package.json sat at 1.0.0
// while three releases shipped from a manifest in the 0.x range, and nothing
// anywhere noticed. The lockfile carries two more copies, which the first
// version of this test missed; a review caught that, and the shape of the miss
// is why the list below is a list rather than a pair.
//
// Reading the files off disk is the point: a constant compared against a
// constant would pass on the day someone bumps one file and forgets the rest.
const here = path.dirname(
  fileURLToPath(import.meta.url),
);
const root = path.resolve(here, "../..");

function readJson(
  relativePath: string,
): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    readFileSync(
      path.join(root, relativePath),
      "utf8",
    ),
  );

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error(
      `${relativePath} is not an object`,
    );
  }

  return parsed as Record<string, unknown>;
}

function readVersion(
  relativePath: string,
): unknown {
  const parsed = readJson(relativePath);

  if (!("version" in parsed)) {
    throw new Error(
      `${relativePath} has no version`,
    );
  }

  return parsed.version;
}

function readLockVersions(): {
  top: unknown;
  root: unknown;
} {
  const lock = readJson("package-lock.json");
  const packages = lock.packages;

  if (
    typeof packages !== "object" ||
    packages === null
  ) {
    throw new Error(
      "package-lock.json has no packages",
    );
  }

  const rootEntry = (
    packages as Record<string, unknown>
  )[""];

  if (
    typeof rootEntry !== "object" ||
    rootEntry === null
  ) {
    throw new Error(
      "package-lock.json has no root package",
    );
  }

  return {
    top: lock.version,
    root: (
      rootEntry as Record<string, unknown>
    ).version,
  };
}

describe("release version", () => {
  it(
    "is the same everywhere it is written down",
    () => {
      const manifest = readVersion(
        "public/manifest.json",
      );
      const lock = readLockVersions();

      expect({
        package: readVersion("package.json"),
        lockTop: lock.top,
        lockRoot: lock.root,
      }).toEqual({
        package: manifest,
        lockTop: manifest,
        lockRoot: manifest,
      });
    },
  );

  it("is a version Chrome will accept", () => {
    // Chrome rejects a bad version after the zip has been built and uploaded.
    // A pattern of three integers is not the rule it applies: 0.07.0 and
    // 999999.0.0 both match that and both are rejected. isChromeVersion is
    // the same check the build runs before it stamps anything.
    expect(
      isChromeVersion(
        readVersion("public/manifest.json"),
      ),
    ).toBe(true);
  });
});
