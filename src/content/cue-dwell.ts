import {
  CUE_ACCELERATED_DISPLAY_MS,
  CUE_MINIMUM_DISPLAY_MS,
} from "../shared/explicit-stop-drain";

export interface CueDwellPolicy {
  dwellFloorMs: number;
  dwellRate: number;
  dwellAccelFloorMs: number;
  dwellAccelRate: number;
}

export const DEFAULT_CUE_DWELL_POLICY: Readonly<CueDwellPolicy> = Object.freeze({
  dwellFloorMs: CUE_MINIMUM_DISPLAY_MS,
  dwellRate: 0,
  dwellAccelFloorMs: CUE_ACCELERATED_DISPLAY_MS,
  dwellAccelRate: 0,
});

export function readCueDwellPolicy(value: unknown): CueDwellPolicy | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const policy = { ...DEFAULT_CUE_DWELL_POLICY };
  for (const key of Object.keys(policy) as (keyof CueDwellPolicy)[]) {
    const number = candidate[key];
    if (typeof number !== "number" || !Number.isFinite(number) || number < 0) return null;
    policy[key] = number;
  }
  return policy;
}

export function cueDwellMs(
  lines: readonly string[],
  accelerated: boolean,
  policy: Readonly<CueDwellPolicy> = DEFAULT_CUE_DWELL_POLICY,
): number {
  const floor = accelerated ? policy.dwellAccelFloorMs : policy.dwellFloorMs;
  const rate = accelerated ? policy.dwellAccelRate : policy.dwellRate;
  const characters = lines.reduce((sum, line) => sum + Array.from(line).length, 0);
  return rate === 0 ? floor : Math.max(floor, characters * 1000 / rate);
}
