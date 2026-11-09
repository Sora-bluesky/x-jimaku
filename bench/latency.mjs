export const R1_LIMITS_MS = Object.freeze({ p50: 3000, p90: 5000 });

const finite = Number.isFinite;
const japanese = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const percentile = (values, q) => values.length
  ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))]
  : null;
const distribution = values => ({ samples: values.length, p50: percentile(values, 0.5), p90: percentile(values, 0.9) });
const first = values => values.length ? Math.min(...values) : null;
const last = values => values.length ? Math.max(...values) : null;
const timestamp = (numeric, iso) => finite(numeric) ? numeric : Date.parse(iso);

export function captionDwell(pages = []) {
  const rows = pages.flatMap(page => {
    const start = timestamp(page.displayStartAtMs, page.appearedAt);
    const end = timestamp(page.displayEndAtMs, page.replacedAt);
    if (!finite(start) || !finite(end) || end <= start) return [];
    const lines = [page.line0 ?? "", page.line1 ?? ""].filter(line => line !== "");
    const lengths = lines.map(line => Array.from(line).length);
    const characters = lengths.reduce((sum, length) => sum + length, 0);
    const shownSeconds = (end - start) / 1000;
    return [{ cueId: page.cueId, pageId: page.pageId, displayStartAtMs: start, displayEndAtMs: end,
      shownSeconds, characters, charsPerSecond: characters / shownSeconds,
      lines: lines.length, maxCharactersPerLine: Math.max(0, ...lengths) }];
  });
  const dwell = rows.map(row => row.shownSeconds * 1000);
  const speeds = rows.filter(row => row.characters > 0).map(row => row.charsPerSecond);
  return { pages: rows, closedPages: rows.length, openPages: pages.filter(page =>
    !finite(timestamp(page.displayEndAtMs, page.replacedAt))).length,
  dwellMsP10: percentile(dwell, 0.1), dwellMsP50: percentile(dwell, 0.5), dwellMsP90: percentile(dwell, 0.9),
  charsPerSecondP50: percentile(speeds, 0.5), charsPerSecondP90: percentile(speeds, 0.9) };
}

export function readingSpeed(rows = []) {
  const shownSeconds = rows.reduce((sum, row) => sum + row.shownSeconds, 0);
  const above = threshold => {
    const selected = rows.filter(row => row.charsPerSecond > threshold);
    const seconds = selected.reduce((sum, row) => sum + row.shownSeconds, 0);
    return { pages: selected.length, shownSeconds: seconds,
      pageShare: rows.length ? selected.length / rows.length : null,
      shownTimeShare: shownSeconds > 0 ? seconds / shownSeconds : null };
  };
  return { pages: rows.length, shownSeconds, above7: above(7), above4: above(4) };
}

const STAGE_GAPS = {
  speechToClose: ["speechStartAtMs", "segmentClosedAtMs"],
  closeToWhisper: ["segmentClosedAtMs", "whisperFinalAtMs"],
  whisperToEnqueue: ["whisperFinalAtMs", "enqueuedAtMs"],
  enqueueToContext: ["enqueuedAtMs", "contextReadyAtMs"],
  contextToPlamo: ["contextReadyAtMs", "plamoStartAtMs"],
  plamo: ["plamoStartAtMs", "plamoEndAtMs"],
  plamoToDisplay: ["plamoEndAtMs", "displayStartAtMs"],
  closeToDisplay: ["segmentClosedAtMs", "displayStartAtMs"],
};

