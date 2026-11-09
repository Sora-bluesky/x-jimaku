import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import { pins } from "./pins.mjs";
import { assertCsp, fileIdentity, vendorFiles, verifyVendor } from "./verify.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const work = resolve(process.env.WLLAMA_WORK || join(root, ".wllama-build/source"));
const dryRun = process.argv.slice(2).includes("--dry-run");
if (process.argv.slice(2).some((arg) => arg !== "--dry-run")) throw new Error("Usage: package.mjs [--dry-run]");

function text(name) {
  const source = readFileSync(join(work, name), "utf8");
  assertLf(source, name);
  return source;
}

function assertLf(source, name) {
  if (source.includes("\r")) throw new Error(`CR detected in ${name}; rebuild from a core.autocrlf=false checkout`);
  return source;
}

function replaceOnce(source, before, after) {
  if (typeof before === "string") {
    if (source.split(before).length !== 2) throw new Error(`Expected exactly one CSP replacement: ${before}`);
  } else if ([...source.matchAll(before)].length !== 1) {
    throw new Error(`Expected exactly one CSP replacement: ${before}`);
  }
  return source.replace(before, () => after);
}

const generated = text("src/workers-code/generated.ts");
function extract(name) {
  const lines = generated.split("\n").filter((line) => line.startsWith(`export const ${name} = `));
  if (lines.length !== 1) throw new Error(`Expected one upstream worker constant: ${name}`);
  const code = JSON.parse(lines[0].slice(lines[0].indexOf(" = ") + 3).replace(/;\s*$/u, ""));
  return assertLf(code, `src/workers-code/generated.ts:${name}`);
}
const llamaWorker = extract("LLAMA_CPP_WORKER_CODE");
const opfsWorker = extract("OPFS_UTILS_WORKER_CODE");
let emscripten = extract("WLLAMA_EMSCRIPTEN_CODE");
text("src/glue/messages.ts");
text("src/glue/glue.ts");
const workerSource = text("src/worker.ts");
const stubMatches = [...workerSource.matchAll(/const JSPI_STUB = `([\s\S]*?)`;/gu)];
if (stubMatches.length !== 1 || /\$\{/u.test(stubMatches[0][1]) || stubMatches[0][1].includes("\\")) {
  throw new Error("Unexpected JSPI stub; inspect upstream template literal");
}
// No pthread workers can be started under the extension's CSP. With nbThread=0
// this allocator is unreachable; fail explicitly if upstream ever calls it.
emscripten = replaceOnce(emscripten,
  'allocateUnusedWorker(){var worker;var pthreadMainJs=_scriptName;if(Module["mainScriptUrlOrBlob"]){pthreadMainJs=Module["mainScriptUrlOrBlob"];if(typeof pthreadMainJs!="string"){pthreadMainJs=URL.createObjectURL(pthreadMainJs)}}worker=new Worker(pthreadMainJs,{workerData:"em-pthread",name:"em-pthread"});PThread.unusedWorkers.push(worker)}',
  'allocateUnusedWorker(){throw new Error("Pthreads are disabled in x-jimaku")}');
const mainModule = replaceOnce(stubMatches[0][1] + emscripten, "var Module", "var ___Module");
const staticWorker = [
  'const RUN_OPTIONS = {pathConfig: {"wllama.wasm": new URL("/wllama/wllama.wasm", self.location.origin).href}, nbThread: 0, compat: false};',
  `function wModuleInit() { ${mainModule}; return Module; }`,
  llamaWorker,
].join(";\n\n");
assertCsp(staticWorker, "wllama-worker.js");
assertCsp(opfsWorker, "wllama-opfs.js");

function gitCommit(directory) {
  return execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}
if (gitCommit(work) !== pins.wllamaCommit || gitCommit(join(work, "llama.cpp")) !== pins.llamaCppCommit) {
  throw new Error("wllama or llama.cpp commit differs from pins.mjs");
}
const zip = readFileSync(join(work, "build/emdawn.zip"));
if (fileIdentity(zip).sha256 !== pins.dawnSha256) throw new Error("Dawn zip SHA-256 mismatch");

function zipEntry(name) {
  let end = zip.length - 22;
  while (end >= Math.max(0, zip.length - 65557) && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < Math.max(0, zip.length - 65557)) throw new Error("Invalid Dawn zip directory");
  let offset = zip.readUInt32LE(end + 16);
  const count = zip.readUInt16LE(end + 10);
  for (let index = 0; index < count; index++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid Dawn zip entry");
    const length = zip.readUInt16LE(offset + 28);
    const entryName = zip.toString("utf8", offset + 46, offset + 46 + length);
    if (entryName === name) {
      const local = zip.readUInt32LE(offset + 42);
      if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error("Invalid Dawn zip local entry");
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const compressed = zip.subarray(start, start + zip.readUInt32LE(offset + 20));
      const method = zip.readUInt16LE(offset + 10);
      const bytes = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
      if (!bytes || bytes.length !== zip.readUInt32LE(offset + 24)) throw new Error("Invalid Dawn license compression");
      return bytes.toString("utf8").replaceAll("\r\n", "\n");
    }
    offset += 46 + length + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  }
  throw new Error(`Missing Dawn license in zip: ${name}`);
}

function defangConflictMarkerRules(text) {
  return text.replace(/^=+$/gmu, (rule) => "-".repeat(rule.length));
}

function adaptSource(source, file) {
  assertLf(source, file);
  if (file === "src/worker.ts") {
    source = replaceOnce(source, "  createWorker,\n", "");
    source = replaceOnce(source, /import \{\n  LLAMA_CPP_WORKER_CODE,\n  WLLAMA_EMSCRIPTEN_CODE,\n\} from '\.\/workers-code\/generated';/gu, "");
    source = replaceOnce(source, /const JSPI_STUB = `[\s\S]*?`;/gu, "");
    source = replaceOnce(source, /  async getModuleCode\(\): Promise<string> \{[\s\S]*?(?=  async moduleInit\()/gu, "");
    source = replaceOnce(source, /    let moduleCode = JSPI_STUB[\s\S]*?this\.worker = createWorker\(completeCode\);/gu,
      '    this.worker = new Worker(new URL("/wllama/wllama-worker.js", self.location.origin), { type: "module" });');
    // module.init uses the script Blob only for pthreads. The static worker has
    // its module code already and nbThread=0, so no script Blob is transferred.
    source = replaceOnce(source, "new Blob([moduleCode], { type: 'text/javascript' }),", "null,");
  } else if (file === "src/storage/opfs.ts") {
    source = replaceOnce(source, "import { createWorker, isSafariMobile }", "import { isSafariMobile }");
    source = replaceOnce(source, "import { OPFS_UTILS_WORKER_CODE } from '../workers-code/generated';", "");
    source = replaceOnce(source, "createWorker(OPFS_UTILS_WORKER_CODE)",
      'new Worker(new URL("/wllama/wllama-opfs.js", self.location.origin), { type: "module" })');
  } else if (file === "src/utils.ts") {
    source = replaceOnce(source, /export const createWorker = \(workerCode: string \| Blob\): Worker => \{[\s\S]*?\n\};/gu, "");
  }
  return source;
}
const adapted = new Map(["src/worker.ts", "src/storage/opfs.ts", "src/utils.ts"]
  .map((file) => [file, adaptSource(text(file), file)]));
const licenses = {
  LICENSE: text("LICENCE"),
  "LICENSE.llama.cpp": text("llama.cpp/LICENSE"),
  "LICENSE.dawn": zipEntry("emdawnwebgpu_pkg/webgpu_cpp/LICENSE"),
  "LICENSE.emscripten": defangConflictMarkerRules(zipEntry("emdawnwebgpu_pkg/webgpu/src/LICENSE")),
};
if (dryRun) {
  console.log("Dry run: pins, CR detection, CSP adaptations and licenses verified; no files written");
} else {
  const temporaryRoot = join(root, ".wllama-build");
  mkdirSync(temporaryRoot, { recursive: true });
  const stage = mkdtempSync(join(temporaryRoot, "package-"));
  const require = createRequire(join(work, "package.json"));
  const { build } = await import(pathToFileURL(require.resolve("tsup")).href);
  const previousDirectory = process.cwd();
  process.chdir(work);
  try {
    await build({
      // tsup resolves entries as globs; a Windows absolute path never matches.
      entry: ["src/index.ts"],
      outDir: stage,
      tsconfig: join(work, "tsconfig.build.json"),
      config: false, format: ["esm"], platform: "browser", target: "esnext",
      dts: true, splitting: false, sourcemap: false, minify: false,
      outExtension: () => ({ js: ".js" }),
      esbuildPlugins: [{
        name: "x-jimaku-static-workers",
        setup(build) {
          build.onLoad({ filter: /(?:worker|opfs|utils)\.ts$/ }, ({ path }) => {
            for (const [file, contents] of adapted) {
              if (resolve(path) === resolve(work, file)) return { contents, loader: "ts", resolveDir: dirname(path) };
            }
          });
        },
      }],
    });
  } finally {
    process.chdir(previousDirectory);
  }
  const contents = {
    ...licenses,
    "wllama-worker.js": staticWorker + "\n",
    "wllama-opfs.js": opfsWorker + "\n",
    "wllama.wasm": readFileSync(join(work, "src/wasm/wllama.wasm")),
    "index.js": readFileSync(join(stage, "index.js"), "utf8"),
    "index.d.ts": readFileSync(join(stage, "index.d.ts"), "utf8"),
  };
  for (const name of vendorFiles) writeFileSync(join(stage, name), contents[name]);
  const manifest = { ...pins, files: Object.fromEntries(vendorFiles.map((name) => [name, fileIdentity(readFileSync(join(stage, name)))])) };
  writeFileSync(join(stage, "SOURCE.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  verifyVendor(stage);
  const destination = join(root, "vendor/wllama");
  mkdirSync(destination, { recursive: true });
  const expected = [...vendorFiles, "SOURCE.json"];
  if (readdirSync(destination).some((name) => !expected.includes(name))) throw new Error("Unexpected existing vendor/wllama files; inspect before replacing");
  for (const name of expected) copyFileSync(join(stage, name), join(destination, name));
  verifyVendor(destination);
  console.log("Packaged and verified vendor/wllama (SHA-256 and byte sizes in SOURCE.json)");
}
