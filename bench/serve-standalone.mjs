import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBenchServer } from "./serve.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const server = await startBenchServer({
  directory: root,
  mediaFile: path.join(here, "refs", "tts-speech.wav"),
  contextTerms: [],
});

console.log(`[serve-standalone] ${server.caseUrl}`);
