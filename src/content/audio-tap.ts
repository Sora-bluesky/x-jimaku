import {
  PCM_TARGET_SAMPLE_RATE,
  StreamingLinearDownsampler,
} from "../shared/downsampler";

const PCM_CHUNK_SAMPLES = 4_000;
const SANITY_CHECK_INTERVAL_MS = 1_000;
const BASE64_BLOCK_BYTES = 0x8000;

type CapturableVideoElement =
  HTMLVideoElement & {
    captureStream(): MediaStream;
  };

let currentAudioTapTarget:
  | HTMLVideoElement
  | null = null;

export interface AudioTapCallbacks {
  onChunk(seq: number, b64: string): void;
  onDetail(detail: string): void;
  onContextStateChange(
    state: AudioContextState,
  ): void;
  onTargetChanged(
    target: HTMLVideoElement | null,
  ): void;
  onMediaEnded(): void;
  onStopped(
    detail: string,
    target: HTMLVideoElement | null,
  ): void;
  onError(error: unknown): void;
}

export function getCurrentAudioTapTarget():
  | HTMLVideoElement
  | null {
  return currentAudioTapTarget;
}

export class AudioTap {
  private readonly requestId: string;
  private readonly callbacks: AudioTapCallbacks;

  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private audioTrack: MediaStreamTrack | null =
    null;
  private context: AudioContext | null = null;
  private source:
    | MediaStreamAudioSourceNode
    | null = null;
  private worklet: AudioWorkletNode | null =
    null;
  private silentGain: GainNode | null = null;
  private downsampler:
    | StreamingLinearDownsampler
    | null = null;
  private chunkBuffer =
    new Float32Array(PCM_CHUNK_SAMPLES);
  private chunkWriteOffset = 0;
  private nextSequence = 0;
  private initialUrl = "";
  private sanityTimerId: number | null = null;
  private cleanupPromise: Promise<void> | null =
    null;
  private active = false;
  private ending = false;
  private resumeListenersInstalled = false;

  constructor(
    requestId: string,
    callbacks: AudioTapCallbacks,
  ) {
    this.requestId = requestId;
    this.callbacks = callbacks;
  }

  getRequestId(): string {
    return this.requestId;
  }

  isSuspended(): boolean {
    return this.context?.state === "suspended";
  }

