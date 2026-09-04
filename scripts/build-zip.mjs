// Packs dist/ into the zip a release attaches.
//
// Nothing in the repository built the v0.6.0 artefact. It was assembled by hand
// and the steps were not written down, so the shape was taken from the
// published file rather than guessed: x-jimaku-0.6.0.zip holds 40 entries and
// dist/ holds the same 40 paths, differing only in the content hashes inside
// three filenames. The zip is dist/ itself — no wrapper directory, manifest at
// the root.
//
// Reading that zip also turned up why this writes the archive by hand instead
// of shelling out to Compress-Archive: PowerShell stores a nested entry as
// `assets\worker.js`, and the format says the separator is a forward slash.
// v0.6.0 shipped with 32 of its 40 names in that form. Chrome took it; an
// unzipper that follows the spec produces one file with a backslash in its
// name. Writing the archive here keeps the names under our control, drops the
// Windows-only dependency, and makes the bytes reproducible — the same dist/
// gives the same zip.
//
// Usage:
//   node scripts/build-zip.mjs            writes dist-zip/x-jimaku-<version>.zip
//   node scripts/build-zip.mjs --list     prints the file list and writes nothing
//   node scripts/build-zip.mjs --allow-dirty   packs a build made from an
//                                              uncommitted tree anyway
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  crc32,
  deflateRawSync,
  inflateRawSync,
} from "node:zlib";
import { execFileSync } from "node:child_process";
import {
  checkProvenance,
  describeBuild,
} from "./build-stamp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const dist = path.join(root, "dist");
const outDir = path.join(root, "dist-zip");

const LOCAL_SIGNATURE = 0x04034b50;
const ENTRY_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const UTF8_NAMES = 0x0800;
const DEFLATED = 8;
const STORED = 0;

// 1980-01-01, the earliest a zip can express. A real clock would put a fresh
// timestamp in every build, and then there would be no way to tell a rebuild
// of the same code from a build of different code.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

function fail(message) {
  console.error(`[build-zip] ${message}`);
  process.exit(1);
}

if (!existsSync(dist)) {
  fail("dist/ is missing. Run `npm run build` first.");
}

const manifestPath = path.join(dist, "manifest.json");

if (!existsSync(manifestPath)) {
  fail("dist/manifest.json is missing. The build did not finish.");
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const version = manifest.version;

// Chrome's own rule for a version lives in src/build/manifest.ts, and the
// build refuses to stamp a manifest that breaks it, so a version reaching
// here has already passed. Deliberately not a second copy of that rule: two
// copies across the TypeScript and script boundary is exactly the drift this
// pull request exists to remove. What is checked here is only what this file
// needs, which is that the version is safe to put in a filename.
if (
  typeof version !== "string" ||
  !/^[0-9][0-9.]*$/u.test(version)
) {
  fail(`dist/manifest.json has an unusable version: ${version}`);
}

const stamp = describeBuild(manifest.version_name);

function readHeadRevision() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const sourceManifest = JSON.parse(
  readFileSync(path.join(root, "public/manifest.json"), "utf8"),
);

const refusal = checkProvenance(stamp, {
  manifestVersion: sourceManifest.version,
  headRevision: readHeadRevision() || null,
  allowDirty: process.argv.includes("--allow-dirty"),
});

if (refusal !== null) {
  fail(refusal);
}

function walk(directory) {
  const found = [];

  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);

    if (statSync(full).isDirectory()) {
      found.push(...walk(full));
      continue;
    }

    found.push(path.relative(dist, full).split(path.sep).join("/"));
  }

  return found.sort();
}

const files = walk(dist);

if (files.length === 0) {
  fail("dist/ is empty.");
}

if (!files.includes("manifest.json")) {
  fail("manifest.json is not at the root of dist/.");
}

console.log(`[build-zip] version ${version}`);
console.log(
  `[build-zip] built from ${stamp.revision}` +
    `${stamp.dirty ? " with uncommitted changes" : ""} ` +
    `at ${stamp.builtAt}`,
);
console.log(`[build-zip] ${files.length} files`);

