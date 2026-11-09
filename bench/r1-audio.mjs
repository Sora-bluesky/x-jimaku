import { readFileSync } from "node:fs";
import { R1_LIMITS_MS } from "./latency.mjs";

export function loadSentenceEnds(caseName) {
  if (caseName !== "tts" && caseName !== "tts2") return null;
  return JSON.parse(readFileSync(new URL(`./refs/${caseName}-sentence-ends.json`, import.meta.url), "utf8"));
}

// The last matching SCRIPT sentence (highest index), as in the reference recount.
// Preserve its fragment matching; requiring an entire sentence loses ASR clauses.
export function matchSentence(sourceText, fixture) {
  const source = String(sourceText ?? "").toLowerCase();
  return fixture.sentences.findLastIndex(sentence => source.includes(sentence.matchText.toLowerCase()));
}

export function summarizeR1Audio(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = q => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null;
  const p50 = quantile(0.5);
  const p90 = quantile(0.9);
  const p50Pass = sorted.length ? p50 <= R1_LIMITS_MS.p50 : null;
  const p90Pass = sorted.length ? p90 <= R1_LIMITS_MS.p90 : null;
  return { samples: sorted.length, p50, p90, limitsMs: R1_LIMITS_MS, p50Pass, p90Pass,
    pass: sorted.length ? p50Pass && p90Pass : null };
}

export function computeR1Audio({ pages = [], shownPages = [], replayStartedAtMs, mediaPlayback, fixture }) {
  const validMediaClock = Number.isFinite(mediaPlayback?.observedAtMs)
    && Number.isFinite(mediaPlayback?.currentTimeSeconds) && mediaPlayback.currentTimeSeconds >= 0;
  const audioStartedAtMs = validMediaClock
    ? mediaPlayback.observedAtMs - mediaPlayback.currentTimeSeconds * 1000 : replayStartedAtMs;
  const clock = { audioStartedAtMs, source: validMediaClock ? "media-currentTime" : "replayStartedAt",
    upperBound: !validMediaClock,
    note: validMediaClock ? "Media epoch inferred from playing/currentTime observation."
      : "No media clock saved; replayStartedAt is the audio origin. Latency is an upper bound if playback starts later." };
  const byPage = new Map(pages.map(page => [`${page.cueId}\0${page.pageId}`, page]));
  const samples = [];
  const unmatched = { sourcePage: 0, sentence: 0, displayTime: 0, audioOccurrence: 0 };
  for (const shown of shownPages) {
    const page = byPage.get(`${shown.cueId}\0${shown.pageId}`);
    if (!page) { unmatched.sourcePage++; continue; }
    const index = fixture ? matchSentence(page.sourceText, fixture) : -1;
    if (index < 0) { unmatched.sentence++; continue; }
    if (!Number.isFinite(shown.displayStartAtMs) || !Number.isFinite(audioStartedAtMs)) {
      unmatched.displayTime++; continue;
    }
    // The fixture table has microsecond precision. Integer microseconds prevent
    // subtraction noise at an exact sentence end from selecting the prior loop.
    const endUs = Math.round(fixture.sentences[index].endSeconds * 1e6);
    const loopUs = Math.round(fixture.durationSeconds * 1e6);
    const elapsedUs = Math.round((shown.displayStartAtMs - audioStartedAtMs) * 1000);
    const loop = Math.floor((elapsedUs - endUs) / loopUs);
    const sentenceEndUs = loop * loopUs + endUs;
    const latencyUs = elapsedUs - sentenceEndUs;
    if (sentenceEndUs < 0 || latencyUs < 0 || latencyUs >= loopUs) {
      unmatched.audioOccurrence++; continue;
    }
    const sentenceEndAtMs = audioStartedAtMs + sentenceEndUs / 1000;
    samples.push({ cueId: shown.cueId, pageId: shown.pageId, sentenceIndex: index, loop,
      displayStartAtMs: shown.displayStartAtMs, sentenceEndAtMs,
      latencyMs: latencyUs / 1000 });
  }
  return { ...summarizeR1Audio(samples.map(sample => sample.latencyMs)),
    fixture: fixture?.fixture ?? null, clock, matchedPages: samples.length,
    unmatchedPages: Object.values(unmatched).reduce((sum, count) => sum + count, 0), unmatched,
    unsupportedFixture: !fixture, pages: samples };
}

export function recountR1Audio(result) {
  if (!Array.isArray(result.observations?.captionLogDwell?.pages)) {
    throw new Error("missing observations.captionLogDwell.pages for measured-window audio latency");
  }
  return computeR1Audio({ pages: result.display?.pages ?? [],
    shownPages: result.observations.captionLogDwell.pages,
    replayStartedAtMs: Date.parse(result.replayStartedAt), mediaPlayback: result.mediaPlayback,
    fixture: loadSentenceEnds(result.case) });
}
