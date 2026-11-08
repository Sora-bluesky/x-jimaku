import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { scanPublicTree } from "./check-public-tree.mjs";

// Assemble denied fixtures so the test source itself remains publishable.
const privateName = "alice";
const localLabel = "local account name";
const references = ".refer" + "ences";
const localNote = "HAND" + "OFF";
const tools = [
  "ps" + "tack", "codex" + "-sol", "sol" + "max",
  "grok" + "-run", "Sol" + " xhigh",
];
const rules = [
  [privateName, localLabel],
  ["C:" + "\\Users\\bob", "Windows user folder"],
  ["/" + "Users/bob", "macOS user folder"],
  [references + "/budoux", references + "/"],
  [references + "\\budoux", references + "/"],
  [localNote, localNote],
  ...tools.map((tool) => [tool, tool]),
];

function scanWithNames(files) {
  return scanPublicTree(files, { extraNames: [privateName] });
}

function scan(text, file = "src/probe.txt") {
  return scanWithNames([{ path: file, bytes: Buffer.from(text) }]);
}

for (const [index, [text, label]] of rules.entries()) {
  test(`reports denied rule ${index + 1} in content with a line number`, () => {
    assert.deepEqual(scan("clean\n" + text + "\n"), [
      { path: "src/probe.txt", line: 2, label },
    ]);
  });
  test(`reports denied rule ${index + 1} in the path`, () => {
    const file = "bench/" + text + ".txt";
    assert.deepEqual(scan("clean", file), [{ path: file, line: 1, label }]);
  });
}

test("scans dependency lock contents", () => {
  assert.deepEqual(scan(JSON.stringify({ name: privateName }), "package-lock.json"), [
    { path: "package-lock.json", line: 1, label: localLabel },
  ]);
});

for (const endian of ["le", "be"]) {
  for (const bom of [false, true]) {
    test(`scans UTF-16${endian.toUpperCase()} with BOM=${bom}`, () => {
      const body = Buffer.from("clean\n" + privateName + "\n", "utf16le");
      if (endian === "be") body.swap16();
      const prefix = endian === "le" ? [0xff, 0xfe] : [0xfe, 0xff];
      const bytes = bom ? Buffer.concat([Buffer.from(prefix), body]) : body;
      assert.deepEqual(scanWithNames([{ path: "src/probe.txt", bytes }]), [
        { path: "src/probe.txt", line: 2, label: localLabel },
      ]);
      const clean = Buffer.from("clean\n", "utf16le");
      if (endian === "be") clean.swap16();
      assert.deepEqual(scanWithNames([{
        path: "src/clean.txt",
        bytes: bom ? Buffer.concat([Buffer.from(prefix), clean]) : clean,
      }]), []);
    });
  }
}

for (const [index, bytes] of [
  Buffer.from([0xc3, 0x28]),
  Buffer.from([0xff, 0xfe, 0x61]),
  Buffer.from([0xfe, 0xff, 0x00]),
  Buffer.from("clean\0text"),
].entries()) {
  test(`rejects undecodable non-media input ${index + 1}`, () => {
    assert.deepEqual(scanWithNames([{ path: "src/data.bin", bytes }]), [
      { path: "src/data.bin", line: 1, label: "undecodable text" },
    ]);
  });
}

test("still scans UTF-8 with a BOM and non-ASCII text", () => {
  assert.deepEqual(scan("\ufeff字幕\r\n" + privateName), [
    { path: "src/probe.txt", line: 2, label: localLabel },
  ]);
});

test("scans known binary extensions without text decoding errors and checks their paths", () => {
  for (const extension of [
    "png", "jpg", "jpeg", "gif", "ico", "webp", "wav", "mp3",
    "mp4", "webm", "woff", "woff2", "zip", "wasm", "onnx", "gguf", "PNG",
  ]) {
    const bytes = Buffer.from([0xff, 0, 0xc3, 0x28]);
    assert.deepEqual(scanWithNames([{ path: "public/image." + extension, bytes }]), []);
    const file = "public/" + privateName + "." + extension;
    assert.deepEqual(scanWithNames([{ path: file, bytes }]), [
      { path: file, line: 1, label: localLabel },
    ]);
    for (const [text, label] of rules) {
      const probe = "public/probe." + extension;
      const content = Buffer.concat([bytes, Buffer.from("\n" + text)]);
      assert.deepEqual(scanWithNames([{ path: probe, bytes: content }]), [
        { path: probe, line: 1, label },
      ]);
    }
  }
});

