import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const scriptPath = "scripts/check-public-tree.mjs";
export const allowedPaths = [
  ".claude/skills/",
  ".github/",
  ".gitignore",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "README.ja.md",
  "THIRD-PARTY-NOTICES.md",
  "bench/",
  "docs/caption-log-notice.md",
  "package.json",
  "package-lock.json",
  "public/",
  "scripts/",
  "src/",
  "tsconfig.json",
  "vite.config.ts",
  "vite.config.iife.ts",
  "vitest.config.ts",
];

const homeName = /(?!(?:<user>|<name>|USER|USERNAME|you|me|example|%USERNAME%|\$USER|\$\{USER\})(?=$|[\\/\r\n"'`]))[^\\/\r\n"'`]+/.source;

const deniedPatterns = [
  { label: "UNC user folder", pattern: new RegExp(/[\\/]+[^\\/\s:"'`]+[\\/]+(?:[^\\/\r\n]+[\\/]+)*Users[\\/]+/.source + homeName, "i") },
  { label: "named home shorthand", pattern: /(?<![^\s\0"'`=:(\[{;|&])~[\p{L}\p{N}_.-]+[\\/]/iu },
  { label: "Windows user folder", pattern: new RegExp(/[A-Z]:[\\/]+Users[\\/]+/.source + homeName, "i") },
  { label: "macOS user folder", pattern: new RegExp(/\/Users\//.source + homeName, "i") },
  { label: "Linux user folder", pattern: new RegExp(/\/home\//.source + homeName, "i") },
  { label: ".references/", pattern: /\.references[/\\]/i, ignoreLine: ".references/" },
  { label: "HANDOFF", pattern: /HANDOFF/i, ignoreLine: "HANDOFF.md" },
  { label: "solmax", pattern: /(?<![A-Za-z0-9_])solmax(?![A-Za-z0-9_])/i },
  { label: "grok-run", pattern: /(?<![A-Za-z0-9_])grok-run(?![A-Za-z0-9_])/i },
  { label: "codex-sol", pattern: /(?<![A-Za-z0-9_])codex-sol(?![A-Za-z0-9_])/i },
  { label: "pstack", pattern: /(?<![A-Za-z0-9_])pstack(?![A-Za-z0-9_])/i },
  { label: "Sol xhigh", pattern: /(?<![A-Za-z0-9_])Sol xhigh(?![A-Za-z0-9_])/i },
];

const binaryExtensions = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".wav", ".mp3",
  ".mp4", ".webm", ".woff", ".woff2", ".zip", ".wasm", ".onnx", ".gguf",
]);

function decodeText(bytes) {
  let encoding = "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
  } else if (bytes.length > 0 && bytes.length % 2 === 0) {
    // BOM-less UTF-16 is recognized only when every ASCII code unit has
    // the same zero-byte position. Other NUL-containing data fails closed.
    for (const zeroParity of [1, 0]) {
      if (bytes.every((byte, index) =>
        index % 2 === zeroParity ? byte === 0 : byte <= 0x7f
      )) {
        encoding = zeroParity === 1 ? "utf-16le" : "utf-16be";
        break;
      }
    }
  }
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  if (text.includes("\0")) {
    throw new Error("undecodable text");
  }
  return text;
}

export function scanPublicTree(files, { extraNames = [] } = {}) {
  const patterns = [...deniedPatterns, ...extraNames.filter(Boolean).map((name) => ({
    label: "local account name",
    pattern: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu"),
  }))];
  const violations = [];
  const report = (file, line, label) => violations.push({ path: file, line, label });
  for (const { path: file, bytes } of files) {
    const allowed = allowedPaths.some((entry) =>
      entry.endsWith("/") ? file.startsWith(entry) : file === entry
    );
    if (!allowed) {
      report(file, 1, "path allowlist");
    }
    for (const rule of patterns) {
      if (rule.pattern.test(file)) {
        report(file, 1, rule.label);
      }
    }
    if (binaryExtensions.has(path.extname(file).toLowerCase())) {
      // Scan both UTF-16 byte alignments: a binary prefix can have odd length.
      const views = [Buffer.from(bytes).toString("latin1")];
      for (const offset of [0, 1]) {
        const body = Buffer.from(bytes).subarray(offset);
        const even = body.subarray(0, body.length - body.length % 2);
        views.push(even.toString("utf16le"));
        views.push(Buffer.from(even).swap16().toString("utf16le"));
      }
      for (const rule of patterns) {
        if (views.some((text) => rule.pattern.test(text))) {
          report(file, 1, rule.label);
        }
      }
      continue;
    }
    let text;
    try {
      text = decodeText(bytes);
    } catch {
      report(file, 1, "undecodable text");
      continue;
    }

    const lines = text.split(/\r?\n/);
    const patternStart = file === scriptPath
      ? lines.indexOf("const deniedPatterns = [")
      : -1;
    const patternEnd = patternStart >= 0
      ? lines.indexOf("];", patternStart)
      : -1;
    for (const [index, line] of lines.entries()) {
      if (index > patternStart && index < patternEnd) {
        continue;
      }
      for (const rule of patterns) {
        if (file === ".gitignore" && line.trim() === rule.ignoreLine) {
          continue;
        }
        if (rule.pattern.test(line)) {
          report(file, index + 1, rule.label);
        }
      }
    }
  }
  return violations;
}

function readIndexFiles() {
  const entries = execFileSync("git", ["ls-files", "--stage", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: Infinity,
  }).split("\0").filter(Boolean).map((entry) => {
    const tab = entry.indexOf("\t");
    const [, hash, stage] = entry.slice(0, tab).split(" ");
    if (stage !== "0") {
      throw new Error("cannot scan an unmerged index");
    }
    return { path: entry.slice(tab + 1), hash };
  });
  if (entries.length === 0) {
    return [];
  }

  const output = execFileSync("git", ["cat-file", "--batch"], {
    cwd: root,
    input: entries.map(({ hash }) => hash + "\n").join(""),
    maxBuffer: Infinity,
  });
  let offset = 0;
  return entries.map(({ path: file, hash }) => {
    const end = output.indexOf(10, offset);
    const [objectHash, type, length] = output.toString("ascii", offset, end).split(" ");
    const size = Number(length);
    if (end < 0 || objectHash !== hash || type !== "blob"
      || !Number.isSafeInteger(size) || size < 0
      || end + 1 + size >= output.length || output[end + 1 + size] !== 10) {
      throw new Error("invalid index blob response");
    }
    const bytes = output.subarray(end + 1, end + 1 + size);
    offset = end + 1 + size + 1;
    return { path: file, bytes };
  });
}

export function localAccountNames() {
  const extraNames = [];
  if (process.env.CI === undefined) {
    let username;
    try {
      username = os.userInfo().username;
    } catch {
      // Environment variables also support hosts without a user database.
    }
    username ||= process.env.USERNAME || process.env.USER;
    if (username?.length >= 4) extraNames.push(username);
  }
  return extraNames;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const violations = scanPublicTree(readIndexFiles(), { extraNames: localAccountNames() });
  for (const { path: file, line, label } of violations) {
    console.log(file + ":" + line + ": matched " + label);
  }
  process.exitCode = violations.length > 0 ? 1 : 0;
}
