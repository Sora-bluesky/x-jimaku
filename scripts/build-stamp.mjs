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

/**
 * Says why a built dist/ must not be packaged, or null when it may be.
 *
 * dist/ is gitignored, so a clean build outlives the branch it was made on. A
 * checkout, a pull or a version bump leaves it sitting there looking healthy,
 * and the stamp is the only thing that can tell. Only if all three of its parts
 * are read, though: checking the -dirty marker alone accepts a build from
 * another commit, and accepts a 0.6.0 build after the manifest moved on. The
 * archive would then be named for the version it was built with, and nothing
 * further down would disagree with it.
 */
export function checkProvenance(stamp, expected) {
  if (stamp === null) {
    return (
      "dist/manifest.json carries no build stamp, so there is no way " +
      "to say which source it came from. Run `npm run build`."
    );
  }

  if (stamp.dirty && !expected.allowDirty) {
    return (
      `dist/ was built from ${stamp.revision} with uncommitted ` +
      "changes. Commit them and build again, or pass --allow-dirty " +
      "to package it anyway."
    );
  }

  if (stamp.version !== expected.manifestVersion) {
    return (
      `dist/ was built at version ${stamp.version}, but ` +
      `public/manifest.json says ${expected.manifestVersion}. ` +
      "Build again."
    );
  }

  if (expected.headRevision === null) {
    return (
      "the current commit could not be read, so the build cannot be " +
      "traced to it. Package a release from a git checkout."
    );
  }

  if (stamp.revision !== expected.headRevision) {
    return (
      `dist/ was built from ${stamp.revision}, but HEAD is ` +
      `${expected.headRevision}. Build again.`
    );
  }

  return null;
}

/**
 * The files a manifest promises the browser it will find, and whether dist/
 * actually holds them.
 *
 * `npm run build` is two vite passes. The first empties dist/ and writes the
 * stamped manifest; the second emits the content script. If the second fails,
 * dist/ is left holding a manifest that names a content.js which is not there,
 * and a check that only asks whether manifest.json exists waves it through.
 * The archive then installs and the extension does nothing on the page, which
 * is a bad thing to learn from a store listing.
 *
 * Checking the manifest's own references rather than a completion marker means
 * the check keeps working when the build gains or loses an entry point.
 */
export function missingReferences(manifest, files) {
  const present = new Set(files);
  const missing = [];

  const require = (reference) => {
    if (typeof reference !== "string" || reference === "") {
      return;
    }

    if (!reference.includes("*")) {
      if (!present.has(reference)) {
        missing.push(reference);
      }

      return;
    }

    // Chrome lets * span slashes, so `ort/*` covers the whole directory.
    const pattern = new RegExp(
      `^${reference
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
        .join(".*")}$`,
      "u",
    );

    if (!files.some((file) => pattern.test(file))) {
      missing.push(reference);
    }
  };

  require(manifest.background?.service_worker);
  require(manifest.options_page);
  require(manifest.options_ui?.page);
  require(manifest.action?.default_popup);

  for (const script of manifest.content_scripts ?? []) {
    for (const file of [
      ...(script.js ?? []),
      ...(script.css ?? []),
    ]) {
      require(file);
    }
  }

  for (const icon of Object.values(manifest.icons ?? {})) {
    require(icon);
  }

  for (const entry of manifest.web_accessible_resources ?? []) {
    for (const resource of entry.resources ?? []) {
      require(resource);
    }
  }

  return missing;
}
