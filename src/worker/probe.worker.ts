import {
  getProbeEnvironment,
  isMessageOfType,
  nowIso,
  toProbeError,
  type AdapterInfo,
  type WebGpuProbeResult,
  type WorkerProbeResultMessage,
} from "../shared/messages";

interface GpuLike {
  requestAdapter(): Promise<GpuAdapterLike | null>;
}

interface GpuAdapterLike {
  readonly info?: unknown;
}

interface WorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  postMessage(message: WorkerProbeResultMessage): void;
}

const workerScope =
  globalThis as unknown as WorkerScope;

console.log("[worker]", "probe worker ready");

workerScope.addEventListener(
  "message",
  (event: MessageEvent<unknown>): void => {
    if (!isMessageOfType(event.data, "WORKER_PROBE")) {
      return;
    }

    const { requestId } = event.data;
    console.log("[worker]", "WebGPU probe requested", requestId);

    void probeWebGpu().then((result) => {
      const response: WorkerProbeResultMessage = {
        t: "WORKER_PROBE_RESULT",
        requestId,
        result,
      };

      console.log("[worker]", "WebGPU probe complete", result);
      workerScope.postMessage(response);
    });
  },
);

async function probeWebGpu(): Promise<WebGpuProbeResult> {
  const startedAt = nowIso();
  const gpu = (
    navigator as Navigator & {
      gpu?: GpuLike;
    }
  ).gpu;

  if (gpu === undefined) {
    return {
      context: "dedicated-worker",
      apiAvailable: false,
      adapterAvailable: false,
      startedAt,
      completedAt: nowIso(),
      environment: getProbeEnvironment(),
    };
  }

  try {
    const adapter = await gpu.requestAdapter();

    return {
      context: "dedicated-worker",
      apiAvailable: true,
      adapterAvailable: adapter !== null,
      ...(adapter === null
        ? {}
        : {
            adapterInfo: readAdapterInfo(adapter),
          }),
      startedAt,
      completedAt: nowIso(),
      environment: getProbeEnvironment(),
    };
  } catch (error) {
    return {
      context: "dedicated-worker",
      apiAvailable: true,
      adapterAvailable: false,
      startedAt,
      completedAt: nowIso(),
      environment: getProbeEnvironment(),
      error: toProbeError(error),
    };
  }
}

function readAdapterInfo(
  adapter: GpuAdapterLike,
): AdapterInfo | undefined {
  const rawInfo = adapter.info;

  if (
    typeof rawInfo !== "object" ||
    rawInfo === null
  ) {
    return undefined;
  }

  const record = rawInfo as Record<string, unknown>;
  const vendor = nonEmptyString(record.vendor);
  const architecture = nonEmptyString(
    record.architecture,
  );

  if (
    vendor === undefined &&
    architecture === undefined
  ) {
    return undefined;
  }

  return {
    ...(vendor === undefined ? {} : { vendor }),
    ...(architecture === undefined
      ? {}
      : { architecture }),
  };
}

function nonEmptyString(
  value: unknown,
): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value
    : undefined;
}
