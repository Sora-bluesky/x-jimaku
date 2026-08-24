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
      language: "en";
      task: "transcribe";
      max_new_tokens: 96;
      return_timestamps: false;
    },
  ): Promise<WhisperPipelineOutput>;
}

interface WorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  postMessage(message: WhisperWorkerOutputMessage): void;
}

interface GpuLike {
  requestAdapter?(): Promise<unknown | null>;
}

interface RawProgress {
  file?: unknown;
  progress?: unknown;
  loaded?: unknown;
  total?: unknown;
}

const workerScope =
  globalThis as unknown as WorkerScope;

let asr: WhisperAsr | null = null;
let initializedDevice: WhisperDevice | null = null;
let initializationPromise: Promise<void> | null = null;

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

    if (adapter === null || adapter === undefined) {
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
  configuration: (typeof MODELS)[WhisperModel],
  device: WhisperDevice,
): Promise<WhisperAsr> {
  const created = await pipeline(
    "automatic-speech-recognition",
    configuration.id,
    {
      device,
      dtype: configuration.dtype,
      progress_callback(progress: unknown) {
        postProgress(progress);
      },
    },
  );

  return created as unknown as WhisperAsr;
}

async function transcribe(
  requestId: string,
  audio: Float32Array,
): Promise<void> {
  if (asr === null || initializedDevice === null) {
    postError(
      "Whisper is not initialized",
      false,
      requestId,
    );
    return;
  }

  try {
    const output = await asr(audio, {
      language: "en",
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

function postProgress(value: unknown): void {
  const raw = isRecord(value)
    ? value as RawProgress
    : {};

  const loaded = finiteNonNegative(raw.loaded);
  const total = finiteNonNegative(raw.total);
  const reportedProgress =
    finiteNonNegative(raw.progress);

  const derivedProgress =
    total > 0
      ? loaded / total * 100
      : 0;

  const progress = clampPercentage(
    reportedProgress > 0
      ? reportedProgress
      : derivedProgress,
  );

  const message: WhisperProgressMessage = {
    t: "WHISPER_PROGRESS",
    file:
      typeof raw.file === "string"
        ? raw.file
        : "",
    progress,
    loaded,
    total,
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

function finiteNonNegative(
  value: unknown,
): number {
  return (
    typeof value === "number" &&
    Number.isFinite(value)
  )
    ? Math.max(0, value)
    : 0;
}

function clampPercentage(
  value: number,
): number {
  return Math.max(0, Math.min(100, value));
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
