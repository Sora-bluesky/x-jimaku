import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pins } from "./pins.mjs";
import { assertCsp, fileIdentity, vendorFiles, verifyVendor } from "./verify.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

it("verifies every vendored hash, size, file inventory and CSP-safe JavaScript", () => {
  verifyVendor(join(root, "vendor/wllama"));
});

describe("vendor verification failures", () => {
  it("runs CLI verification and rejects a corrupted temporary vendor copy", () => {
    const scratch = join(root, ".wllama-build");
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "verify-cli-test-"));
    try {
      cpSync(join(root, "vendor/wllama"), directory, { recursive: true });
      const run = () => spawnSync(process.execPath, [join(root, "scripts/wllama/verify.mjs"), directory], { cwd: root, encoding: "utf8" });
      const valid = run();
      expect(valid.error).toBeUndefined();
      expect(valid.status).toBe(0);
      writeFileSync(join(directory, "index.js"), "corrupted\n");
      const invalid = run();
      expect(invalid.error).toBeUndefined();
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toContain("vendor/wllama/index.js: SHA-256 or byte size differs from SOURCE.json");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function fixture(run) {
    const scratch = join(root, ".wllama-build");
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "verify-test-"));
    try {
      const files = {};
      for (const name of vendorFiles) {
        const bytes = Buffer.from(name.endsWith(".js") ? "export {};\n" : "fixture\n");
        writeFileSync(join(directory, name), bytes);
        files[name] = fileIdentity(bytes);
      }
      writeFileSync(join(directory, "SOURCE.json"), JSON.stringify({ ...pins, files }) + "\n");
      run(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it("rejects tampered bytes, wrong sizes, missing files and unexpected files", () => {
    fixture((directory) => {
      expect(() => verifyVendor(directory)).not.toThrow();
      writeFileSync(join(directory, "wllama.wasm"), "changed\n");
      expect(() => verifyVendor(directory)).toThrow(/SHA-256 or byte size/);
    });
    fixture((directory) => {
      const manifest = JSON.parse(readFileSync(join(directory, "SOURCE.json"), "utf8"));
      manifest.files["wllama-worker.js"].bytes++;
      writeFileSync(join(directory, "SOURCE.json"), JSON.stringify(manifest));
      expect(() => verifyVendor(directory)).toThrow(/SHA-256 or byte size/);
    });
    fixture((directory) => {
      rmSync(join(directory, "wllama-opfs.js"));
      expect(() => verifyVendor(directory)).toThrow(/inventory/);
    });
    fixture((directory) => {
      writeFileSync(join(directory, "stray.js.map"), "{}");
      expect(() => verifyVendor(directory)).toThrow(/inventory/);
    });
  });

  it("rejects dynamic worker code while allowing Blobs used as model/cache data", () => {
    for (const code of [
      "URL.createObjectURL(script)",
      'new Blob([code], { type: "text/javascript" })',
      'new Worker("blob:worker")',
      'new Worker("data:text/javascript,code")',
    ]) expect(() => assertCsp(code, "fixture.js")).toThrow(/forbidden/);
    expect(() => assertCsp('new Blob([JSON.stringify(metadata)], { type: "text/plain" })', "fixture.js")).not.toThrow();
    expect(() => assertCsp('new Blob(chunks)', "fixture.js")).not.toThrow();
  });
});