for (const extension of ["png", "PNG"]) {
  test(`reports denied raw bytes in .${extension} content`, () => {
    const file = "public/probe." + extension;
    assert.deepEqual(scan(privateName, file), [
      { path: file, line: 1, label: localLabel },
    ]);
  });
}

test("accepts a PNG header followed by clean bytes", () => {
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("clean image data"),
  ]);
  assert.deepEqual(scanWithNames([{ path: "public/probe.png", bytes }]), []);
});

test("reports internal tool names after a hyphen", () => {
  for (const tool of tools) {
    assert.deepEqual(scan("my-" + tool), [
      { path: "src/probe.txt", line: 1, label: tool },
    ]);
  }
});

test("permits product names and tokens embedded in identifiers", () => {
  assert.deepEqual(scan("popStack Grok"), []);
  for (const tool of tools) {
    for (const prefix of ["a", "1", "_"]) {
      assert.deepEqual(scan(prefix + tool), []);
    }
    for (const suffix of ["a", "1", "_"]) {
      assert.deepEqual(scan(tool + suffix), []);
    }
    assert.deepEqual(scan("(" + tool.toUpperCase() + ")"), [
      { path: "src/probe.txt", line: 1, label: tool },
    ]);
  }
});

test("preserves exact ignore lines only in the ignore file", () => {
  const lines = localNote + ".md\n" + references + "/\n";
  assert.deepEqual(scan(lines, ".gitignore"), []);
  assert.equal(scan(lines).length, 2);
  assert.equal(scan(localNote + ".md extra", ".gitignore").length, 1);
  assert.equal(scan(references + "/extra", ".gitignore").length, 1);
});

test("enforces the path allowlist and accepts an empty text file", () => {
  assert.deepEqual(scan("", "unexpected.txt"), [
    { path: "unexpected.txt", line: 1, label: "path allowlist" },
  ]);
  assert.deepEqual(scan(""), []);
});

test("scans index blobs even when working files differ or are missing", () => {
  const here = fileURLToPath(new URL("./", import.meta.url));
  const fixture = mkdtempSync(path.join(os.tmpdir(), "public-tree-test-"));
  const git = (...args) => execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
    cwd: fixture, encoding: "utf8",
  });
  const run = () => spawnSync(process.execPath, ["scripts/check-public-tree.mjs"], {
    cwd: fixture, encoding: "utf8",
  });
  try {
    mkdirSync(path.join(fixture, "scripts"));
    mkdirSync(path.join(fixture, "src"));
    copyFileSync(new URL("./check-public-tree.mjs", import.meta.url),
      path.join(fixture, "scripts/check-public-tree.mjs"));
    git("init", "--quiet", "--template=");
    const probe = path.join(fixture, "src/probe.txt");
    writeFileSync(probe, rules[1][0] + "\n");
    git("add", "src/probe.txt");
    writeFileSync(probe, "clean\n");
    const leaked = run();
    assert.equal(leaked.status, 1, leaked.stderr);
    assert.equal(leaked.stdout, `src/probe.txt:1: matched Windows user folder\n`);
    assert.equal(readFileSync(probe, "utf8"), "clean\n");
    git("add", "src/probe.txt");
    writeFileSync(probe, rules[1][0] + "\n");
    assert.equal(run().status, 0);
    rmSync(probe);
    const clean = run();
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(clean.stdout, "");
  } finally {
    assert.equal(path.dirname(fixture), path.resolve(os.tmpdir()));
    rmSync(fixture, { recursive: true, force: true });
  }
});

