import { createHash } from "node:crypto";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pins } from "./pins.mjs";

export const vendorFiles = [
  "LICENSE", "LICENSE.dawn", "LICENSE.emscripten", "LICENSE.llama.cpp",
  "index.d.ts", "index.js", "wllama-opfs.js", "wllama-worker.js", "wllama.wasm",
].sort();

export function fileIdentity(bytes) {
  return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

export function assertCsp(source, name) {
  if (/createObjectURL|\bnew\s+Blob\s*\([\s\S]{0,180}type:\s*["'](?:text|application)\/javascript|["'`]\s*(?:blob|data):/u.test(source)) {
    throw new Error(`${name}: dynamic Blob/data worker code is forbidden`);
  }
  if (source.includes("\r") || /sourceMappingURL/u.test(source)) {
    throw new Error(`${name}: CR or source map in generated JavaScript`);
  }
}

export function verifyVendor(directory) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(directory, "SOURCE.json"), "utf8"));
  } catch (cause) {
    throw new Error("Missing or invalid vendor/wllama/SOURCE.json; run scripts/wllama/build.sh", { cause });
  }
  for (const [key, value] of Object.entries(pins)) {
    if (manifest[key] !== value) throw new Error(`SOURCE.json: unexpected ${key}`);
  }
  const actual = readdirSync(directory).sort();
  const expected = [...vendorFiles, "SOURCE.json"].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)
    || JSON.stringify(Object.keys(manifest.files ?? {}).sort()) !== JSON.stringify(vendorFiles)) {
    throw new Error("vendor/wllama file inventory differs from SOURCE.json");
  }
  for (const name of vendorFiles) {
    const path = join(directory, name);
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error(`Not a regular vendored file: ${name}`);
    const bytes = readFileSync(path);
    const identity = fileIdentity(bytes);
    if (manifest.files[name]?.sha256 !== identity.sha256 || manifest.files[name]?.bytes !== identity.bytes) {
      throw new Error(`vendor/wllama/${name}: SHA-256 or byte size differs from SOURCE.json`);
    }
    if (name.endsWith(".js")) assertCsp(bytes.toString("utf8"), name);
  }
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    verifyVendor(process.argv[2] ?? fileURLToPath(new URL("../../vendor/wllama", import.meta.url)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