  async start(): Promise<string> {
    if (this.active || this.context !== null) {
      throw new DOMException(
        "This audio tap has already started",
        "InvalidStateError",
      );
    }

    const video = selectTargetVideo();

    if (video === null) {
      throw new AudioTapError(
        "no-video",
        "No playing video element is available",
      );
    }

    if (!hasCaptureStream(video)) {
      throw new AudioTapError(
        "capture-stream-unavailable",
        "HTMLVideoElement.captureStream() is unavailable",
      );
    }

    this.video = video;
    currentAudioTapTarget = video;
    this.callbacks.onTargetChanged(video);
    this.initialUrl = location.href;
    this.chunkBuffer =
      new Float32Array(PCM_CHUNK_SAMPLES);
    this.chunkWriteOffset = 0;
    this.nextSequence = 0;
    this.ending = false;

    try {
      const stream = video.captureStream();
      const audioTrack =
        stream.getAudioTracks()[0];

      if (audioTrack === undefined) {
        for (const track of stream.getTracks()) {
          track.stop();
        }

        throw new AudioTapError(
          "no-audio-track",
          "The selected video capture stream has no audio track",
        );
      }

      if (audioTrack.readyState === "ended") {
        for (const track of stream.getTracks()) {
          track.stop();
        }

        throw new AudioTapError(
          "track-ended",
          "The selected video audio track has already ended",
        );
      }

      const context = createAnalysisContext();

      this.stream = stream;
      this.audioTrack = audioTrack;
      this.context = context;
      context.addEventListener(
        "statechange",
        this.handleContextStateChange,
      );

      if (
        context.sampleRate !==
        PCM_TARGET_SAMPLE_RATE
      ) {
        this.downsampler =
          new StreamingLinearDownsampler(
            context.sampleRate,
            PCM_TARGET_SAMPLE_RATE,
          );

        console.warn(
          "[tap]",
          "analysis context requires fallback downsampling",
          {
            sourceSampleRate:
              context.sampleRate,
            targetSampleRate:
              PCM_TARGET_SAMPLE_RATE,
          },
        );
      }

      await context.audioWorklet.addModule(
        chrome.runtime.getURL(
          "pcm-worklet.js",
        ),
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
        if (!(event.data instanceof Float32Array)) {
          return;
        }

        try {
          this.acceptWorkletFrame(event.data);
        } catch (error) {
          void this.fail(error);
        }
      };

      source.connect(worklet);
      worklet.connect(silentGain);
      silentGain.connect(context.destination);

      this.source = source;
      this.worklet = worklet;
      this.silentGain = silentGain;
      this.active = true;

      audioTrack.addEventListener(
        "ended",
        this.handleTrackEnded,
      );
      video.addEventListener(
        "ended",
        this.handleMediaEnded,
      );
      video.addEventListener(
        "emptied",
        this.handleVideoEmptied,
      );

      this.sanityTimerId =
        window.setInterval(
          this.runSanityCheck,
          SANITY_CHECK_INTERVAL_MS,
        );

      const resumeDetail =
        await this.resumeOrDefer(context);

      if (
        (audioTrack.readyState as MediaStreamTrackState) === "ended"
      ) {
        throw new AudioTapError(
          "track-ended",
          "The selected video audio track ended during startup",
        );
      }

      console.log("[tap]", "audio graph ready", {
        requestId: this.requestId,
        sampleRate: context.sampleRate,
        videoMuted: video.muted,
        videoVolume: video.volume,
      });

      return resumeDetail;
    } catch (error) {
      try {
        await this.cleanup();
      } catch (cleanupError) {
        console.error(
          "[tap]",
          "startup cleanup failed",
          cleanupError,
        );
      }

      throw error;
    }
  }

  async stop(): Promise<void> {
    await this.cleanup();
  }

  private async resumeOrDefer(
    context: AudioContext,
  ): Promise<string> {
    if (context.state === "suspended") {
      try {
        await context.resume();
      } catch (error) {
        console.info(
          "[tap]",
          "immediate AudioContext resume was rejected",
          error,
        );
      }
    }

    if (context.state === "closed") {
      throw new AudioTapError(
        "audio-context-closed",
        "The analysis AudioContext closed during startup",
      );
    }

    if (context.state === "suspended") {
      this.installResumeListeners();
      return "audio-context-suspended";
    }

    return "audio-context-running";
  }

  private installResumeListeners(): void {
    if (this.resumeListenersInstalled) {
      return;
    }

    this.resumeListenersInstalled = true;

    document.addEventListener(
      "play",
      this.handleResumeGesture,
      true,
    );
    document.addEventListener(
      "click",
      this.handleResumeGesture,
      true,
    );
  }

  private removeResumeListeners(): void {
    if (!this.resumeListenersInstalled) {
      return;
    }

    this.resumeListenersInstalled = false;

    document.removeEventListener(
      "play",
      this.handleResumeGesture,
      true,
    );
    document.removeEventListener(
      "click",
      this.handleResumeGesture,
      true,
    );
  }

  private readonly handleContextStateChange =
    (): void => {
      const context = this.context;

      if (context === null) {
        return;
      }

      if (context.state === "suspended") {
        this.installResumeListeners();
      } else {
        this.removeResumeListeners();
      }

      this.callbacks.onContextStateChange(
        context.state,
      );
    };

  private readonly handleResumeGesture =
    (): void => {
      const context = this.context;

      if (
        context === null ||
        context.state !== "suspended"
      ) {
        this.removeResumeListeners();
        return;
      }

      void context.resume()
        .then(() => {
          if (
            this.context === context &&
            context.state === "running"
          ) {
            this.removeResumeListeners();
            this.callbacks.onDetail(
              "audio-context-running",
            );
          }
        })
        .catch((error: unknown) => {
          console.warn(
            "[tap]",
            "deferred AudioContext resume was rejected",
            error,
          );
        });
    };

