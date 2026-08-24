import {
  isWhisperWorkerOutputMessage,
  nowIso,
  type WhisperTranscribeMessage,
} from "../shared/messages";
import type {
  AudioEnergyFrame,
} from "./audio-capture";

const SAMPLE_RATE = 16_000;
const TICK_INTERVAL_MS = 300;
const MIN_SEGMENT_SAMPLES = SAMPLE_RATE;
const MAX_SEGMENT_SAMPLES = SAMPLE_RATE * 15;
const TRAILING_SILENCE_SAMPLES =
  Math.round(SAMPLE_RATE * 0.7);
const ENERGY_HOP_SAMPLES =
  Math.round(SAMPLE_RATE * 0.02);

export const SILENCE_RMS_THRESHOLD = 0.008;

export interface RecognitionLine {
  id: number;
  text: string;
  final: boolean;
  at: string;
}

export interface SegmenterOptions {
  worker: Worker;
  getWriteOffset(): number;
  getCapacitySamples(): number;
  copySamples(
    startOffset: number,
    endOffset: number,
  ): Float32Array;
  getEnergyHistory(): readonly AudioEnergyFrame[];
  onLine(line: RecognitionLine): void;
  onError(message: string): void;
  now?: () => string;
}

interface InFlightSegment {
  requestId: string;
  startOffset: number;
  endOffset: number;
  sampleLength: number;
}

export class WhisperSegmenter {
  private readonly worker: Worker;
  private readonly getWriteOffset:
    SegmenterOptions["getWriteOffset"];
  private readonly getCapacitySamples:
    SegmenterOptions["getCapacitySamples"];
  private readonly copySamples:
    SegmenterOptions["copySamples"];
  private readonly getEnergyHistory:
    SegmenterOptions["getEnergyHistory"];
  private readonly onLine:
    SegmenterOptions["onLine"];
  private readonly onError:
    SegmenterOptions["onError"];
  private readonly now: () => string;

  private committedOffset = 0;
  private busy = false;
  private started = false;
  private tickTimerId: number | null = null;
  private nextRequestSequence = 1;
  private nextLineId = 1;
  private currentLineId: number | null = null;
  private inFlight: InFlightSegment | null = null;

  constructor(options: SegmenterOptions) {
    this.worker = options.worker;
    this.getWriteOffset = options.getWriteOffset;
    this.getCapacitySamples =
      options.getCapacitySamples;
    this.copySamples = options.copySamples;
    this.getEnergyHistory =
      options.getEnergyHistory;
    this.onLine = options.onLine;
    this.onError = options.onError;
    this.now = options.now ?? nowIso;
  }

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.committedOffset =
      this.getAvailableStartOffset();

    this.worker.addEventListener(
      "message",
      this.handleWorkerMessage,
    );

    this.tickTimerId = self.setInterval(
      () => {
        this.tick();
      },
      TICK_INTERVAL_MS,
    );

