import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBenchServer } from "./serve.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const caseName = process.argv[2] ?? "tts";

const cases = {
  tts: {
    mediaFile: path.join(here, "refs", "tts-speech.wav"),
    contextTerms: [],
  },
  tts2: {
    mediaFile: path.join(here, "refs", "tts2-speech.wav"),
    contextTerms: [
      "Roman",
      "NASA Goddard",
      "Kennedy Space Center",
      "coronagraph",
    ],
  },
};

const definition = cases[caseName];

if (definition === undefined) {
  console.error(
    `[serve-standalone] unknown case: ${caseName} (known: ${Object.keys(cases).join(", ")})`,
  );
  process.exit(2);
}

const server = await startBenchServer({
  directory: root,
  mediaFile: definition.mediaFile,
  contextTerms: definition.contextTerms,
});

console.log(`[serve-standalone] case=${caseName} ${server.caseUrl}`);
