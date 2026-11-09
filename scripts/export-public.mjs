import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { allowedPaths, localAccountNames, scanPublicTree } from "./check-public-tree.mjs";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const stubPaths = [
  "LICENSE", ".gitignore", ".github/workflows/public-tree.yml",
  "scripts/check-public-tree.mjs", "scripts/check-public-tree.test.mjs",
];
const excludedPaths = [
  /^bench\/refs\/[^/]+\.wav$/,
];
const stubReadme = "x-jimaku is being rebuilt. The first release will be v0.1.0.\n";

function git(cwd, args, input) {
  try {
    return execFileSync("git", args, { cwd, input, maxBuffer: Infinity, stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    // Do not echo Git diagnostics containing local absolute paths or remote credentials.
    throw new Error("Git failed during " + (args[0] === "-c" ? args[2] : args[0]));
  }
}

function requireClean(root, label, run = (args) => git(root, args)) {
  if (run(["status", "--porcelain=v1", "--untracked-files=all"]).length) {
    throw new Error(label + " has uncommitted changes");
  }
}

function readCommittedFiles(root, stub) {
  const head = git(root, ["rev-parse", "--verify", "HEAD"]).toString("ascii").trim();
  const entries = git(root, ["ls-tree", "-r", "-z", head]).toString("utf8")
    .split("\0").filter(Boolean).map((entry) => {
      const tab = entry.indexOf("\t");
      const [mode, type, hash] = entry.slice(0, tab).split(" ");
      return { path: entry.slice(tab + 1), mode, type, hash };
    }).filter(({ path: file }) => {
      if (excludedPaths.some((pattern) => pattern.test(file))
        || file.startsWith("docs/internal/")
        || (file.startsWith(".claude/") && !file.startsWith(".claude/skills/"))) return false;
      return (stub ? stubPaths : allowedPaths).some((entry) =>
        entry.endsWith("/") ? file.startsWith(entry) : file === entry
      );
    });
  for (const entry of entries) {
    // Materializing links or submodules could write or scan outside the export.
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) {
      throw new Error("Only regular files can be exported");
    }
    const parts = entry.path.split("/");
    if (parts.some((part) => !part || part === "." || part === ".."
      || /[\\:<>"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
      || /^(\.git|git~[0-9]+)$/i.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw new Error("Unsafe export path");
    }
  }
  const output = entries.length ? git(root, ["cat-file", "--batch"],
    entries.map(({ hash }) => hash + "\n").join("")) : Buffer.alloc(0);
  let offset = 0;
  const files = entries.map((entry) => {
    const end = output.indexOf(10, offset);
    const [hash, type, length] = output.toString("ascii", offset, end).split(" ");
    const size = Number(length);
    if (end < 0 || hash !== entry.hash || type !== "blob" || !Number.isSafeInteger(size)
      || size < 0 || end + 1 + size >= output.length || output[end + 1 + size] !== 10) {
      throw new Error("Invalid committed blob response");
    }
    const bytes = output.subarray(end + 1, end + 1 + size);
    offset = end + 1 + size + 1;
    return { ...entry, bytes };
  });
  if (stub) {
    if (stubPaths.some((file) => !files.some((entry) => entry.path === file))) {
      throw new Error("Stub export is missing a required file");
    }
    files.push({ path: "README.md", mode: "100644", bytes: Buffer.from(stubReadme) });
    checkStubWorkflow(files.find((file) => file.path === ".github/workflows/public-tree.yml").bytes);
  }
  // Windows treats differently cased paths as the same destination.
  const seen = new Set();
  for (const file of files) {
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw new Error("Export paths collide on a case-insensitive filesystem");
    seen.add(key);
  }
  for (const key of seen) {
    const parts = key.split("/");
    while (parts.pop() && parts.length) {
      if (seen.has(parts.join("/"))) throw new Error("Export file and directory paths collide");
    }
  }
  return files;
}

function checkStubWorkflow(bytes) {
  // Fail closed on workflow operations we have not established can run with the stub.
  // The existing secret job obtains its own executable; it needs no npm files.
  const commands = [
    "node scripts/check-public-tree.mjs",
    "gh release download v8.30.1 --repo gitleaks/gitleaks --pattern 'gitleaks_8.30.1_linux_x64.tar.gz' --pattern 'gitleaks_8.30.1_checksums.txt'",
    "sha256sum --check --ignore-missing gitleaks_8.30.1_checksums.txt",
    "tar -xzf gitleaks_8.30.1_linux_x64.tar.gz gitleaks",
    './gitleaks git --redact --no-banner --log-opts="--all" .',
  ];
  const supported = [
    /^name: Public tree$/, /^on:$/, /^  (push|pull_request):$/, /^    branches: \[main\]$/,
    /^permissions:$/, /^  contents: read$/, /^jobs:$/, /^  (check|secrets):$/,
    /^    runs-on: ubuntu-latest$/, /^    steps:$/,
    /^      - uses: actions\/(checkout|setup-node)@v4$/, /^        with:$/,
    /^          (node-version: 22|fetch-depth: 0)$/,
    /^      - name: Scan full history for secrets$/, /^        env:$/,
    /^          GH_TOKEN: \$\{\{ github.token \}\}$/, /^        run: \|$/,
  ];
  const lines = bytes.toString("utf8").split(/\r?\n/);
  const found = [];
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const command = line.startsWith("      - run: ") ? line.slice(13)
      : line.startsWith("          ") && commands.includes(line.trim()) ? line.trim() : null;
    if (command !== null && commands.includes(command)) found.push(command);
    else if (!supported.some((pattern) => pattern.test(line))) {
      throw new Error("Stub CI cannot run: unsupported workflow operation or dependency");
    }
  }
  if (JSON.stringify(found) !== JSON.stringify(commands)) {
    throw new Error("Stub CI cannot run: expected self-contained checks are missing or changed");
  }
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(".." + path.sep)
    && relative !== ".." && !path.isAbsolute(relative));
}

function rejectMetadataLinks(directory) {
  const stat = lstatSync(directory);
  // Node reports Windows junctions through isSymbolicLink as well.
  if (stat.isSymbolicLink()) throw new Error("Target Git metadata must not contain links or junctions");
  if (stat.isDirectory()) {
    for (const entry of readdirSync(directory)) rejectMetadataLinks(path.join(directory, entry));
  }
}

function checkTarget(target, source, hooksPath) {
  const root = realpathSync(target);
  if (within(source, root) || within(root, source)) {
    throw new Error("Source and target must be separate directories");
  }
  const metadata = path.join(root, ".git");
  // Inspect before any Git command can write via redirected metadata.
  rejectMetadataLinks(metadata);
  const run = (args, input) => git(root, ["-c", "core.hooksPath=" + hooksPath, ...args], input);
  if (!lstatSync(metadata).isDirectory()
    || realpathSync(run(["rev-parse", "--show-toplevel"]).toString("utf8").trim()) !== root) {
    throw new Error("Target must be the root of a standalone Git clone");
  }
  for (const flag of ["--git-dir", "--git-common-dir"]) {
    const resolved = realpathSync(path.resolve(root, run(["rev-parse", flag]).toString("utf8").trim()));
    if (!within(realpathSync(metadata), resolved)) {
      throw new Error("Target Git directories must stay inside target metadata");
    }
  }
  const origin = run(["remote", "get-url", "origin"]).toString("utf8").trim();
  if (!/\/x-jimaku(?:\.git)?$/.test(origin)) {
    throw new Error("Target origin must end with /x-jimaku.git or /x-jimaku");
  }
  requireClean(root, "Target", run);
  return { root, run };
}

function clearTarget(root) {
  for (const entry of readdirSync(root)) {
    if (entry.toLowerCase() === ".git") continue;
    rmSync(path.join(root, entry), { recursive: true, force: true });
  }
}

function materialize(root, files) {
  for (const file of files) {
    const destination = path.join(root, file.path);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, file.bytes);
    chmodSync(destination, file.mode === "100755" ? 0o755 : 0o644);
  }
}