    this.tick();
  }

  stop(): void {
    if (!this.started) {
      return;
    }

    this.started = false;
    this.busy = false;
    this.inFlight = null;

    if (this.tickTimerId !== null) {
      globalThis.clearInterval(this.tickTimerId);
      this.tickTimerId = null;
    }

    this.worker.removeEventListener(
      "message",
      this.handleWorkerMessage,
    );
  }

  tick(): void {
    if (!this.started || this.busy) {
      return;
    }

    const writeOffset = this.getWriteOffset();
    const capacity = this.getCapacitySamples();
    const availableStart = Math.max(
      0,
      writeOffset - capacity,
    );

    if (this.committedOffset < availableStart) {
      const dropped =
        availableStart - this.committedOffset;

      this.committedOffset = availableStart;

      console.warn(
        "[seg]",
        "ring buffer overflow dropped uncommitted audio",
        { droppedSamples: dropped },
      );
    }

    const startOffset = this.committedOffset;
    const endOffset = writeOffset;
    const sampleLength =
      endOffset - startOffset;

    if (sampleLength < MIN_SEGMENT_SAMPLES) {
      return;
    }

    const audio = this.copySamples(
      startOffset,
      endOffset,
    );
    const history = this.getEnergyHistory();
    const trackedMaxRms = maxRmsForRange(
      history,
      startOffset,
      endOffset,
    );
    const maxRms =
      trackedMaxRms ??
      computeMaxWindowRms(
        audio,
        ENERGY_HOP_SAMPLES,
      );

    if (maxRms < SILENCE_RMS_THRESHOLD) {
      return;
    }

    const requestId =
      `seg:${this.nextRequestSequence}`;
    this.nextRequestSequence += 1;

    this.inFlight = {
      requestId,
      startOffset,
      endOffset,
      sampleLength,
    };
    this.busy = true;

    const message: WhisperTranscribeMessage = {
      t: "WHISPER_TRANSCRIBE",
      requestId,
      audio,
    };

    this.worker.postMessage(
      message,
      [audio.buffer as ArrayBuffer],
    );
  }

  private readonly handleWorkerMessage = (
    event: MessageEvent<unknown>,
  ): void => {
    if (
      !this.started ||
      !isWhisperWorkerOutputMessage(event.data)
    ) {
      return;
    }

    if (event.data.t === "WHISPER_RESULT") {
      this.handleResult(
        event.data.requestId,
        event.data.text,
      );
      return;
    }

    if (
      event.data.t === "WHISPER_ERROR" &&
      !event.data.fatal
    ) {
      this.handleTranscriptionError(
        event.data.requestId,
        event.data.message,
      );
    }
  };

  private handleResult(
    requestId: string,
    text: string,
  ): void {
    const segment = this.inFlight;

    if (
      segment === null ||
      segment.requestId !== requestId
    ) {
      return;
    }

    this.busy = false;
    this.inFlight = null;

    const normalizedText = text.trim();

    if (normalizedText.length > 0) {
      const lineId =
        this.currentLineId ??
        this.allocateLineId();

      this.currentLineId = lineId;

      this.onLine({
        id: lineId,
        text: normalizedText,
        final: false,
        at: this.now(),
      });

      const shouldCommitForSilence =
        hasTrailingSilence(
          this.getEnergyHistory(),
          segment.endOffset,
          TRAILING_SILENCE_SAMPLES,
          SILENCE_RMS_THRESHOLD,
          ENERGY_HOP_SAMPLES,
        );
      const shouldForceCommit =
        segment.sampleLength >
        MAX_SEGMENT_SAMPLES;

      if (
        shouldCommitForSilence ||
        shouldForceCommit
      ) {
        this.onLine({
          id: lineId,
          text: normalizedText,
          final: true,
          at: this.now(),
        });

        this.committedOffset =
          segment.endOffset;
        this.currentLineId = null;

        console.log("[seg]", "segment committed", {
          requestId,
          endOffset: segment.endOffset,
          reason: shouldForceCommit
            ? "maximum-length"
            : "trailing-silence",
        });
      }
    }

    queueMicrotask(() => {
      this.tick();
    });
  }

  private handleTranscriptionError(
    requestId: string | undefined,
    message: string,
  ): void {
    const segment = this.inFlight;

    if (
      segment === null ||
      requestId === undefined ||
      segment.requestId !== requestId
    ) {
      return;
    }

    this.busy = false;
    this.inFlight = null;

    console.warn(
      "[seg]",
      "transcription pass skipped",
      { requestId, message },
    );
    this.onError(message);

    queueMicrotask(() => {
      this.tick();
    });
  }

  private allocateLineId(): number {
    const id = this.nextLineId;
    this.nextLineId += 1;
    return id;
  }

  private getAvailableStartOffset(): number {
    return Math.max(
      0,
      this.getWriteOffset() -
      this.getCapacitySamples(),
    );
  }
}

export function maxRmsForRange(
  history: readonly AudioEnergyFrame[],
  startOffset: number,
  endOffset: number,
): number | null {
  let maximum: number | null = null;

  for (const frame of history) {
    if (
      frame.endOffset <= startOffset ||
      frame.startOffset >= endOffset
    ) {
      continue;
    }

    maximum =
      maximum === null
        ? frame.rms
        : Math.max(maximum, frame.rms);
  }

  return maximum;
}

export function hasTrailingSilence(
  history: readonly AudioEnergyFrame[],
  endOffset: number,
  durationSamples: number =
    TRAILING_SILENCE_SAMPLES,
  threshold: number = SILENCE_RMS_THRESHOLD,
  hopSamples: number = ENERGY_HOP_SAMPLES,
): boolean {
  const startOffset =
    endOffset - durationSamples;

  if (startOffset < 0) {
    return false;
  }

  const relevant = history.filter(
    (frame) =>
      frame.endOffset > startOffset &&
      frame.startOffset < endOffset,
  );

  if (relevant.length === 0) {
    return false;
  }

  const first = relevant[0];
  const last = relevant[relevant.length - 1];

  if (
    first === undefined ||
    last === undefined ||
    first.startOffset >
      startOffset + hopSamples ||
    last.endOffset <
      endOffset - hopSamples
  ) {
    return false;
  }

  return relevant.every(
    (frame) => frame.rms < threshold,
  );
}

export function computeMaxWindowRms(
  samples: Float32Array,
  windowSamples: number =
    ENERGY_HOP_SAMPLES,
): number {
  if (samples.length === 0) {
    return 0;
  }

  const safeWindow = Math.max(
    1,
    Math.floor(windowSamples),
  );
  let maximum = 0;

  for (
    let start = 0;
    start < samples.length;
    start += safeWindow
  ) {
    const end = Math.min(
      samples.length,
      start + safeWindow,
    );
    let sumSquares = 0;

    for (
      let index = start;
      index < end;
      index += 1
    ) {
      const sample = samples[index] ?? 0;
      sumSquares += sample * sample;
    }

    maximum = Math.max(
      maximum,
      Math.sqrt(
        sumSquares / Math.max(1, end - start),
      ),
    );
  }

  return maximum;
}
