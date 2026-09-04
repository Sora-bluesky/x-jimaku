// Reads back the stamp the build writes into dist/manifest.json.
//
// vite.config.ts fills version_name with the version, the commit, a -dirty
// marker when the tree had uncommitted changes, and the build time (see
// stampManifest in src/build/manifest.ts). That string is the only record of
// which source a dist/ came from, and the zip builder is the last place where
// noticing still costs nothing.
export function describeBuild(versionName) {
  const match = /^(\S+) (\S+?)(-dirty)? (\S+)$/u.exec(versionName ?? "");

  if (match === null) {
    return null;
  }

  return {
    version: match[1],
    revision: match[2],
    dirty: match[3] !== undefined,
    builtAt: match[4],
  };
}