for (const file of files) {
  console.log(`  ${file}`);
}

if (process.argv.includes("--list")) {
  process.exit(0);
}

function buildArchive(names) {
  const parts = [];
  const index = [];
  let offset = 0;

  for (const name of names) {
    const raw = readFileSync(path.join(dist, ...name.split("/")));
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? DEFLATED : STORED;
    const checksum = crc32(raw);
    const encodedName = Buffer.from(name, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(encodedName.length, 26);
    local.writeUInt16LE(0, 28);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(ENTRY_SIGNATURE, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(UTF8_NAMES, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(encodedName.length, 28);
    entry.writeUInt16LE(0, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE(0, 38);
    entry.writeUInt32LE(offset, 42);

    parts.push(local, encodedName, body);
    index.push(entry, encodedName);
    offset += local.length + encodedName.length + body.length;
  }

  const indexBytes = Buffer.concat(index);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(indexBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, indexBytes, end]);
}

// Unpacks the finished bytes the way an unzipper would, walking the index and
// following it back to each body rather than trusting the offsets the writer
// just produced. Building an archive is not evidence that it holds what it
// should; a dropped file or a wrong length would otherwise surface on
// somebody's machine after the release went out.
function unpackArchive(buffer) {
  let end = -1;

  for (let at = buffer.length - 22; at >= 0; at -= 1) {
    if (buffer.readUInt32LE(at) === END_SIGNATURE) {
      end = at;
      break;
    }
  }

  if (end === -1) {
    fail("the archive has no index.");
  }

  const count = buffer.readUInt16LE(end + 10);
  const unpacked = new Map();
  let at = buffer.readUInt32LE(end + 16);

  for (let seen = 0; seen < count; seen += 1) {
    if (buffer.readUInt32LE(at) !== ENTRY_SIGNATURE) {
      fail("the archive's index is damaged.");
    }

    const method = buffer.readUInt16LE(at + 10);
    const checksum = buffer.readUInt32LE(at + 16);
    const packedSize = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localAt = buffer.readUInt32LE(at + 42);
    const name = buffer.toString(
      "utf8",
      at + 46,
      at + 46 + nameLength,
    );

    if (buffer.readUInt32LE(localAt) !== LOCAL_SIGNATURE) {
      fail(`${name} is not where the index says it is.`);
    }

    const bodyAt =
      localAt +
      30 +
      buffer.readUInt16LE(localAt + 26) +
      buffer.readUInt16LE(localAt + 28);
    const body = buffer.subarray(bodyAt, bodyAt + packedSize);
    const content =
      method === DEFLATED ? inflateRawSync(body) : body;

    if (crc32(content) !== checksum) {
      fail(`${name} does not survive a round trip.`);
    }

    unpacked.set(name, content);
    at += 46 + nameLength + extraLength + commentLength;
  }

  return unpacked;
}

const archive = buildArchive(files);
const unpacked = unpackArchive(archive);

const missing = files.filter((file) => !unpacked.has(file));
const extra = [...unpacked.keys()].filter(
  (name) => !files.includes(name),
);

for (const name of missing) {
  console.error(`[build-zip] missing from the zip: ${name}`);
}

for (const name of extra) {
  console.error(`[build-zip] not from dist/: ${name}`);
}

if (missing.length > 0 || extra.length > 0) {
  fail(
    `the zip holds ${unpacked.size} entries, dist/ has ${files.length}.`,
  );
}

for (const [name, content] of unpacked) {
  const source = readFileSync(path.join(dist, ...name.split("/")));

  if (!source.equals(content)) {
    fail(`${name} came back different from the file on disk.`);
  }
}

mkdirSync(outDir, { recursive: true });

const zipPath = path.join(outDir, `x-jimaku-${version}.zip`);

if (existsSync(zipPath)) {
  rmSync(zipPath);
}

writeFileSync(zipPath, archive);

console.log(
  `[build-zip] ${path.relative(root, zipPath)} — ` +
    `${unpacked.size} entries verified byte for byte, ` +
    `${(archive.length / 1e6).toFixed(1)} MB`,
);
