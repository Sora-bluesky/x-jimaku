export const absoluteNow = (): number => performance.timeOrigin + performance.now();

export interface LatencyTrace {
  segmentId?: string;
  segmentIds?: string[];
  clauseId?: string;
  speechStartAtMs?: number;
  segmentClosedAtMs?: number;
  closeReason?: string;
  whisperFinalAtMs?: number;
  finalizedAtMs?: number;
  enqueuedAtMs?: number;
  contextReadyAtMs?: number;
  plamoStartAtMs?: number;
  plamoEndAtMs?: number;
  settledAtMs?: number;
  disposition?: "translated" | "untranslated" | "queue-drop";
}

export function isLatencyTrace(value: unknown): value is LatencyTrace {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const trace = value as Record<string, unknown>;
  return Object.entries(trace).every(([key, field]) => {
    if (key === "segmentIds") return Array.isArray(field) && field.every(id => typeof id === "string");
    if (["segmentId", "clauseId", "closeReason"].includes(key)) return typeof field === "string";
    if (key === "disposition") return ["translated", "untranslated", "queue-drop"].includes(String(field));
    return ["speechStartAtMs", "segmentClosedAtMs", "whisperFinalAtMs", "finalizedAtMs", "enqueuedAtMs", "contextReadyAtMs", "plamoStartAtMs", "plamoEndAtMs", "settledAtMs"].includes(key)
      && typeof field === "number" && Number.isFinite(field) && field >= 0;
  });
}