// Forward-slash Windows paths also contain the macOS home-path pattern.
const homePrefixes = [
  ...["C", "D", "z"].flatMap((drive) =>
    ["\\", "\\\\", "/", "/\\/"].map((separator) => [
      drive + ":" + separator + "uSeRs" + separator,
      separator === "/" ? ["Windows user folder", "macOS user folder"] : ["Windows user folder"],
    ])
  ),
  ["/" + "Users/", ["macOS user folder"]],
  ["/" + "home/", ["Linux user folder"]],
];

for (const [index, [prefix, labels]] of homePrefixes.entries()) {
  test(`detects home path format ${index + 1} in content and paths`, () => {
    const text = prefix + "bob";
    assert.deepEqual(scanPublicTree([{ path: "src/probe.txt", bytes: Buffer.from(text) }]),
      labels.map((label) => ({ path: "src/probe.txt", line: 1, label })));

    const file = "bench/" + text + "/probe.txt";
    assert.deepEqual(scanPublicTree([{ path: file, bytes: Buffer.from("clean") }]),
      labels.map((label) => ({ path: file, line: 1, label })));
  });
}

test("permits exact home placeholders but rejects longer account segments", () => {
  const placeholders = [
    "<user>", "<name>", "USER", "USERNAME", "you", "me", "example",
    "%USERNAME%", "$USER", "${USER}",
  ];
  for (const [prefix, labels] of homePrefixes) {
    for (const placeholder of placeholders) {
      for (const suffix of ["", "/project", "\\project", '"', "'", "`", "\n"]) {
        const text = prefix + placeholder + suffix;
        assert.deepEqual(scanPublicTree([{ path: "src/probe.txt", bytes: Buffer.from(text) }]), []);
      }
      for (const suffix of ["2", ".real", "-real", " person"]) {
        const text = prefix + placeholder + suffix;
        assert.deepEqual(scanPublicTree([{ path: "src/probe.txt", bytes: Buffer.from(text) }]),
          labels.map((label) => ({ path: "src/probe.txt", line: 1, label })));
      }
      const file = "bench/" + prefix + placeholder + "/probe.txt";
      assert.deepEqual(scanPublicTree([{ path: file, bytes: Buffer.from("clean") }]), []);
    }
    assert.deepEqual(scanPublicTree([{ path: "src/probe.txt", bytes: Buffer.from(prefix) }]), []);
  }
});

test("extra names match case-insensitive substrings anywhere", () => {
  for (const text of ["alice", "ALICE", "(Alice)", "my-alice", "malice", "Alice2", "_alice", "alice_", "éalice", "alice字"]) {
    assert.deepEqual(scan(text), [{ path: "src/probe.txt", line: 1, label: localLabel }]);
  }
  assert.deepEqual(scan("clean", "src/alice.txt"), [
    { path: "src/alice.txt", line: 1, label: localLabel },
  ]);
  assert.equal(localLabel.toLowerCase().includes(privateName), false);
  assert.deepEqual(scanPublicTree([{ path: "src/alice.txt", bytes: Buffer.from("alice") }]), []);
});

test("escapes regex metacharacters in extra names", () => {
  const extraNames = ["a.b+", "a[b]", "a\\b", "a${b}"];
  for (const name of extraNames) {
    const scanName = (text) => scanPublicTree([
      { path: "src/probe.txt", bytes: Buffer.from(text) },
    ], { extraNames: [name] });
    assert.deepEqual(scanName(name), [{ path: "src/probe.txt", line: 1, label: localLabel }]);
    assert.deepEqual(scanName("unrelated"), []);
  }
});

