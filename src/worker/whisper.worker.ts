import {
  env,
  pipeline,
} from "@huggingface/transformers";
import {
  isWhisperWorkerInputMessage,
  toProbeError,
  type WhisperProgressMessage,
  type WhisperWorkerOutputMessage,
} from "../shared/messages";
import type {
  WhisperDevice,
  WhisperModel,
} from "../shared/settings";

env.allowLocalModels = false;
env.useBrowserCache = true;

type OnnxWebGpuEnvironment = {
  powerPreference?: GPUPowerPreference;
};

if (
  navigator.userAgent.includes("Windows")
) {
  const webGpuEnvironment =
    env.backends?.onnx?.webgpu as
      | OnnxWebGpuEnvironment
      | undefined;

  if (webGpuEnvironment !== undefined) {
    webGpuEnvironment.powerPreference =
      undefined;
  }
}

const INITIALIZATION_PROGRESS_CEILING = 99;

const MODELS = {
  tiny: {
    id: "onnx-community/whisper-tiny",
    dtype: {
      encoder_model: "fp32",
      decoder_model_merged: "q4",
    },
  },
  base: {
    id: "onnx-community/whisper-base",
    dtype: {
      encoder_model: "fp32",
      decoder_model_merged: "q4",
    },
  },
  small: {
    id: "onnx-community/whisper-small",
    dtype: {
      encoder_model: "fp32",
      decoder_model_merged: "q4",
    },
  },
  turbo: {
    id: "onnx-community/whisper-large-v3-turbo",
    dtype: {
      encoder_model: "fp16",
      decoder_model_merged: "q4",
    },
  },
} as const satisfies Readonly<
  Record<
    WhisperModel,
    {
      id: string;
      dtype: {
        encoder_model: "fp32" | "fp16";
        decoder_model_merged: "q4";
      };
    }
  >
>;

interface WhisperOutput {
  text: string;
}

type WhisperPipelineOutput =
  | WhisperOutput
  | WhisperOutput[];

interface WhisperAsr {
  (
    audio: Float32Array,
    options: {
      language?: "en";
      task: "transcribe";
      max_new_tokens: 96;
      return_timestamps: false;
    },
  ): Promise<WhisperPipelineOutput>;
}

interface WorkerScope {
  addEventListener(
    type: "message",
    listener: (
      event: MessageEvent<unknown>,
    ) => void,
  ): void;
  postMessage(
    message: WhisperWorkerOutputMessage,
  ): void;
}

interface GpuLike {
  requestAdapter?():
    Promise<unknown | null>;
}

interface RawProgress {
  file?: unknown;
  status?: unknown;
  progress?: unknown;
  loaded?: unknown;
  total?: unknown;
}

interface FileProgressState {
  loaded: number;
  total: number;
  fraction: number;
  complete: boolean;
}

interface AggregatedProgress {
  file: string;
  progress: number;
  loaded: number;
  total: number;
}

const workerScope =
  globalThis as unknown as WorkerScope;

let asr: WhisperAsr | null = null;
let initializedDevice:
  | WhisperDevice
  | null = null;
let forcedEnglish = true;
let initializationPromise:
  | Promise<void>
  | null = null;

console.log("[whisper]", "worker ready");

workerScope.addEventListener(
  "message",
  (event: MessageEvent<unknown>): void => {
    if (!isWhisperWorkerInputMessage(event.data)) {
      console.warn(
        "[whisper]",
        "ignored malformed worker message",
      );
      return;
    }

    if (event.data.t === "WHISPER_INIT") {
      forcedEnglish =
        event.data.sourceLang !== "auto";

      if (initializationPromise !== null) {
        postError(
          "Whisper initialization is already in progress",
          true,
        );
        return;
      }

      if (asr !== null) {
        postError(
          "Whisper has already been initialized",
          true,
        );
        return;
      }

      const onnxWasmEnv =
        env.backends?.onnx?.wasm;

      if (!onnxWasmEnv) {
        throw new Error(
          "onnxruntime wasm env is unavailable",
        );
      }

      onnxWasmEnv.wasmPaths =
        event.data.ortBaseUrl;
      onnxWasmEnv.numThreads = 1;

      initializationPromise = initialize(
        event.data.model,
        event.data.forceDevice,
      ).finally(() => {
        initializationPromise = null;
      });

      void initializationPromise;
      return;
    }

    void transcribe(
      event.data.requestId,
      event.data.audio,
    );
  },
);

