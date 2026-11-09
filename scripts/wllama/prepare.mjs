import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pins } from "./pins.mjs";

if (process.argv[2] === "--verify-zip") {
  const hash = createHash("sha256").update(readFileSync(process.argv[3])).digest("hex");
  if (hash !== pins.dawnSha256) throw new Error("Dawn zip SHA-256 mismatch");
  console.log("Dawn zip SHA-256 verified");
} else {
  if (!process.env.WLLAMA_WORK) throw new Error("Set WLLAMA_WORK");
  const file = resolve(process.env.WLLAMA_WORK, "scripts/docker-compose.yml");
  let source = readFileSync(file, "utf8");
  if (source.includes("\r")) throw new Error("CR in compose file; clone with core.autocrlf=false");
  const edits = [
    ['FROM emscripten/emsdk:$${EMSDK_IMAGE_TAG}', `FROM ${pins.emsdkImage}`],
    ['      - SKIP_COMPAT=${SKIP_COMPAT:-}', [
      '      - SKIP_COMPAT=${SKIP_COMPAT:-}',
      '      - GIT_CONFIG_COUNT=1',
      '      - GIT_CONFIG_KEY_0=safe.directory',
      '      - GIT_CONFIG_VALUE_0=*',
    ].join('\n')],
    ['        curl -L -o emdawn.zip \\',
      '        python3 -c "import zipfile,sys; sys.exit(0 if zipfile.is_zipfile(\'emdawn.zip\') else 1)" || curl -L -o emdawn.zip \\'],
  ];
  for (const [before, after] of edits) {
    if (source.split(after).length === 2) continue;
    if (source.split(before).length !== 2) throw new Error(`Compose patch did not apply exactly once: ${before}`);
    source = source.replace(before, () => after);
  }
  if (!source.includes(`DAWN_TAG=${pins.dawnTag}\n`)) throw new Error("Unexpected upstream Dawn tag");
  writeFileSync(file, source, "utf8");
}
