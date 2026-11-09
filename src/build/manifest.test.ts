import {
  describe,
  expect,
  it,
} from "vitest";
import {
  formatBuildInfo,
  formatVersionName,
  isChromeVersion,
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

describe("formatBuildInfo", () => {
  it.each([false, true])(
    "round-trips the manifest stamp with dirty=%s",
    (dirty) => {
      const stamp = {
        revision: "abc1234",
        dirty,
        builtAt: new Date("2026-09-02T03:04:05.123Z"),
      };
      const info = formatBuildInfo(stamp, "0.6.0", "a".repeat(64));
      expect(JSON.parse(JSON.stringify(info))).toEqual(info);
      expect(info).toEqual({
        revision: "abc1234",
        dirty,
        builtAt: "2026-09-02T03:04:05Z",
        versionName: formatVersionName("0.6.0", stamp),
        nameTableHash: "a".repeat(64),
      });
      expect(info.versionName).toBe(
        JSON.parse(stampManifest(MANIFEST_SOURCE, stamp)).version_name,
      );
      expect(info.versionName.endsWith(` ${info.builtAt}`)).toBe(true);
    },
  );
});

describe("stampManifest", () => {
  it(
    "uses formatVersionName for version_name",
    () => {
      const manifest = JSON.parse(
        MANIFEST_SOURCE,
      ) as {
        version: string;
      };
      const stamp = {
        revision: "abc1234",
        dirty: false,
        builtAt: new Date(
          "2026-09-02T03:04:05.000Z",
        ),
      };
      const stamped = JSON.parse(
        stampManifest(
          MANIFEST_SOURCE,
          stamp,
        ),
      ) as {
        version_name: string;
      };

      expect(stamped.version_name).toBe(
        formatVersionName(
          manifest.version,
          stamp,
        ),
      );
    },
  );

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

describe("isChromeVersion", () => {
  it("accepts what Chrome accepts", () => {
    expect(isChromeVersion("0.7.0")).toBe(true);
    expect(isChromeVersion("1.2.3.4")).toBe(true);
    expect(isChromeVersion("0.0.65535")).toBe(true);
    // Chrome's own example of a valid all-but-one-zero version.
    expect(isChromeVersion("0.1.0.0")).toBe(true);
  });

  it("rejects a version that is all zeros", () => {
    // Chrome names 0 and 0.0.0.0 as invalid. The first version of this check
    // accepted both, and the test written with it said "0" was fine, so the
    // mistake had a passing test defending it.
    expect(isChromeVersion("0")).toBe(false);
    expect(isChromeVersion("0.0")).toBe(false);
    expect(isChromeVersion("0.0.0.0")).toBe(false);
  });

  it("rejects a leading zero on a non-zero part", () => {
    // 0.07.0 matches a three-integer pattern and is rejected at upload, which
    // is the point where finding out costs the most.
    expect(isChromeVersion("0.07.0")).toBe(false);
  });

  it("rejects a part above 65535", () => {
    expect(isChromeVersion("999999.0.0")).toBe(false);
    expect(isChromeVersion("0.65536.0")).toBe(false);
  });

  it("rejects shapes that are not versions", () => {
    expect(isChromeVersion("1.2.3.4.5")).toBe(false);
    expect(isChromeVersion("1.2.-3")).toBe(false);
    expect(isChromeVersion("1.2.x")).toBe(false);
    expect(isChromeVersion("")).toBe(false);
    expect(isChromeVersion(7)).toBe(false);
  });
});

describe("stampManifest version guard", () => {
  it("refuses to stamp a version Chrome rejects", () => {
    // The build is the last place this costs nothing. After it, the version
    // is inside a zip on its way to the store.
    expect(() =>
      stampManifest(
        JSON.stringify({
          manifest_version: 3,
          name: "x-jimaku",
          version: "0.07.0",
        }),
        {
          revision: "abc1234",
          dirty: false,
          builtAt: new Date(
            "2026-09-02T03:04:05.000Z",
          ),
        },
      ),
    ).toThrow(/65535/u);
  });
});