function verifyEntries(entries, files, run, staged = false) {
  const expected = new Map(files.map((file) => [file.path, file]));
  if (entries.length !== files.length) throw new Error("Export tree does not match selected files");
  for (const entry of entries) {
    const tab = entry.indexOf("\t");
    const fields = entry.slice(0, tab).split(" ");
    const [mode, hash, type] = staged ? [fields[0], fields[1], fields[2]]
      : [fields[0], fields[2], fields[1]];
    const file = expected.get(entry.slice(tab + 1));
    if (!file || type !== (staged ? "0" : "blob") || mode !== file.mode
      || !run(["cat-file", "blob", hash]).equals(file.bytes)) {
      throw new Error("Export differs from selected source bytes or mode");
    }
    expected.delete(file.path);
  }
}

function scanSecrets(target) {
  const result = spawnSync("gitleaks", ["dir", "--redact", "--no-banner", target], {
    stdio: "pipe",
  });
  if (result.error || result.status !== 0) {
    throw new Error("gitleaks is required and must succeed; target was not committed");
  }
}

export function exportPublic({
  target, version, stub = false, source = sourceRoot,
  extraNames = localAccountNames(), runGitleaks = scanSecrets,
}) {
  if (!target || !/^\d+\.\d+\.\d+$/.test(version ?? "")) {
    throw new Error("Usage: node scripts/export-public.mjs --target <path> --version <x.y.z> [--stub]");
  }
  const sourcePath = realpathSync(source);
  if (realpathSync(git(sourcePath, ["rev-parse", "--show-toplevel"]).toString("utf8").trim()) !== sourcePath) {
    throw new Error("Source must be a Git repository root");
  }
  requireClean(sourcePath, "Source");
  const files = readCommittedFiles(sourcePath, stub);
  if (!stub) {
    for (const file of ["package.json", "public/manifest.json"]) {
      const entry = files.find((entry) => entry.path === file);
      if (!entry || JSON.parse(entry.bytes.toString("utf8")).version !== version) {
        throw new Error("Committed " + file + " version must equal --version");
      }
    }
  }
  const temporary = mkdtempSync(path.join(os.tmpdir(), "public-export-"));
  try {
    const hooksPath = path.join(temporary, "hooks");
    const prepared = path.join(temporary, "tree");
    mkdirSync(hooksPath);
    mkdirSync(prepared);
    materialize(prepared, files);
    const violations = scanPublicTree(files.map((file) => ({
      ...file, bytes: readFileSync(path.join(prepared, file.path)),
    })), { extraNames });
    if (violations.length) {
      const redact = (text) => extraNames.reduce((value, name) => name
        ? value.replaceAll(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"), "<account>") : value, text);
      throw new Error(violations.map(({ path: file, line, label }) =>
        redact(file) + ":" + line + ": matched " + label).join("\n"));
    }
    const { root: targetPath, run } = checkTarget(target, sourcePath, hooksPath);
    runGitleaks(prepared);
    // A scanner must not change the bytes for which it supplied evidence.
    for (const file of files) {
      if (!readFileSync(path.join(prepared, file.path)).equals(file.bytes)) {
        throw new Error("Prepared export changed during scanning");
      }
    }
    rejectMetadataLinks(path.join(targetPath, ".git"));
    requireClean(targetPath, "Target", run);
    let oldHead;
    try { oldHead = run(["rev-parse", "--verify", "HEAD"]).toString("ascii").trim(); }
    catch {
      // An unborn branch has no refs; any other failure must propagate.
      if (run(["for-each-ref"]).length) throw new Error("Cannot resolve target HEAD");
    }
    let committed;
    try {
      clearTarget(targetPath);
      materialize(targetPath, files);
      run(["add", "-A", "--force"]);
      for (const executable of [false, true]) {
        const paths = files.filter((file) => (file.mode === "100755") === executable).map((file) => file.path);
        if (paths.length) run(["update-index", executable ? "--chmod=+x" : "--chmod=-x", "-z", "--stdin"],
          Buffer.from(paths.join("\0") + "\0"));
      }
      verifyEntries(run(["ls-files", "--stage", "-z"]).toString("utf8").split("\0").filter(Boolean), files, run, true);
      const tree = run(["write-tree"]).toString("ascii").trim();
      const hash = run(["commit-tree", tree, ...(oldHead ? ["-p", oldHead] : []), "-m",
        stub ? "Prepare the public repository" : "Release " + version]).toString("ascii").trim();
      run(["update-ref", "HEAD", hash, oldHead ?? "0".repeat(hash.length)]);
      committed = hash;
      verifyEntries(run(["ls-tree", "-r", "-z", hash]).toString("utf8").split("\0").filter(Boolean), files, run);
      return hash;
    } catch (error) {
      try {
        if (committed) {
          if (oldHead) run(["update-ref", "HEAD", oldHead, committed]);
          else run(["update-ref", "-d", "HEAD", committed]);
        }
        clearTarget(targetPath);
        if (oldHead) run(["reset", "--hard", oldHead]);
        else run(["read-tree", "--empty"]);
      } catch {
        throw new Error("Export failed and target restoration failed; inspect target before retrying");
      }
      throw error;
    }
  } finally {
    // This path is allocated by this invocation beneath the OS temp directory.
    rmSync(temporary, { recursive: true, force: true });
  }
}

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--stub" && options.stub === undefined) options.stub = true;
    else if (["--target", "--version"].includes(arg) && options[arg.slice(2)] === undefined
      && args[i + 1] && !args[i + 1].startsWith("--")) options[arg.slice(2)] = args[++i];
    else throw new Error("Invalid or duplicate export option");
  }
  return options;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    console.log(exportPublic(parseArgs(process.argv.slice(2))));
  } catch (error) {
    // Filesystem exceptions may contain private host paths.
    console.error(error.code ? "Export failed during a filesystem operation" : error.message);
    process.exitCode = 1;
  }
}
