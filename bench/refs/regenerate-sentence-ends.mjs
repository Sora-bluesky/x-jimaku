import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// These fragments deliberately match the parent's audio-based recount, including
// ASR pages containing only part of a script sentence.
const matchTexts = {
  tts2: ["ready for launch", "map wide regions", "final checks", "faint planets", "see the universe"],
  tts: ["welcome back to the channel", "neural networks actually work", "surprisingly simple"],
};
const cases = process.argv.slice(2).filter(arg => arg !== "--check");
const check = process.argv.includes("--check");

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw new Error(`${command} is required on PATH: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr}`);
  return result;
}

try {
  for (const name of cases.length ? cases : Object.keys(matchTexts)) {
    if (!Object.hasOwn(matchTexts, name)) throw new Error(`unsupported fixture: ${name}`);
    const wav = `${name}-speech.wav`;
    const script = `${name}-script.txt`;
    const wavPath = fileURLToPath(new URL(wav, import.meta.url));
    const scriptBytes = readFileSync(new URL(script, import.meta.url));
    const sentences = scriptBytes.toString("utf8").match(/[^.!?]+[.!?]+/gu)?.map(s => s.trim()) ?? [];
    const durationSeconds = Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", wavPath]).stdout.trim());
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("invalid WAV duration");
    const filter = "silencedetect=noise=-35dB:d=0.25";
    const detected = run("ffmpeg", ["-hide_banner", "-i", wavPath, "-af", filter, "-f", "null", "-"]);
    const silences = [...detected.stderr.matchAll(/silence_start: ([\d.]+)[\s\S]*?silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/gu)]
      .map(([, start, end, duration]) => ({ startSeconds: Number(start), endSeconds: Number(end), durationSeconds: Number(duration) }));
    const sentenceSilenceMinSeconds = 0.75;
    const ends = silences.filter(s => s.durationSeconds >= sentenceSilenceMinSeconds);
    if (ends.length !== sentences.length || sentences.length !== matchTexts[name].length) {
      throw new Error(`${name}: ${ends.length} sentence silences for ${sentences.length} script sentences; inspect alignment`);
    }
    const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
    const table = {
      fixture: name, wav, script, durationSeconds,
      wavSha256: sha256(readFileSync(wavPath)), scriptSha256: sha256(scriptBytes),
      command: `ffmpeg -hide_banner -i bench/refs/${wav} -af ${filter} -f null -`,
      thresholds: { noiseDb: -35, detectionMinSeconds: 0.25, sentenceSilenceMinSeconds },
      alignment: "Script sentences in order; sentence end is the start of each silence >= 0.75 s. Shorter pauses are inside sentences.",
      silences,
      sentences: sentences.map((text, index) => ({ text, matchText: matchTexts[name][index], endSeconds: ends[index].startSeconds })),
    };
    const output = new URL(`${name}-sentence-ends.json`, import.meta.url);
    const bytes = `${JSON.stringify(table, null, 2)}\n`;
    if (check) {
      if (readFileSync(output, "utf8") !== bytes) throw new Error(`${name}: stored sentence-end table differs; regenerate it`);
    } else writeFileSync(output, bytes, "utf8");
    console.log(`${name}: ${sentences.length} sentence ends ${check ? "verified" : "written"}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