test("CLI adds local names only outside CI, with environment fallbacks and a length floor", () => {
  const here = fileURLToPath(new URL("./", import.meta.url));
  const fixture = mkdtempSync(path.join(os.tmpdir(), "public-tree-test-"));
  try {
    mkdirSync(path.join(fixture, "scripts"));
    mkdirSync(path.join(fixture, "src"));
    copyFileSync(new URL("./check-public-tree.mjs", import.meta.url),
      path.join(fixture, "scripts/check-public-tree.mjs"));
    const preload = path.join(fixture, "scripts/mock-user.cjs");
    writeFileSync(preload, `require("node:os").userInfo = () => {
      if (process.env.MOCK_USER === "throw") throw new Error("unavailable");
      return { username: process.env.MOCK_USER };
    };\n`);
    const git = (...args) => execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
      cwd: fixture, encoding: "utf8",
    });
    git("init", "--quiet", "--template=");
    writeFileSync(path.join(fixture, "src/probe.txt"), "prefixALICEsuffix bob\n");
    git("add", "src/probe.txt");
    const run = (overrides = {}) => {
      const env = { ...process.env, MOCK_USER: "alice", USERNAME: "other", USER: "other", ...overrides };
      if (!("CI" in overrides)) delete env.CI;
      return spawnSync(process.execPath, ["--require", preload, "scripts/check-public-tree.mjs"], {
        cwd: fixture, encoding: "utf8", env,
      });
    };
    for (const overrides of [
      {}, { MOCK_USER: "throw", USERNAME: "alice" },
      { MOCK_USER: "", USERNAME: "", USER: "alice" },
    ]) {
      const result = run(overrides);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, "src/probe.txt:1: matched local account name\n");
    }
    for (const overrides of [{ CI: "true" }, { CI: "0" }, { CI: "" }, { MOCK_USER: "bob" }]) {
      const result = run(overrides);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
    }
  } finally {
    assert.equal(path.dirname(fixture), path.resolve(os.tmpdir()));
    rmSync(fixture, { recursive: true, force: true });
  }
});

for (const endian of ["latin1", "utf16le", "utf16be"]) {
  for (const offset of [0, 1]) {
    test(`scans binary content as ${endian} at byte parity ${offset}`, () => {
      for (const [text, label] of rules) {
        const body = Buffer.from(text, endian === "utf16be" ? "utf16le" : endian);
        if (endian === "utf16be") body.swap16();
        const bytes = Buffer.concat([Buffer.alloc(8 + offset, 0x89), body, Buffer.from([0xff])]);
        assert.ok(scanWithNames([{ path: "public/probe.png", bytes }]).some((item) => item.label === label));
      }
    });
  }
}

test("detects UNC home folders, named home shorthand and the former runner exception", () => {
  for (const slash of ["/", "\\"]) {
    for (const count of [1, 2, 4]) {
      for (const share of ["", "c$" + slash]) {
        const text = slash.repeat(count) + "host" + slash + share + "Users" + slash + "bob" + slash + "private";
        assert.ok(scan(text).some((item) => item.label === "UNC user folder"));
        assert.ok(scan("clean", "bench/" + text).some((item) => item.label === "UNC user folder"));
      }
    }
    assert.ok(scan("~" + "bob" + slash + "private").some((item) => item.label === "named home shorthand"));
    assert.ok(scan("C:" + slash + "Users" + slash + "runner" + slash + "private")
      .some((item) => item.label === "Windows user folder"));
    assert.deepEqual(scan("~" + slash + "private"), []);
  }
});

test("does not mistake Git short-name regex syntax for a named home", () => {
  assert.deepEqual(scan("git~[0-9]+" + "/"), []);
});


test("recognizes named homes at shell word boundaries without interpreting embedded tildes", () => {
  const home = "~" + "bob/private";
  for (const prefix of ["", " ", "\t", "=", ":", "(", "[", "{", ";", "|", "&", "\"", "'"]) {
    assert.ok(scan(prefix + home).some((item) => item.label === "named home shorthand"));
  }
  assert.ok(scan("\0" + home, "public/probe.png").some((item) => item.label === "named home shorthand"));
  for (const prefix of ["word", "3", "é", "\u0087", "*"]) {
    assert.deepEqual(scan(prefix + home), []);
  }
  const bytes = Buffer.from([0xab, 0x98, 0x8d, 0x87, 0x7e, 0x75, 0x6d, 0x64, 0x5c, 0x5b]);
  assert.deepEqual(scanWithNames([{ path: "public/probe.wav", bytes }]), []);
});
