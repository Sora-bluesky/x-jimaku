const TARGET_SAMPLE_RATE = 16_000;
const RING_BUFFER_SECONDS = 30;
const RMS_WINDOW_SECONDS = 0.1;
const LEVEL_INTERVAL_MS = 100;

export interface AudioCaptureCallbacks {
  onLevel(rms: number): void;
  onEnded(requestId: string): void;
}

export class AudioCapture {
  private readonly ringBuffer =
    new Float32Array(
      TARGET_SAMPLE_RATE * RING_BUFFER_SECONDS,
    );

  private stream: MediaStream | null = null;
  private playbackContext: AudioContext | null = null;
  private captureContext: AudioContext | null = null;
  private playbackSource:
    | MediaStreamAudioSourceNode
    | null = null;
  private captureSource:
    | MediaStreamAudioSourceNode
    | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private silentGain: GainNode | null = null;
  private requestId: string | null = null;
  private callbacks: AudioCaptureCallbacks | null = null;
  private cleanupPromise: Promise<void> | null = null;
  private fallbackSamples: Float32Array = new Float32Array(0);
  private sourceSampleRate = TARGET_SAMPLE_RATE;
  private writePos = 0;
  private committedOffset = 0;
  private lastLevelEmittedAt =
    Number.NEGATIVE_INFINITY;

  isActive(): boolean {
    return (
      this.stream !== null ||
      this.playbackContext !== null ||
      this.captureContext !== null
    );
  }

  async start(
    streamId: string,
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
    this.committedOffset = 0;
    this.fallbackSamples = new Float32Array(0);
    this.ringBuffer.fill(0);
    this.lastLevelEmittedAt =
      Number.NEGATIVE_INFINITY;

    try {
      const stream =
        await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: {
              chromeMediaSource: "tab",
              chromeMediaSourceId: streamId,
            },
          } as unknown as MediaTrackConstraints,
          video: false,
        });

      this.stream = stream;

      const audioTrack =
        stream.getAudioTracks()[0];

      if (audioTrack === undefined) {
        throw new DOMException(
          "The captured tab stream has no audio track",
          "NotFoundError",
        );
      }

      audioTrack.onended = () => {
        this.handleTrackEnded();
      };

      if (audioTrack.readyState === "ended") {
        throw new DOMException(
          "The captured tab audio track ended during startup",
          "AbortError",
        );
      }

      await this.createPlaybackPath(stream);
      await this.createCapturePath(stream);

      console.log("[audio]", "audio graph ready", {
        requestId,
        playbackSampleRate:
          this.playbackContext?.sampleRate,
        captureSampleRate:
          this.captureContext?.sampleRate,
      });
    } catch (error) {
      await this.cleanup();
      throw error;
    }
  }

  async stop(): Promise<void> {
    await this.cleanup();
  }

  private async createPlaybackPath(
    stream: MediaStream,
  ): Promise<void> {
    const context = new AudioContext();
    const source =
      context.createMediaStreamSource(stream);

    source.connect(context.destination);

    this.playbackContext = context;
    this.playbackSource = source;

    if (context.state === "suspended") {
      await context.resume();
    }
  }

  private async createCapturePath(
    stream: MediaStream,
  ): Promise<void> {
    let context: AudioContext;

    try {
      context = new AudioContext({
        sampleRate: TARGET_SAMPLE_RATE,
      });
    } catch (error) {
      console.warn(
        "[audio]",
        "16 kHz AudioContext unavailable; using browser default with linear downsampling",
        error,
      );
      context = new AudioContext();
    }

    this.captureContext = context;
    this.sourceSampleRate = context.sampleRate;

    if (context.sampleRate !== TARGET_SAMPLE_RATE) {
      console.warn(
        "[audio]",
        "capture context requires fallback downsampling",
        {
          sourceSampleRate: context.sampleRate,
          targetSampleRate: TARGET_SAMPLE_RATE,
        },
      );
    }

    await context.audioWorklet.addModule(
      chrome.runtime.getURL("pcm-worklet.js"),
    );

    const source =
      context.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(
      context,
      "pcm-tap",
    );
    const silentGain = context.createGain();

    silentGain.gain.value = 0;

    worklet.port.onmessage = (
      event: MessageEvent<unknown>,
    ) => {
      if (event.data instanceof Float32Array) {
        this.acceptWorkletFrame(event.data);
      }
    };

    source.connect(worklet);
    worklet.connect(silentGain);
    silentGain.connect(context.destination);

    this.captureSource = source;
    this.workletNode = worklet;
    this.silentGain = silentGain;

    if (context.state === "suspended") {
      await context.resume();
    }
  }

  private acceptWorkletFrame(
    frame: Float32Array,
  ): void {
    if (frame.length === 0) {
      return;
    }

    if (
      this.sourceSampleRate === TARGET_SAMPLE_RATE
    ) {
      this.appendSamples(frame);
      this.maybeEmitLevel();
      return;
    }

    this.fallbackSamples = concatenateSamples(
      this.fallbackSamples,
      frame,
    );

    const sourceChunkSize = Math.max(
      1,
      Math.round(this.sourceSampleRate / 10),
    );

    while (
      this.fallbackSamples.length >= sourceChunkSize
    ) {
      const sourceChunk =
        this.fallbackSamples.slice(
          0,
          sourceChunkSize,
        );

      this.fallbackSamples =
        this.fallbackSamples.slice(sourceChunkSize);

      this.appendSamples(
        downsampleLinear(
          sourceChunk,
          this.sourceSampleRate,
          TARGET_SAMPLE_RATE,
        ),
      );
    }

    this.maybeEmitLevel();
  }

  private appendSamples(
    samples: Float32Array,
  ): void {
    for (let index = 0; index < samples.length; index += 1) {
      this.ringBuffer[this.writePos] =
        samples[index] ?? 0;
      this.writePos =
        (this.writePos + 1) %
        this.ringBuffer.length;
    }

    this.committedOffset += samples.length;
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

    const rms = this.computeRecentRms();
    this.callbacks?.onLevel(rms);
  }

  private computeRecentRms(): number {
    const availableSamples = Math.min(
      this.committedOffset,
      this.ringBuffer.length,
    );
    const windowSamples = Math.min(
      Math.round(
        TARGET_SAMPLE_RATE * RMS_WINDOW_SECONDS,
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
        (readPos + 1) %
        this.ringBuffer.length;
    }

    return Math.sqrt(sumSquares / windowSamples);
  }

  private handleTrackEnded(): void {
    const endedRequestId = this.requestId;
    const endedCallback = this.callbacks?.onEnded;

    if (
      endedRequestId === null ||
      endedCallback === undefined
    ) {
      return;
    }

    console.log("[audio]", "captured track ended", {
      requestId: endedRequestId,
    });

    void this.cleanup()
      .then(() => {
        endedCallback(endedRequestId);
      })
      .catch((error: unknown) => {
        console.error(
          "[audio]",
          "track-ended cleanup failed",
          error,
        );
        endedCallback(endedRequestId);
      });
  }

  private cleanup(): Promise<void> {
    if (this.cleanupPromise !== null) {
      return this.cleanupPromise;
    }

    this.cleanupPromise =
      this.performCleanup().finally(() => {
        this.cleanupPromise = null;
      });

    return this.cleanupPromise;
  }

  private async performCleanup(): Promise<void> {
    const stream = this.stream;
    const playbackContext =
      this.playbackContext;
    const captureContext = this.captureContext;
    const playbackSource = this.playbackSource;
    const captureSource = this.captureSource;
    const workletNode = this.workletNode;
    const silentGain = this.silentGain;

    this.stream = null;
    this.playbackContext = null;
    this.captureContext = null;
    this.playbackSource = null;
    this.captureSource = null;
    this.workletNode = null;
    this.silentGain = null;
    this.requestId = null;
    this.callbacks = null;
    this.fallbackSamples = new Float32Array(0);

    if (workletNode !== null) {
      workletNode.port.onmessage = null;
    }

    playbackSource?.disconnect();
    captureSource?.disconnect();
    workletNode?.disconnect();
    silentGain?.disconnect();

    if (stream !== null) {
      for (const track of stream.getTracks()) {
        track.onended = null;
        track.stop();
      }
    }

    const closeOperations: Promise<void>[] = [];

    if (
      playbackContext !== null &&
      playbackContext.state !== "closed"
    ) {
      closeOperations.push(
        playbackContext.close(),
      );
    }

    if (
      captureContext !== null &&
      captureContext.state !== "closed"
    ) {
      closeOperations.push(
        captureContext.close(),
      );
    }

    const results =
      await Promise.allSettled(closeOperations);
    const rejected = results.find(
      (
        result,
      ): result is PromiseRejectedResult =>
        result.status === "rejected",
    );

    if (rejected !== undefined) {
      throw rejected.reason;
    }
  }
}

