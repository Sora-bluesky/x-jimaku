import { readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// run-bench uses mkdtempSync with this prefix and Node's six-character suffix.
// live2 profiles are persistent children of --profile, never temporary profiles.
export const TEMP_PROFILE_PREFIX = "x-jimaku-accuracy-bench-";
const TEMP_PROFILE_NAME = /^x-jimaku-accuracy-bench-[A-Za-z0-9]{6}$/u;

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!path.isAbsolute(relative)
    && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function resolveProfilePath(value) {
  const absolute = path.resolve(value);
  try {
    return realpathSync(absolute);
  } catch (error) {
    const parent = path.dirname(absolute);
    if (error.code !== "ENOENT" || parent === absolute) throw error;
    return path.join(resolveProfilePath(parent), path.basename(absolute));
  }
}

export function cleanupTempProfiles({
  directory = tmpdir(),
  protectedPaths = [],
  log = console.error,
} = {}) {
  const removed = [];
  try {
    const protectedDirectories = protectedPaths.map(resolveProfilePath);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !TEMP_PROFILE_NAME.test(entry.name)) continue;
      const target = path.resolve(directory, entry.name);
      try {
        const realTarget = realpathSync(target);
        if (protectedDirectories.some((protectedPath) => contains(realTarget, protectedPath) || contains(protectedPath, realTarget))) continue;
        rmSync(target, { recursive: true, force: true });
        removed.push(target);
        log(`[bench] removed leftover temporary profile: ${target}`);
      } catch (error) {
        log(`[bench] temporary profile cleanup failed: ${target}: ${error.message}`);
      }
    }
  } catch (error) {
    log(`[bench] temporary profile scan failed: ${error.message}`);
  }
  return removed;
}