  private acceptWorkletFrame(
    frame: Float32Array,
  ): void {
    if (!this.active || frame.length === 0) {
      return;
    }

    const samples =
      this.downsampler?.push(frame) ??
      frame;

    if (samples.length === 0) {
      return;
    }

    let readOffset = 0;

    while (readOffset < samples.length) {
      const writable =
        PCM_CHUNK_SAMPLES -
        this.chunkWriteOffset;
      const remaining =
        samples.length - readOffset;
      const copyLength = Math.min(
        writable,
        remaining,
      );

      this.chunkBuffer.set(
        samples.subarray(
          readOffset,
          readOffset + copyLength,
        ),
        this.chunkWriteOffset,
      );

      readOffset += copyLength;
      this.chunkWriteOffset += copyLength;

      if (
        this.chunkWriteOffset ===
        PCM_CHUNK_SAMPLES
      ) {
        const chunk = this.chunkBuffer;

        this.chunkBuffer =
          new Float32Array(
            PCM_CHUNK_SAMPLES,
          );
        this.chunkWriteOffset = 0;

        const seq = this.nextSequence;
        this.nextSequence += 1;

        this.callbacks.onChunk(
          seq,
          encodeFloat32Base64(chunk),
        );
      }
    }
  }

  private readonly handleMediaEnded =
    (): void => {
      if (!this.active) {
        return;
      }

      this.flushPendingChunk();
      this.callbacks.onMediaEnded();
    };

  private readonly handleTrackEnded =
    (): void => {
      void this.endFromSource("track-ended");
    };

  private readonly handleVideoEmptied =
    (): void => {
      void this.endFromSource("video-emptied");
    };

  private readonly runSanityCheck =
    (): void => {
      const video = this.video;
      const audioTrack = this.audioTrack;
      const context = this.context;

      if (!this.active || video === null) {
        return;
      }

      if (!video.isConnected) {
        void this.endFromSource(
          "video-removed",
        );
        return;
      }

      if (location.href !== this.initialUrl) {
        void this.endFromSource(
          "spa-navigation",
        );
        return;
      }

      if (
        audioTrack === null ||
        (audioTrack.readyState as MediaStreamTrackState) === "ended"
      ) {
        void this.endFromSource(
          "track-ended",
        );
        return;
      }

      if (context?.state === "closed") {
        void this.fail(
          new AudioTapError(
            "audio-context-closed",
            "The analysis AudioContext closed unexpectedly",
          ),
        );
      }
    };

  private async endFromSource(
    detail: string,
  ): Promise<void> {
    if (this.ending) {
      return;
    }

    this.ending = true;
    const target = this.video;

    if (detail === "track-ended") {
      this.flushPendingChunk();
    }

    try {
      await this.cleanup();
    } catch (error) {
      console.error(
        "[tap]",
        "source-ended cleanup failed",
        error,
      );
    }

    this.callbacks.onStopped(
      detail,
      target,
    );
  }

  private flushPendingChunk(): void {
    if (
      !this.active ||
      this.chunkWriteOffset === 0
    ) {
      return;
    }

    const chunk = this.chunkBuffer.slice(
      0,
      this.chunkWriteOffset,
    );

    this.chunkBuffer =
      new Float32Array(PCM_CHUNK_SAMPLES);
    this.chunkWriteOffset = 0;

    const seq = this.nextSequence;
    this.nextSequence += 1;

    this.callbacks.onChunk(
      seq,
      encodeFloat32Base64(chunk),
    );
  }

