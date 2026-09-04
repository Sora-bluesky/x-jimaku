import {
  describe,
  expect,
  it,
} from "vitest";
import {
  stampManifest,
} from "./manifest";

const MANIFEST_SOURCE = JSON.stringify({
  manifest_version: 3,
  name: "x-jimaku",
  version: "0.6.0",
});

function getStampedManifest(
  dirty: boolean,
): {
  manifest_version: number;
  version: string;
  version_name: string;
} {
  return JSON.parse(
    stampManifest(MANIFEST_SOURCE, {
      revision: "abc1234",
      dirty,
      builtAt: new Date(
        "2026-09-02T03:04:05.000Z",
      ),
    }),
  ) as {
    manifest_version: number;
    version: string;
    version_name: string;
  };
}

describe("stampManifest", () => {
  it(
    "writes the commit into version_name",
    () => {
      const manifest =
        getStampedManifest(false);

      expect(manifest).toMatchObject({
        manifest_version: 3,
        version: "0.6.0",
        version_name:
          "0.6.0 abc1234 2026-09-02T03:04:05Z",
      });
    },
  );

  it(
    "marks a dirty working tree in version_name",
    () => {
      expect(
        getStampedManifest(true).version_name,
      ).toBe(
        "0.6.0 abc1234-dirty 2026-09-02T03:04:05Z",
      );
    },
  );
});