async function initialize(
  model: WhisperModel,
  forceDevice?: WhisperDevice,
): Promise<void> {
  const configuration = MODELS[model];
  const device =
    await resolveInitializationDevice(
      forceDevice,
    );

  try {
    asr = await createPipeline(
      configuration,
      device,
    );
    initializedDevice = device;

    workerScope.postMessage({
      t: "WHISPER_READY",
      device,
    });

    console.log(
      "[whisper]",
      "model ready",
      model,
      device,
    );
  } catch (error) {
    asr = null;
    initializedDevice = null;

    console.error(
      "[whisper]",
      `${formatDevice(device)} initialization failed`,
      error,
    );

    postError(
      toProbeError(error).message,
      true,
      undefined,
      device,
    );
  }
}

async function resolveInitializationDevice(
  forceDevice?: WhisperDevice,
): Promise<WhisperDevice> {
  if (forceDevice !== undefined) {
    console.log(
      "[whisper]",
      "initialization device forced",
      forceDevice,
    );
    return forceDevice;
  }

  const gpu = (
    navigator as Navigator & {
      gpu?: GpuLike;
    }
  ).gpu;

  try {
    const adapter =
      await gpu?.requestAdapter?.();

    if (
      adapter === null ||
      adapter === undefined
    ) {
      console.log(
        "[whisper]",
        "WebGPU adapter unavailable; using WASM",
      );
      return "wasm";
    }

    return "webgpu";
  } catch (error) {
    console.warn(
      "[whisper]",
      "WebGPU adapter probe failed; using WASM",
      toProbeError(error),
    );
    return "wasm";
  }
}

async function createPipeline(
  configuration:
    (typeof MODELS)[WhisperModel],
  device: WhisperDevice,
): Promise<WhisperAsr> {
  const progressAggregator =
    new ModelDownloadProgressAggregator();

  const created = await pipeline(
    "automatic-speech-recognition",
    configuration.id,
    {
      device,
      dtype: configuration.dtype,
      progress_callback(
        progress: unknown,
      ) {
        postProgress(
          progressAggregator.update(
            progress,
          ),
        );
      },
    },
  );

  return created as unknown as WhisperAsr;
}

async function transcribe(
  requestId: string,
  audio: Float32Array,
): Promise<void> {
  if (
    asr === null ||
    initializedDevice === null
  ) {
    postError(
      "Whisper is not initialized",
      false,
      requestId,
    );
    return;
  }

  try {
    const output = await asr(audio, {
      ...(forcedEnglish
        ? { language: "en" as const }
        : {}),
      task: "transcribe",
      max_new_tokens: 96,
      return_timestamps: false,
    });

    workerScope.postMessage({
      t: "WHISPER_RESULT",
      requestId,
      text: extractText(output),
    });
  } catch (error) {
    console.error(
      "[whisper]",
      "transcription failed",
      requestId,
      error,
    );

    postError(
      toProbeError(error).message,
      false,
      requestId,
    );
  }
}

class ModelDownloadProgressAggregator {
  private readonly files =
    new Map<
      string,
      FileProgressState
    >();

