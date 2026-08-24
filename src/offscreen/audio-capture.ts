import {
  PCM_TARGET_SAMPLE_RATE,
} from "../shared/downsampler";

export {
  StreamingLinearDownsampler,
  downsampleLinear,
} from "../shared/downsampler";

const RING_BUFFER_SECONDS = 30;
const RMS_WINDOW_SECONDS = 0.1;
const ENERGY_HOP_SECONDS = 0.02;
const LEVEL_INTERVAL_MS = 100;

const ENERGY_HOP_SAMPLES = Math.round(
  PCM_TARGET_SAMPLE_RATE *
  ENERGY_HOP_SECONDS,
);

export interface AudioCaptureCallbacks {
  onLevel(rms: number): void;
  onEnded?(requestId: string): void;
}

export interface AudioEnergyFrame {
  startOffset: number;
  endOffset: number;
  rms: number;
}

export class AudioCapture {
  private readonly ringBuffer =
    new Float32Array(
      PCM_TARGET_SAMPLE_RATE *
      RING_BUFFER_SECONDS,
    );

  private requestId: string | null = null;
  private callbacks:
    | AudioCaptureCallbacks
    | null = null;
  private writePos = 0;
  private totalSamplesWritten = 0;
  private lastLevelEmittedAt =
    Number.NEGATIVE_INFINITY;
  private energyWindowSumSquares = 0;
  private energyWindowSampleCount = 0;
  private readonly energyHistory:
    AudioEnergyFrame[] = [];

  isActive(): boolean {
    return this.requestId !== null;
  }

  getRequestId(): string | null {
    return this.requestId;
  }

  getWriteOffset(): number {
    return this.totalSamplesWritten;
  }

  getCapacitySamples(): number {
    return this.ringBuffer.length;
  }

  getEnergyHistory(): readonly AudioEnergyFrame[] {
    return this.energyHistory.slice();
  }

  copySamples(
    startOffset: number,
    endOffset: number,
  ): Float32Array {
    const availableStart = Math.max(
      0,
      this.totalSamplesWritten -
      this.ringBuffer.length,
    );

    if (
      !Number.isSafeInteger(startOffset) ||
      !Number.isSafeInteger(endOffset) ||
      startOffset < availableStart ||
      endOffset < startOffset ||
      endOffset > this.totalSamplesWritten
    ) {
      throw new RangeError(
        `Requested audio range [${startOffset}, ${endOffset}) is outside [${availableStart}, ${this.totalSamplesWritten})`,
      );
    }

    const output = new Float32Array(
      endOffset - startOffset,
    );

    for (
      let index = 0;
      index < output.length;
      index += 1
    ) {
      const absoluteOffset =
        startOffset + index;
      const ringIndex =
        absoluteOffset %
        this.ringBuffer.length;

      output[index] =
        this.ringBuffer[ringIndex] ?? 0;
    }

    return output;
  }

  async start(
    requestId: string,
    callbacks: AudioCaptureCallbacks,
  ): Promise<void> {
    if (this.isActive()) {
      throw new DOMException(
        "An audio capture session is already active",
        "InvalidStateError",
      );
    }

    this.requestId = requestId;
    this.callbacks = callbacks;
    this.writePos = 0;
    this.totalSamplesWritten = 0;
    this.ringBuffer.fill(0);
    this.energyHistory.length = 0;
    this.energyWindowSumSquares = 0;
    this.energyWindowSampleCount = 0;
    this.lastLevelEmittedAt =
      Number.NEGATIVE_INFINITY;

    console.log("[audio]", "PCM sink ready", {
      requestId,
      sampleRate: PCM_TARGET_SAMPLE_RATE,
    });
  }

  acceptPcm(
    requestId: string,
    samples: Float32Array,
  ): boolean {
    if (
      this.requestId !== requestId ||
      samples.length === 0
    ) {
      return false;
    }

    this.appendSamples(samples);
    this.maybeEmitLevel();
    return true;
  }

  async stop(): Promise<void> {
    this.requestId = null;
    this.callbacks = null;
  }

  private appendSamples(
    samples: Float32Array,
  ): void {
    for (
      let index = 0;
      index < samples.length;
      index += 1
    ) {
      const raw = samples[index] ?? 0;
      const sample =
        Number.isFinite(raw) ? raw : 0;

      this.ringBuffer[this.writePos] = sample;
      this.writePos =
        (
          this.writePos + 1
        ) % this.ringBuffer.length;
      this.totalSamplesWritten += 1;

      this.energyWindowSumSquares +=
        sample * sample;
      this.energyWindowSampleCount += 1;

      if (
        this.energyWindowSampleCount >=
        ENERGY_HOP_SAMPLES
      ) {
        this.appendEnergyFrame();
      }
    }
  }

  private appendEnergyFrame(): void {
    const endOffset =
      this.totalSamplesWritten;
    const sampleCount =
      this.energyWindowSampleCount;
    const rms =
      sampleCount === 0
        ? 0
        : Math.sqrt(
            this.energyWindowSumSquares /
            sampleCount,
          );

    this.energyHistory.push({
      startOffset:
        endOffset - sampleCount,
      endOffset,
      rms,
    });

    this.energyWindowSumSquares = 0;
    this.energyWindowSampleCount = 0;

    const maximumFrames =
      Math.ceil(
        this.ringBuffer.length /
        ENERGY_HOP_SAMPLES,
      ) + 2;

    if (
      this.energyHistory.length >
      maximumFrames
    ) {
      this.energyHistory.splice(
        0,
        this.energyHistory.length -
        maximumFrames,
      );
    }
  }

  private maybeEmitLevel(): void {
    const now = performance.now();

    if (
      now - this.lastLevelEmittedAt <
      LEVEL_INTERVAL_MS
    ) {
      return;
    }

    this.lastLevelEmittedAt = now;
    this.callbacks?.onLevel(
      this.computeRecentRms(),
    );
  }

  private computeRecentRms(): number {
    const availableSamples = Math.min(
      this.totalSamplesWritten,
      this.ringBuffer.length,
    );
    const windowSamples = Math.min(
      Math.round(
        PCM_TARGET_SAMPLE_RATE *
        RMS_WINDOW_SECONDS,
      ),
      availableSamples,
    );

    if (windowSamples === 0) {
      return 0;
    }

    let sumSquares = 0;
    let readPos =
      (
        this.writePos -
        windowSamples +
        this.ringBuffer.length
      ) % this.ringBuffer.length;

    for (
      let index = 0;
      index < windowSamples;
      index += 1
    ) {
      const sample =
        this.ringBuffer[readPos] ?? 0;
      sumSquares += sample * sample;
      readPos =
        (
          readPos + 1
        ) % this.ringBuffer.length;
    }

    return Math.sqrt(
      sumSquares / windowSamples,
    );
  }
}
