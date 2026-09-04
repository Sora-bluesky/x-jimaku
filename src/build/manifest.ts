export interface BuildStamp {
  readonly revision: string;
  readonly dirty: boolean;
  readonly builtAt: Date;
}

/**
 * Whether Chrome will accept this as a manifest version.
 *
 * One to four dot-separated integers, each 0 to 65535, a non-zero part may not
 * have a leading zero, and they may not all be zero: Chrome's documentation
 * gives 0 and 0.0.0.0 as invalid and 0.1.0.0 as valid. It applies the rules at
 * upload, after the archive has been built and sent, so they are checked here
 * instead and the build refuses to stamp a manifest the store would reject.
 *
 * A loose `\d+\.\d+\.\d+` accepts both 0.07.0 and 999999.0.0. The first
 * version of this function then accepted "0", and its test said so out loud,
 * which is the more useful lesson: a rule written from memory takes its test
 * with it.
 */
export function isChromeVersion(
  value: unknown,
): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const parts = value.split(".");

  if (
    parts.length < 1 ||
    parts.length > 4
  ) {
    return false;
  }

  const shaped = parts.every((part) => {
    if (!/^\d+$/u.test(part)) {
      return false;
    }

    if (
      part.length > 1 &&
      part.startsWith("0")
    ) {
      return false;
    }

    return Number(part) <= 65535;
  });

  return (
    shaped &&
    parts.some((part) => Number(part) > 0)
  );
}

export function stampManifest(
  source: string,
  stamp: BuildStamp,
): string {
  const manifest: unknown =
    JSON.parse(source);

  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest) ||
    !("version" in manifest) ||
    !isChromeVersion(manifest.version)
  ) {
    throw new Error(
      "Extension manifest version must be one to four " +
        "integers from 0 to 65535, without leading zeros",
    );
  }

  const dirtyMarker =
    stamp.dirty ? "-dirty" : "";
  const buildTime = stamp.builtAt
    .toISOString()
    .replace(/\.\d{3}Z$/u, "Z");
  const versionName =
    `${manifest.version} ` +
    `${stamp.revision}${dirtyMarker} ` +
    buildTime;

  return `${JSON.stringify(
    {
      ...manifest,
      version_name: versionName,
    },
    null,
    2,
  )}\n`;
}