export function joinLatency({ devLog = [], pages = [], replayStartedAtMs }) {
  const segments = new Map();
  const clauses = new Map();
  for (const entry of devLog) {
    const trace = entry.data?.kind === "latency" ? entry.data.trace : null;
    if (!trace) continue;
    const map = trace.clauseId ? clauses : segments;
    const id = trace.clauseId ?? trace.segmentId;
    if (typeof id !== "string") continue;
    map.set(id, { ...map.get(id), ...trace });
  }
  const pageByClause = new Map();
  for (const page of pages) {
    const clauseIds = [...new Set((page.sources ?? []).flatMap(source => source.clauseIds ?? []))];
    for (const clauseId of clauseIds) {
      const list = pageByClause.get(clauseId) ?? [];
      list.push({ cueId: page.cueId, pageId: page.pageId, clauseIds,
        displayStartAtMs: timestamp(page.displayStartAtMs, page.appearedAt),
        displayEndAtMs: finite(timestamp(page.displayEndAtMs, page.replacedAt))
          ? timestamp(page.displayEndAtMs, page.replacedAt) : null,
        japanese: !page.fallback && japanese.test(`${page.line0 ?? ""}${page.line1 ?? ""}`) });
      pageByClause.set(clauseId, list);
    }
  }
  const used = new Set([...clauses.values()].flatMap(clause => clause.segmentIds ?? []));
  const records = [...clauses.values(), ...[...segments.values()].filter(segment => !used.has(segment.segmentId))];
  const utterances = records.map(record => {
    const segmentIds = record.segmentIds ?? (record.segmentId ? [record.segmentId] : []);
    const sourceSegments = segmentIds.map(id => segments.get(id) ?? { segmentId: id });
    const pageRecords = pageByClause.get(record.clauseId) ?? [];
    const shown = pageRecords.filter(page => page.japanese && finite(page.displayStartAtMs));
    const field = name => sourceSegments.map(segment => segment[name]).filter(finite);
    const row = { ...record, segmentIds, segments: sourceSegments, pages: pageRecords,
      speechStartAtMs: first(field("speechStartAtMs")),
      segmentClosedAtMs: sourceSegments.length && sourceSegments.every(segment => finite(segment.segmentClosedAtMs))
        ? last(field("segmentClosedAtMs")) : null,
      whisperFinalAtMs: finite(record.whisperFinalAtMs) ? record.whisperFinalAtMs : last(field("whisperFinalAtMs")),
      displayStartAtMs: first(shown.map(page => page.displayStartAtMs)),
      displayEndAtMs: shown.length && shown.every(page => finite(page.displayEndAtMs))
        ? last(shown.map(page => page.displayEndAtMs)) : null,
    };
    // Clauses use exactly the ASR-finalization window used by selectGatePages.
    // Unassembled audio has no such line; keep it and expose that evidence separately.
    const captureAtMs = record.clauseId ? record.finalizedAtMs : row.whisperFinalAtMs;
    row.inCaptureWindow = finite(replayStartedAtMs) && finite(captureAtMs) && captureAtMs > replayStartedAtMs;
    row.captureTimeSource = record.clauseId ? "finalizedAtMs" : "whisperFinalAtMs";
    row.missingCaptureTime = !finite(captureAtMs);
    row.status = record.disposition === "queue-drop" ? "dropped"
      : record.disposition === "untranslated" ? "untranslated"
      : shown.length ? "shown" : "never-shown";
    row.gapsMs = Object.fromEntries(Object.entries(STAGE_GAPS).map(([name, [from, to]]) =>
      [name, finite(row[from]) && finite(row[to]) ? row[to] - row[from] : null]));
    return row;
  });
  const eligible = utterances.filter(row => row.inCaptureWindow);
  const gaps = Object.fromEntries(Object.keys(STAGE_GAPS).map(name => [name,
    distribution(eligible.map(row => row.gapsMs[name]).filter(finite))]));
  const missing = {
    dropped: eligible.filter(row => row.status === "dropped").length,
    untranslated: eligible.filter(row => row.status === "untranslated").length,
    neverShown: eligible.filter(row => row.status === "never-shown").length,
    captureTime: utterances.filter(row => row.missingCaptureTime).length,
    closeToDisplay: eligible.filter(row => !finite(row.gapsMs.closeToDisplay)).length,
  };
  return { utterances, summary: { utterances: eligible.length, excluded: utterances.length - eligible.length,
    gapsMs: gaps, missing, closeToDisplay: gaps.closeToDisplay } };
}
