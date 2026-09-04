export interface BuildStamp {
  readonly revision: string;
  readonly dirty: boolean;
  readonly builtAt: Date;
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
    typeof manifest.version !== "string"
  ) {
    throw new Error(
      "Extension manifest version must be a string",
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