  update(
    value: unknown,
  ): AggregatedProgress {
    const raw = isRecord(value)
      ? value as RawProgress
      : {};

    const file =
      typeof raw.file === "string"
        ? raw.file
        : "";
    const loaded =
      finiteNonNegativeOrUndefined(
        raw.loaded,
      );
    const total =
      finiteNonNegativeOrUndefined(
        raw.total,
      );
    const reportedProgress =
      finiteNonNegativeOrUndefined(
        raw.progress,
      );
    const status =
      typeof raw.status === "string"
        ? raw.status
        : "";

    if (file !== "") {
      this.updateFile(
        file,
        loaded,
        total,
        reportedProgress,
        isCompletionStatus(status),
      );
    }

    if (this.files.size === 0) {
      const standaloneLoaded =
        loaded ?? 0;
      const standaloneTotal =
        total ?? 0;
      const standaloneProgress =
        standaloneTotal > 0
          ? standaloneLoaded /
            standaloneTotal *
            100
          : reportedProgress ?? 0;

      return {
        file,
        progress: Math.min(
          INITIALIZATION_PROGRESS_CEILING,
          clampPercentage(
            standaloneProgress,
          ),
        ),
        loaded: standaloneLoaded,
        total: standaloneTotal,
      };
    }

    const states =
      Array.from(this.files.values());
    const knownByteStates =
      states.filter(
        (state) => state.total > 0,
      );
    const aggregateLoaded =
      knownByteStates.reduce(
        (sum, state) =>
          sum +
          Math.min(
            state.loaded,
            state.total,
          ),
        0,
      );
    const aggregateTotal =
      knownByteStates.reduce(
        (sum, state) =>
          sum + state.total,
        0,
      );
    const allTotalsKnown =
      knownByteStates.length ===
      states.length;

    const aggregateFraction =
      allTotalsKnown &&
      aggregateTotal > 0
        ? aggregateLoaded /
          aggregateTotal
        : states.reduce(
            (sum, state) =>
              sum + state.fraction,
            0,
          ) /
          states.length;

    return {
      file,
      progress: Math.min(
        INITIALIZATION_PROGRESS_CEILING,
        clampPercentage(
          aggregateFraction * 100,
        ),
      ),
      loaded: aggregateLoaded,
      total: aggregateTotal,
    };
  }

  private updateFile(
    file: string,
    loaded: number | undefined,
    total: number | undefined,
    reportedProgress:
      | number
      | undefined,
    completed: boolean,
  ): void {
    const previous =
      this.files.get(file) ?? {
        loaded: 0,
        total: 0,
        fraction: 0,
        complete: false,
      };

    const nextTotal =
      total !== undefined &&
      total > 0
        ? Math.max(
            previous.total,
            total,
          )
        : previous.total;
    let nextLoaded =
      loaded === undefined
        ? previous.loaded
        : Math.max(
            previous.loaded,
            loaded,
          );
    const nextComplete =
      previous.complete ||
      completed ||
      (
        nextTotal > 0 &&
        nextLoaded >= nextTotal
      );

    let nextFraction =
      previous.fraction;

    if (nextTotal > 0) {
      nextFraction = Math.max(
        nextFraction,
        nextLoaded / nextTotal,
      );
    } else if (
      reportedProgress !== undefined
    ) {
      nextFraction = Math.max(
        nextFraction,
        reportedProgress / 100,
      );
    }

    if (nextComplete) {
      nextFraction = 1;

      if (nextTotal > 0) {
        nextLoaded = Math.max(
          nextLoaded,
          nextTotal,
        );
      }
    }

    this.files.set(file, {
      loaded: nextLoaded,
      total: nextTotal,
      fraction: Math.max(
        0,
        Math.min(1, nextFraction),
      ),
      complete: nextComplete,
    });
  }
}

function postProgress(
  value: AggregatedProgress,
): void {
  const message:
    WhisperProgressMessage = {
      t: "WHISPER_PROGRESS",
      file: value.file,
      progress: value.progress,
      loaded: value.loaded,
      total: value.total,
    };

  workerScope.postMessage(message);
}

function postError(
  message: string,
  fatal: boolean,
  requestId?: string,
  attemptedDevice?: WhisperDevice,
): void {
  workerScope.postMessage({
    t: "WHISPER_ERROR",
    ...(requestId === undefined
      ? {}
      : { requestId }),
    message,
    fatal,
    ...(attemptedDevice === undefined
      ? {}
      : { attemptedDevice }),
  });
}

function formatDevice(
  device: WhisperDevice,
): string {
  return device === "webgpu"
    ? "WebGPU"
    : "WASM";
}

function extractText(
  output: WhisperPipelineOutput,
): string {
  if (Array.isArray(output)) {
    return output
      .map((item) => item.text)
      .join(" ")
      .trim();
  }

  return output.text.trim();
}

function finiteNonNegativeOrUndefined(
  value: unknown,
): number | undefined {
  return (
    typeof value === "number" &&
    Number.isFinite(value)
  )
    ? Math.max(0, value)
    : undefined;
}

function clampPercentage(
  value: number,
): number {
  return Math.max(
    0,
    Math.min(100, value),
  );
}

function isCompletionStatus(
  status: string,
): boolean {
  return (
    status === "done" ||
    status === "ready"
  );
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null
  );
}
