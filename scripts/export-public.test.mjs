import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exportPublic } from "./export-public.mjs";

const version = "0.1.0";
const stubSet = [
  ".github/workflows/public-tree.yml", ".gitignore", "LICENSE", "README.md",
  "scripts/check-public-tree.mjs", "scripts/check-public-tree.test.mjs",
].sort();

function put(root, file, contents) {
  const destination = path.join(root, file);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

function tracked(root) {
  return git(root, "ls-files", "-z").split("\0").filter(Boolean).sort();
}

function snapshot(root) {
  return {
    head: git(root, "rev-parse", "HEAD"),
    status: git(root, "status", "--porcelain=v1", "--untracked-files=all"),
    files: readdirSync(root, { recursive: true }).filter((file) => file !== ".git"
      && !file.startsWith(".git" + path.sep)).map((file) => [file,
      lstatSync(path.join(root, file)).isFile() ? readFileSync(path.join(root, file)).toString("base64") : null]),
    index: readFileSync(path.join(root, ".git/index")).toString("base64"),
  };
}

function fixture(t) {
  const parent = mkdtempSync(path.join(os.tmpdir(), "public-export-test-"));
  const source = path.join(parent, "source");
  const target = path.join(parent, "target");
  // Isolate test identities, hooks and attributes from the host's Git configuration.
  const oldEnv = { ...process.env };
  const globalConfig = path.join(parent, "gitconfig");
  writeFileSync(globalConfig, "[core]\n\tautocrlf = false\n");
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  t.after(() => {
    for (const name of Object.keys(process.env)) if (!(name in oldEnv)) delete process.env[name];
    Object.assign(process.env, oldEnv);
    assert.equal(path.dirname(parent), path.resolve(os.tmpdir()));
    rmSync(parent, { recursive: true, force: true });
  });
  for (const root of [source, target]) {
    mkdirSync(root);
    git(root, "init", "--quiet", "--template=");
    git(root, "config", "user.name", "Export Test");
    git(root, "config", "user.email", "export@example.invalid");
  }
  const sourceFiles = {
    "LICENSE": "Test license\n",
    ".gitignore": "ignored.txt\n*.log\n",
    "README.md": "Development README\n",
    "package.json": JSON.stringify({ version }) + "\n",
    "public/manifest.json": JSON.stringify({ version }) + "\n",
    "public/tracked.log": "Committed public fixture\n",
    "src/example.ts": "export const answer = 42;\n",
    "src/日本語.txt": "字幕\n",
    "scripts/executable.sh": "#!/bin/sh\nexit 0\n",
    "scripts/wllama/build.sh": "#!/bin/bash\nexit 0\n",
    "vendor/wllama/index.js": "export {};\n",
    "vendor/wllama/wllama.wasm": Buffer.from([0, 97, 115, 109]),
    "docs/caption-log-notice.md": "Public notice\n",
    "bench/refs/x.wav": "Synthesized audio\n",
    "bench/refs/x-script.txt": "Speech script\n",
    "docs/internal/x.md": "Private notes\n",
    ".claude/local/y": "Private settings\n",
    ".claude/skills/example/SKILL.md": "Public skill\n",
    "unlisted.txt": "Not in manifest\n",
  };
  for (const [file, contents] of Object.entries(sourceFiles)) put(source, file, contents);
  for (const file of ["check-public-tree.mjs", "check-public-tree.test.mjs", "export-public.mjs"]) {
    mkdirSync(path.join(source, "scripts"), { recursive: true });
    copyFileSync(new URL(file, import.meta.url), path.join(source, "scripts", file));
  }
  put(source, ".github/workflows/public-tree.yml",
    readFileSync(new URL("../.github/workflows/public-tree.yml", import.meta.url)));
  git(source, "add", "-A");
  git(source, "add", "--force", "public/tracked.log");
  git(source, "update-index", "--chmod=+x", "scripts/executable.sh");
  git(source, "config", "core.filemode", "false");
  git(source, "commit", "--quiet", "-m", "Source fixture");
  put(target, "old.txt", "Previous public tree\n");
  put(target, ".gitignore", "ignored.txt\n");
  git(target, "add", "-A");
  git(target, "commit", "--quiet", "-m", "Target fixture");
  git(target, "remote", "add", "origin", "https://example.invalid/team/x-jimaku.git");
  let scans = 0;
  const options = { source, target, version, extraNames: [], runGitleaks: (root) => {
    scans++;
    assert.notEqual(root, target);
    assert.equal(path.dirname(path.dirname(root)), path.resolve(os.tmpdir()));
    assert.equal(existsSync(path.join(root, "old.txt")), false);
    assert.equal(readFileSync(path.join(target, "old.txt"), "utf8"), "Previous public tree\n");
    assert.equal(git(target, "diff", "--cached", "--name-only"), "");
  } };
  return {
    source, target, options, scans: () => scans,
    commitSource: () => { git(source, "add", "-A"); git(source, "commit", "--quiet", "-m", "Change source fixture"); },
  };
}

test("exports allowlisted HEAD blobs, removes stale and ignored files, and preserves Git modes", (t) => {
  const f = fixture(t);
  put(f.target, "ignored.txt", "Ignored stale file\n");
  const originalGitConfig = readFileSync(path.join(f.target, ".git/config"));
  const hash = exportPublic(f.options);
  assert.match(hash, /^[a-f0-9]{40,64}$/);
  assert.equal(hash, git(f.target, "rev-parse", "HEAD").trim());
  assert.equal(git(f.target, "log", "-1", "--format=%s").trim(), "Release " + version);
  const files = tracked(f.target);
  for (const file of ["LICENSE", "src/example.ts", "src/日本語.txt", "public/tracked.log", ".claude/skills/example/SKILL.md", "bench/refs/x-script.txt", "scripts/wllama/build.sh", "vendor/wllama/index.js", "vendor/wllama/wllama.wasm"]) {
    assert.ok(files.includes(file));
    assert.deepEqual(readFileSync(path.join(f.target, file)), readFileSync(path.join(f.source, file)));
  }
  for (const file of ["bench/refs/x.wav", "docs/internal/x.md", ".claude/local/y", "unlisted.txt", "old.txt", "ignored.txt"]) {
    assert.equal(existsSync(path.join(f.target, file)), false);
  }
  assert.match(git(f.target, "ls-files", "--stage", "scripts/executable.sh"), /^100755 /);
  assert.match(git(f.target, "ls-files", "--stage", "src/example.ts"), /^100644 /);
  assert.deepEqual(readFileSync(path.join(f.target, ".git/config")), originalGitConfig);
  assert.equal(git(f.target, "status", "--porcelain=v1"), "");
  assert.equal(f.scans(), 1);
});

for (const kind of ["account", "home path"]) {
  test(`refuses a committed ${kind} leak before touching the target`, (t) => {
    const f = fixture(t);
    put(f.source, "src/leak.txt", kind === "account" ? "alice\n" : "C:" + "\\Users\\alice\\private\n");
    f.commitSource();
    const before = snapshot(f.target);
    assert.throws(() => exportPublic({ ...f.options, extraNames: ["alice"] }), /matched/);
    assert.deepEqual(snapshot(f.target), before);
    assert.equal(f.scans(), 0);
  });
}

for (const kind of ["working file", "index", "untracked file"]) {
  test(`refuses a source with a dirty ${kind}`, (t) => {
    const f = fixture(t);
    put(f.source, kind === "untracked file" ? "new.txt" : "LICENSE", "Uncommitted\n");
    if (kind === "index") git(f.source, "add", "LICENSE");
    const before = snapshot(f.target);
    assert.throws(() => exportPublic(f.options), /Source has uncommitted changes/);
    assert.deepEqual(snapshot(f.target), before);
    assert.equal(f.scans(), 0);
  });
}

for (const origin of ["https://example.invalid/team/x-jimaku-dev.git", "https://example.invalid/team/other.git"]) {
  test(`refuses a target origin ending in ${origin.split("/").at(-1)}`, (t) => {
    const f = fixture(t);
    git(f.target, "remote", "set-url", "origin", origin);
    const before = snapshot(f.target);
    assert.throws(() => exportPublic(f.options), /Target origin must end/);
    assert.deepEqual(snapshot(f.target), before);
  });
}

for (const kind of ["tracked", "untracked", "staged"]) {
  test(`refuses a target with ${kind} changes`, (t) => {
    const f = fixture(t);
    put(f.target, kind === "untracked" ? "new.txt" : "old.txt", "Keep this\n");
    if (kind === "staged") git(f.target, "add", "old.txt");
    const before = snapshot(f.target);
    assert.throws(() => exportPublic(f.options), /Target has uncommitted changes/);
    assert.deepEqual(snapshot(f.target), before);
  });
}

for (const file of ["package.json", "public/manifest.json"]) {
  test(`requires the committed ${file} version to match`, (t) => {
    const f = fixture(t);
    put(f.source, file, '{"version":"0.2.0"}\n');
    f.commitSource();
    const before = snapshot(f.target);
    assert.throws(() => exportPublic(f.options), /version must equal --version/);
    assert.deepEqual(snapshot(f.target), before);
  });
}

test("stub exports exactly six files and its public-tree CI check runs without npm", (t) => {
  const f = fixture(t);
  put(f.source, "package.json", '{"version":"9.9.9"}\n');
  f.commitSource();
  exportPublic({ ...f.options, stub: true });
  assert.deepEqual(tracked(f.target), stubSet);
  assert.equal(readFileSync(path.join(f.target, "README.md"), "utf8"),
    "x-jimaku is being rebuilt. The first release will be v0.1.0.\n");
  assert.equal(git(f.target, "log", "-1", "--format=%s").trim(), "Prepare the public repository");
  const check = spawnSync(process.execPath, ["scripts/check-public-tree.mjs"], {
    cwd: f.target, env: { ...process.env, CI: "1" }, encoding: "utf8",
  });
  assert.equal(check.status, 0, check.stderr + check.stdout);
  const tests = spawnSync(process.execPath, ["--test", "scripts/check-public-tree.test.mjs"], {
    cwd: f.target, env: { ...process.env, CI: "1" }, encoding: "utf8",
  });
  assert.equal(tests.status, 0, tests.stderr + tests.stdout);
});

test("stub reports an unsupported CI dependency and leaves target untouched", (t) => {
  const f = fixture(t);
  const workflow = ".github/workflows/public-tree.yml";
  put(f.source, workflow, readFileSync(path.join(f.source, workflow), "utf8") + "      - run: npm test\n");
  f.commitSource();
  const before = snapshot(f.target);
  assert.throws(() => exportPublic({ ...f.options, stub: true }), /Stub CI cannot run/);
  assert.deepEqual(snapshot(f.target), before);
});

test("gitleaks failure stops before staging or committing", (t) => {
  const f = fixture(t);
  const before = snapshot(f.target);
  assert.throws(() => exportPublic({ ...f.options, runGitleaks: () => {
    throw new Error("Secret scanner failed");
  } }), /Secret scanner failed/);
  assert.deepEqual(snapshot(f.target), before);
  assert.equal(git(f.target, "diff", "--cached", "--name-only"), "");
});

test("refuses overlapping source and target roots before deleting any files", (t) => {
  const f = fixture(t);
  git(f.source, "remote", "add", "origin", "https://example.invalid/team/x-jimaku.git");
  const before = snapshot(f.source);
  assert.throws(() => exportPublic({ ...f.options, target: f.source }), /separate directories/);
  assert.deepEqual(snapshot(f.source), before);
});

test("rejects malformed versions before writing", (t) => {
  const f = fixture(t);
  const before = snapshot(f.target);
  for (const input of [undefined, "v0.1.0", "0.1", "0.1.0\nother"]) {
    assert.throws(() => exportPublic({ ...f.options, version: input }), /Usage:/);
  }
  assert.deepEqual(snapshot(f.target), before);
});

test("exports to an empty public repository whose origin has no .git suffix", (t) => {
  const f = fixture(t);
  const target = path.join(path.dirname(f.target), "empty-target");
  mkdirSync(target);
  git(target, "init", "--quiet", "--template=");
  git(target, "config", "user.name", "Export Test");
  git(target, "config", "user.email", "export@example.invalid");
  git(target, "remote", "add", "origin", "https://example.invalid/team/x-jimaku");
  const hash = exportPublic({ ...f.options, target, runGitleaks: () => {} });
  assert.equal(hash, git(target, "rev-parse", "HEAD").trim());
  assert.equal(git(target, "rev-list", "--count", "HEAD").trim(), "1");
});

test("deleting an ignored directory link cannot delete source files", (t) => {
  const f = fixture(t);
  symlinkSync(f.source, path.join(f.target, "ignored.txt"), process.platform === "win32" ? "junction" : "dir");
  const before = snapshot(f.source);
  exportPublic(f.options);
  assert.deepEqual(snapshot(f.source), before);
  assert.equal(existsSync(path.join(f.target, "ignored.txt")), false);
});

test("CLI rejects missing, unknown, and duplicate options", (t) => {
  const f = fixture(t);
  for (const args of [[], ["--unknown"], ["--stub", "--stub"], ["--target", "--stub"]]) {
    const result = spawnSync(process.execPath, ["scripts/export-public.mjs", ...args], {
      cwd: f.source, encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:|Invalid or duplicate export option/);
  }
});


test("never runs target hooks or commits a hook-added file", (t) => {
  const f = fixture(t);
  put(f.target, ".git/hooks/pre-commit", "#!/bin/sh\nprintf injected > hook-added.txt\ngit add --force hook-added.txt\n");
  put(f.target, ".git/hooks/reference-transaction", "#!/bin/sh\nprintf ran > ref-hook-ran.txt\n");
  exportPublic(f.options);
  assert.equal(existsSync(path.join(f.target, "hook-added.txt")), false);
  assert.equal(existsSync(path.join(f.target, "ref-hook-ran.txt")), false);
  assert.equal(git(f.target, "ls-tree", "--name-only", "HEAD", "hook-added.txt"), "");
  assert.equal(git(f.target, "rev-list", "--count", "HEAD").trim(), "2");
});

for (const entry of ["", "objects", "refs", "logs"]) {
  test(`refuses junctions in Git metadata: ${entry || "root"}`, (t) => {
    const f = fixture(t);
    const inside = path.join(f.target, ".git", entry);
    const outside = path.join(path.dirname(f.target), "outside-metadata");
    renameSync(inside, outside);
    symlinkSync(outside, inside, "junction");
    const before = readdirSync(outside, { recursive: true });
    assert.throws(() => exportPublic(f.options), /metadata must not contain links/);
    assert.deepEqual(readdirSync(outside, { recursive: true }), before);
    assert.equal(readFileSync(path.join(f.target, "old.txt"), "utf8"), "Previous public tree\n");
  });
}

for (const metadata of [".GIT", ".Git"]) {
  test(`preserves case-insensitive Git metadata: ${metadata}`, { skip: process.platform !== "win32" }, (t) => {
    const f = fixture(t);
    renameSync(path.join(f.target, ".git"), path.join(f.target, "metadata-temp"));
    renameSync(path.join(f.target, "metadata-temp"), path.join(f.target, metadata));
    exportPublic(f.options);
    assert.ok(existsSync(path.join(f.target, metadata, "HEAD")));
    assert.equal(git(f.target, "status", "--porcelain=v1"), "");
  });
}

for (const kind of ["commit", "staged bytes"]) {
  test(`restores the previous HEAD tree and clean index after ${kind} failure`, (t) => {
    const f = fixture(t);
    if (kind === "commit") {
      git(f.target, "config", "user.name", "");
      git(f.target, "config", "user.email", "");
    } else {
      put(f.target, ".git/info/attributes", "README.md text eol=lf\n");
      put(f.source, "README.md", "source bytes\r\n");
      f.commitSource();
    }
    const before = snapshot(f.target);
    assert.throws(() => exportPublic(f.options), /Git failed|differs from selected/);
    const after = snapshot(f.target);
    assert.equal(after.head, before.head);
    assert.equal(after.status, "");
    assert.deepEqual(after.files, before.files);
  });
}

for (const encoding of ["utf16le", "utf16be", "unc", "tilde", "runner", "substring"]) {
  test(`refuses a committed ${encoding} leak before touching target`, (t) => {
    const f = fixture(t);
    const text = encoding === "unc" ? "\\\\" + "host" + "\\Users\\bob\\private"
      : encoding === "tilde" ? "~" + "bob/private"
      : encoding === "runner" ? "C:" + "\\Users\\runner\\private"
      : encoding === "substring" ? "prefixALICEsuffix"
      : "C:" + "\\Users\\bob\\private";
    const binary = encoding.startsWith("utf16");
    let bytes = Buffer.from(text, binary ? "utf16le" : "utf8");
    if (encoding === "utf16be") bytes.swap16();
    if (binary) bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e]), bytes]);
    put(f.source, binary ? "public/leak.png" : "src/leak.txt", bytes);
    f.commitSource();
    const before = snapshot(f.target);
    assert.throws(() => exportPublic({ ...f.options, extraNames: ["alice"] }), /matched/);
    assert.deepEqual(snapshot(f.target), before);
    assert.equal(f.scans(), 0);
  });
}

for (const variable of ["GIT_DIR", "GIT_COMMON_DIR"]) {
  test(`refuses ${variable} resolved outside target metadata`, (t) => {
    const f = fixture(t);
    const before = snapshot(f.target);
    const previous = process.env[variable];
    try {
      process.env[variable] = path.join(f.source, ".git");
      assert.throws(() => exportPublic(f.options), /Git directories must stay inside target metadata/);
    } finally {
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
    }
    assert.deepEqual(snapshot(f.target), before);
  });
}
