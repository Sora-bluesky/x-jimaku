export interface BuildStamp {
  readonly revision: string;
  readonly dirty: boolean;
  readonly builtAt: Date;
}

/**
 * Whether Chrome will accept this as a manifest version.
 *
 * One to four dot-separated integers, each 0 to 65535, and a non-zero part
 * may not have a leading zero. Chrome applies these rules at upload, which is
 * after the archive has been built and sent, so the shape is checked here
 * instead: the build refuses to stamp a manifest the store would reject.
 * A loose `\d+\.\d+\.\d+` accepts both 0.07.0 and 999999.0.0, and a review
 * caught it doing so.
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

  return parts.every((part) => {
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
