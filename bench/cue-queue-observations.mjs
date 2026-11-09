// The value at stop walks samples and queue events in time order. A rise in the
// overlay's cueDiscards counter means clear() or disposal threw away that many
// waiting cues, so the cues left at stop are that rise, not the 0 that follows.
function waitingAtStop(timeline, changes) {
  const rows = [...timeline.map(row => ({ ...row, event: false })), ...changes.map(row => ({ ...row, event: true }))]
    .filter(row => Number.isFinite(row.waitingCues))
    .sort((a, b) => a.sampledAtMs - b.sampledAtMs);
  let atStop = null;
  let waiting = null;
  let discards = 0;
  for (const row of rows) {
    const rise = row.event && Number.isFinite(row.cueDiscards) ? row.cueDiscards - discards : 0;
    if (row.event && Number.isFinite(row.cueDiscards)) discards = Math.max(discards, row.cueDiscards);
    if (rise > 0) atStop = rise;
    else if (row.waitingCues !== waiting || atStop === null) atStop = row.waitingCues;
    waiting = row.waitingCues;
  }
  return atStop;
}

export function cueQueueObservations({ samples = [], events = [], drops, replayStartedAtMs }) {
  const inRun = row => Number.isFinite(row.sampledAtMs) && row.sampledAtMs >= replayStartedAtMs;
  const timeline = samples.filter(inRun).filter(row => Number.isFinite(row.waitingCues))
    .map(({ sampledAtMs, waitingCues }) => ({ sampledAtMs, waitingCues }));
  const counts = timeline.map(row => row.waitingCues).sort((a, b) => a - b);
  const changes = events.filter(inRun);
  const maximum = (rows, key) => rows.reduce((max, row) => Math.max(max, Number.isFinite(row[key]) ? row[key] : 0), 0);
  return {
    cueQueue: { samples: timeline.length, timeline,
      maxWaitingCues: timeline.length || changes.length ? maximum([...timeline, ...changes], "waitingCues") : null,
      p90WaitingCues: counts.length ? counts[Math.min(counts.length - 1, Math.floor(counts.length * 0.9))] : null,
      waitingAtStop: waitingAtStop(timeline, changes) },
    cueDrops: Array.isArray(drops) ? Math.max(drops.length, maximum(changes, "cueDrops"))
      : changes.length ? maximum(changes, "cueDrops") : null,
    cueMerges: changes.length ? maximum(changes, "cueMerges") : timeline.length ? 0 : null,
    cueDiscards: changes.length ? maximum(changes, "cueDiscards") : null,
  };
}
