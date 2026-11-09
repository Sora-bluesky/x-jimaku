import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupTempProfiles, TEMP_PROFILE_PREFIX } from "./temp-profiles.mjs";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal();
  return { ...fs, rmSync: vi.fn(fs.rmSync) };
});

const here = path.dirname(fileURLToPath(import.meta.url));

function withTempDirectory(run) {
  const directory = mkdtempSync(path.join(here, ".temp-profiles-test-"));
  try { run(directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("temporary profile cleanup", () => {
  it("removes only the exact generated directory pattern and logs it", () => {
    withTempDirectory((directory) => {
      const leftover = mkdtempSync(path.join(directory, TEMP_PROFILE_PREFIX));
      writeFileSync(path.join(leftover, "leftover.txt"), "leftover\n", "utf8");
      const neighbours = [
        "unrelated", "x-jimaku-accuracy-bench-", "x-jimaku-accuracy-bench-abcdef-extra",
        "x-jimaku-accuracy-bench-abcde", "x-jimaku-bench", "x-jimaku-bench-plamo",
        "x-jimaku-bench-20261109T123456789Z",
      ].map((name) => path.join(directory, name));
      for (const neighbour of neighbours) mkdirSync(neighbour);
      const matchingFile = path.join(directory, `${TEMP_PROFILE_PREFIX}ABCDEF`);
      writeFileSync(matchingFile, "preserve\n", "utf8");
      const log = vi.fn();
      expect(cleanupTempProfiles({ directory, log })).toEqual([leftover]);
      expect(existsSync(leftover)).toBe(false);
      expect(neighbours.every(existsSync)).toBe(true);
      expect(existsSync(matchingFile)).toBe(true);
      expect(log).toHaveBeenCalledWith(`[bench] removed leftover temporary profile: ${leftover}`);
    });
  });

  it("protects a supplied persistent profile and its ancestors and children", () => {
    withTempDirectory((directory) => {
      const profile = mkdtempSync(path.join(directory, TEMP_PROFILE_PREFIX));
      for (const protectedPath of [profile, path.join(profile, "nested"), directory]) {
        expect(cleanupTempProfiles({ directory, protectedPaths: [protectedPath] })).toEqual([]);
        expect(existsSync(profile)).toBe(true);
      }
    });
  });

  it.each(["", "nested", "nested/not-created"])("protects a profile reached through a junction (%s)", suffix => {
    withTempDirectory(directory => {
      const target = mkdtempSync(path.join(directory, TEMP_PROFILE_PREFIX));
      mkdirSync(path.join(target, "nested"));
      const sentinel = path.join(target, "KEEP");
      writeFileSync(sentinel, "profile data\n", "utf8");
      const link = path.join(directory, "profile-link");
      symlinkSync(target, link, "junction");
      const leftover = mkdtempSync(path.join(directory, TEMP_PROFILE_PREFIX));
      expect(cleanupTempProfiles({ directory, protectedPaths: [path.join(link, suffix)], log: () => {} })).toEqual([leftover]);
      expect(existsSync(sentinel)).toBe(true);
    });
  });

  it("resolves candidates scanned through a junction and tolerates an unrelated missing profile", () => {
    withTempDirectory(directory => {
      const scan = path.join(directory, "scan");
      mkdirSync(scan);
      const profile = mkdtempSync(path.join(scan, TEMP_PROFILE_PREFIX));
      const link = path.join(directory, "scan-link");
      symlinkSync(scan, link, "junction");
      const leftover = mkdtempSync(path.join(scan, TEMP_PROFILE_PREFIX));
      expect(cleanupTempProfiles({
        directory: link, protectedPaths: [profile, path.join(directory, "missing")], log: () => {},
      })).toEqual([path.join(link, path.basename(leftover))]);
      expect(existsSync(profile)).toBe(true);
    });
  });

  it("logs scan failures without aborting", () => {
    withTempDirectory((directory) => {
      const log = vi.fn();
      expect(cleanupTempProfiles({ directory: path.join(directory, "missing"), log })).toEqual([]);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("temporary profile scan failed"));
    });
  });

  it("logs a removal failure and continues cleaning other matches", () => {
    withTempDirectory((directory) => {
      const leftovers = [
        mkdtempSync(path.join(directory, TEMP_PROFILE_PREFIX)),
        mkdtempSync(path.join(directory, TEMP_PROFILE_PREFIX)),
      ];
      vi.mocked(rmSync).mockImplementationOnce(() => { throw new Error("simulated EPERM"); });
      const log = vi.fn();
      const removed = cleanupTempProfiles({ directory, log });
      expect(removed).toHaveLength(1);
      expect(existsSync(removed[0])).toBe(false);
      expect(leftovers.filter(existsSync)).toHaveLength(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("simulated EPERM"));
    });
  });
});