  private async fail(
    error: unknown,
  ): Promise<void> {
    if (this.ending) {
      return;
    }

    this.ending = true;

    try {
      await this.cleanup();
    } catch (cleanupError) {
      console.error(
        "[tap]",
        "failure cleanup failed",
        cleanupError,
      );
    }

    this.callbacks.onError(error);
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
    const video = this.video;
    const stream = this.stream;
    const audioTrack = this.audioTrack;
    const context = this.context;
    const source = this.source;
    const worklet = this.worklet;
    const silentGain = this.silentGain;
    const sanityTimerId =
      this.sanityTimerId;

    this.active = false;
    this.video = null;

    if (currentAudioTapTarget === video) {
      currentAudioTapTarget = null;
      this.callbacks.onTargetChanged(null);
    }

    this.stream = null;
    this.audioTrack = null;
    this.context = null;
    this.source = null;
    this.worklet = null;
    this.silentGain = null;
    this.sanityTimerId = null;
    this.chunkWriteOffset = 0;
    this.downsampler?.reset();
    this.downsampler = null;

    this.removeResumeListeners();

    context?.removeEventListener(
      "statechange",
      this.handleContextStateChange,
    );

    if (sanityTimerId !== null) {
      globalThis.clearInterval(
        sanityTimerId,
      );
    }

    audioTrack?.removeEventListener(
      "ended",
      this.handleTrackEnded,
    );
    video?.removeEventListener(
      "ended",
      this.handleMediaEnded,
    );
    video?.removeEventListener(
      "emptied",
      this.handleVideoEmptied,
    );

    if (worklet !== null) {
      worklet.port.onmessage = null;
    }

    source?.disconnect();
    worklet?.disconnect();
    silentGain?.disconnect();

    if (stream !== null) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }

    if (
      context !== null &&
      context.state !== "closed"
    ) {
      await context.close();
    }
  }
}

export function getAudioTapErrorDetail(
  error: unknown,
): string {
  if (error instanceof AudioTapError) {
    return error.detail;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

class AudioTapError extends Error {
  readonly detail: string;

  constructor(
    detail: string,
    message: string,
  ) {
    super(message);
    this.name = "AudioTapError";
    this.detail = detail;
  }
}

function selectTargetVideo():
  | HTMLVideoElement
  | null {
  const videos = Array.from(
    document.querySelectorAll("video"),
  );

  const preferred = videos.filter(
    (video) =>
      isPlayingAndReady(video) &&
      !video.muted &&
      video.volume > 0,
  );

  const candidates =
    preferred.length > 0
      ? preferred
      : videos.filter(isPlayingAndReady);

  let selected: HTMLVideoElement | null =
    null;
  let largestIntersection = -1;

  for (const video of candidates) {
    const intersection =
      getViewportIntersectionArea(video);

    if (intersection > largestIntersection) {
      selected = video;
      largestIntersection = intersection;
    }
  }

  return selected;
}

function isPlayingAndReady(
  video: HTMLVideoElement,
): boolean {
  return (
    !video.paused &&
    !video.ended &&
    video.readyState >= 2
  );
}

function getViewportIntersectionArea(
  video: HTMLVideoElement,
): number {
  const rect =
    video.getBoundingClientRect();
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(
    window.innerWidth,
    rect.right,
  );
  const bottom = Math.min(
    window.innerHeight,
    rect.bottom,
  );

  return (
    Math.max(0, right - left) *
    Math.max(0, bottom - top)
  );
}

function hasCaptureStream(
  video: HTMLVideoElement,
): video is CapturableVideoElement {
  return (
    "captureStream" in video &&
    typeof (
      video as Partial<CapturableVideoElement>
    ).captureStream === "function"
  );
}

function createAnalysisContext(): AudioContext {
  try {
    return new AudioContext({
      sampleRate: PCM_TARGET_SAMPLE_RATE,
    });
  } catch (error) {
    console.warn(
      "[tap]",
      "16 kHz AudioContext unavailable; using browser default",
      error,
    );

    return new AudioContext();
  }
}

function encodeFloat32Base64(
  samples: Float32Array,
): string {
  const bytes = new Uint8Array(
    samples.buffer,
    samples.byteOffset,
    samples.byteLength,
  );
  let binary = "";

  for (
    let offset = 0;
    offset < bytes.length;
    offset += BASE64_BLOCK_BYTES
  ) {
    binary += String.fromCharCode(
      ...bytes.subarray(
        offset,
        Math.min(
          offset + BASE64_BLOCK_BYTES,
          bytes.length,
        ),
      ),
    );
  }

  return btoa(binary);
}