export function downsampleLinear(
  input: Float32Array,
  sourceSampleRate: number,
  targetSampleRate: number = TARGET_SAMPLE_RATE,
): Float32Array {
  if (
    !Number.isFinite(sourceSampleRate) ||
    sourceSampleRate <= 0 ||
    !Number.isFinite(targetSampleRate) ||
    targetSampleRate <= 0
  ) {
    throw new RangeError(
      "Sample rates must be finite positive numbers",
    );
  }

  if (input.length === 0) {
    return new Float32Array(0);
  }

  if (sourceSampleRate === targetSampleRate) {
    return input.slice();
  }

  const outputLength = Math.max(
    1,
    Math.round(
      input.length *
      targetSampleRate /
      sourceSampleRate,
    ),
  );
  const output = new Float32Array(outputLength);
  const sourceStep =
    sourceSampleRate / targetSampleRate;

  for (
    let outputIndex = 0;
    outputIndex < outputLength;
    outputIndex += 1
  ) {
    const sourcePosition =
      outputIndex * sourceStep;
    const leftIndex = Math.min(
      Math.floor(sourcePosition),
      input.length - 1,
    );
    const rightIndex = Math.min(
      leftIndex + 1,
      input.length - 1,
    );
    const fraction =
      sourcePosition - leftIndex;
    const left = input[leftIndex] ?? 0;
    const right = input[rightIndex] ?? left;

    output[outputIndex] =
      left + (right - left) * fraction;
  }

  return output;
}

function concatenateSamples(
  left: Float32Array,
  right: Float32Array,
): Float32Array {
  if (left.length === 0) {
    return right.slice();
  }

  const combined = new Float32Array(
    left.length + right.length,
  );

  combined.set(left);
  combined.set(right, left.length);

  return combined;
}
