import { describe, expect, it } from "vitest";
import { computeR1Audio, loadSentenceEnds, matchSentence, recountR1Audio, summarizeR1Audio } from "./r1-audio.mjs";

const fixture = loadSentenceEnds("tts2");
const replayStartedAtMs = 100000;
const page = (text, cueId = "cue", pageId = "0") => ({ cueId, pageId, sourceText: text });
const shown = (seconds, cueId = "cue", pageId = "0") => ({ cueId, pageId,
  displayStartAtMs: replayStartedAtMs + seconds * 1000 });
const compute = options => computeR1Audio({ fixture, replayStartedAtMs, ...options });

describe("audio sentence-end R1", () => {
  it("matches the reference fragments case-insensitively and picks the last script sentence", () => {
    expect(matchSentence("READY FOR LAUNCH", fixture)).toBe(0);
    expect(matchSentence("final checks and faint planets", fixture)).toBe(3);
    // Reference algorithm chooses the highest script index even across a text wrap.
    expect(matchSentence("see the universe. ready for launch", fixture)).toBe(4);
    expect(matchSentence("Roman carries a coronagraph", fixture)).toBe(-1);
    expect(matchSentence(null, fixture)).toBe(-1);
  });

  it("measures from audio, retaining each physical shown page and the latest loop end", () => {
    const result = compute({ pages: [page("ready for launch"), page("ready for launch", "cue", "1"),
      page("see the universe", "last")], shownPages: [shown(4), shown(28, "cue", "1"), shown(24, "last")] });
    expect(result).toMatchObject({ matchedPages: 3, unmatchedPages: 0, samples: 3 });
    expect(result.pages[0].latencyMs).toBeCloseTo(1321.315, 6);
    expect(result.pages[1]).toMatchObject({ loop: 1, sentenceIndex: 0 });
    expect(result.pages[1].latencyMs).toBeCloseTo(2206.077, 6);
    expect(result.pages[2]).toMatchObject({ loop: 0, sentenceIndex: 4 });
    expect(result.pages[2].latencyMs).toBeCloseTo(1642.585, 6);
    expect(result.p50).toBeCloseTo(1642.585, 6);
    expect(result.p90).toBeCloseTo(2206.077, 6);
  });

  it("excludes sentence ends before playback and retains real loop boundaries", () => {
    const result = compute({ pages: [page("ready for launch")], shownPages: [shown(1), shown(2.678685),
      shown(23.115238 + 2.678685), shown(2 * 23.115238 + 2.678685 + 1), shown(27)] });
    expect(result).toMatchObject({ samples: 4, unmatchedPages: 1, unmatched: { audioOccurrence: 1 } });
    expect(result.pages.map(row => row.loop)).toEqual([0, 1, 2, 1]);
    expect(result.pages.map(row => row.latencyMs)).toEqual([0, 0, 1000, 1206.077]);
    expect(result.pages.every(row => row.sentenceEndAtMs >= replayStartedAtMs
      && row.latencyMs >= 0 && row.latencyMs < fixture.durationSeconds * 1000)).toBe(true);
  });

  it("counts early first-loop pages and pages before the media origin as unmatched", () => {
    const end = fixture.sentences[0].endSeconds;
    const result = compute({ pages: [page("ready for launch")],
      shownPages: [-fixture.durationSeconds, 0, end - 0.000001, end].map(seconds => shown(seconds)) });
    expect(result).toMatchObject({ samples: 1, unmatchedPages: 3, unmatched: { audioOccurrence: 3 }, p50: 0, p90: 0 });
    expect(result.pages[0]).toMatchObject({ loop: 0, latencyMs: 0 });
  });

  it("counts unmatched source, sentence and time evidence without adding zero samples", () => {
    const result = compute({ pages: [page("unknown"), page("final checks", "invalid")],
      shownPages: [shown(10), shown(10, "absent"), { ...shown(10, "invalid"), displayStartAtMs: NaN }] });
    expect(result).toMatchObject({ samples: 0, matchedPages: 0, unmatchedPages: 3,
      unmatched: { sourcePage: 1, sentence: 1, displayTime: 1 }, p50: null, p90: null, pass: null });
    expect(compute({ pages: [], shownPages: [] }).pass).toBeNull();
    expect(compute({ fixture: null, pages: [page("ready for launch")], shownPages: [shown(4)] }))
      .toMatchObject({ unsupportedFixture: true, unmatchedPages: 1, pass: null });
  });

  it("distinguishes one microsecond before and after an end on an epoch clock", () => {
    const origin = Date.parse("2026-11-09T00:00:00Z");
    const endMs = (23.115238 + 2.678685) * 1000;
    const result = compute({ replayStartedAtMs: origin, pages: [page("ready for launch")],
      shownPages: [-0.001, 0, 0.001].map(delta => ({ ...shown(0), displayStartAtMs: origin + endMs + delta })) });
    expect(result.pages.map(row => row.loop)).toEqual([0, 1, 1]);
    expect(result.pages.map(row => row.latencyMs)).toEqual([23115.237, 0, 0.001]);
  });

  it("corrects delayed playback using playing/currentTime and labels legacy clocks", () => {
    const options = { pages: [page("ready for launch")], shownPages: [shown(4)] };
    const legacy = compute(options);
    const corrected = compute({ ...options,
      mediaPlayback: { observedAtMs: replayStartedAtMs + 500, currentTimeSeconds: 0.1 } });
    expect(legacy.clock).toMatchObject({ source: "replayStartedAt", upperBound: true });
    expect(corrected.clock).toMatchObject({ source: "media-currentTime", upperBound: false,
      audioStartedAtMs: replayStartedAtMs + 400 });
    expect(corrected.p50).toBeCloseTo(legacy.p50 - 400, 6);
    expect(compute({ ...options, mediaPlayback: { observedAtMs: NaN, currentTimeSeconds: 0 } }).clock.upperBound).toBe(true);
  });

  it("recounts only saved measured-window dwell pages, joining by cue AND page ID", () => {
    const result = recountR1Audio({ case: "tts2", replayStartedAt: new Date(replayStartedAtMs).toISOString(),
      display: { pages: [page("ready for launch"), page("final checks", "cue", "1"), page("see the universe", "warmup")] },
      observations: { captionLogDwell: { pages: [shown(4)] } } });
    expect(result).toMatchObject({ samples: 1, unmatchedPages: 0 });
    expect(result.p50).toBeCloseTo(1321.315, 6);
    expect(() => recountR1Audio({})).toThrow("missing observations.captionLogDwell.pages");
  });

  it("pools page samples rather than per-run quantiles, using inclusive R1 limits in milliseconds", () => {
    const a = Array(9).fill(3000);
    const b = [5000];
    expect(summarizeR1Audio([...a, ...b])).toMatchObject({ samples: 10, p50: 3000, p90: 5000,
      p50Pass: true, p90Pass: true, pass: true });
    expect(summarizeR1Audio([...a, 5001])).toMatchObject({ p50Pass: true, p90Pass: false, pass: false });
    expect(summarizeR1Audio([3001])).toMatchObject({ p50Pass: false, pass: false });
  });

  it("also supports the three sentences of tts", () => {
    const tts = loadSentenceEnds("tts");
    expect(tts.sentences).toHaveLength(3);
    expect(tts.durationSeconds).toBe(14.123447);
    expect(compute({ fixture: tts, pages: [page("surprisingly simple")], shownPages: [shown(14)] }).p50)
      .toBeCloseTo(688.934, 6);
    expect(loadSentenceEnds("tibo")).toBeNull();
  });
});
