import {
  isWhisperWorkerOutputMessage,
  nowIso,
  type WhisperTranscribeMessage,
} from "../shared/messages";
import type { AudioEnergyFrame } from "./audio-capture";

const SAMPLE_RATE = 16_000;
const TICK_INTERVAL_MS = 300;
const MIN_SEGMENT_SAMPLES = SAMPLE_RATE;
const MAX_SEGMENT_SAMPLES = SAMPLE_RATE * 8;
const SILENCE_TAIL_SAMPLES = SAMPLE_RATE;
const TRAILING_SILENCE_SAMPLES =
  Math.round(SAMPLE_RATE * 0.5);
const ENERGY_HOP_SAMPLES =
  Math.round(SAMPLE_RATE * 0.02);
const LOW_AUDIO_GROWTH_SAMPLES =
  Math.round(SAMPLE_RATE * 0.35);
const MAX_CLAUSE_WORDS = 10;

export const AGREEMENT_TIMEOUT_MS = 6_000;
export const SILENCE_RMS_THRESHOLD = 0.008;

const COORDINATING_CONJUNCTIONS =
  new Set([
    "and",
    "but",
    "or",
    "nor",
    "for",
    "so",
    "yet",
  ]);

interface HypothesisToken {
  surface: string;
  key: string;
  protected: boolean;
}

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
  showTentative?: boolean;
  now?: () => string;
  nowMs?: () => number;
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
  private readonly showTentative: boolean;
  private readonly now: () => string;
  private readonly nowMs: () => number;

  private committedOffset = 0;
  private busy = false;
  private started = false;
  private tickTimerId: number | null = null;
  private nextRequestSequence = 1;
  private nextLineId = 1;
  private inFlight: InFlightSegment | null = null;

  private previousHypothesis:
    HypothesisToken[] | null = null;
  private latestHypothesis:
    HypothesisToken[] = [];
  private promotedWordCount = 0;
  private clauseBuffer: HypothesisToken[] = [];
  private agreementSeriesStartedAt:
    number | null = null;
  private lastAgreementProgressAt:
    number | null = null;
  private lastHypothesisEndOffset:
    number | null = null;
  private lastTentativeId: number | null = null;
  private lastTentativeText = "";

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
    this.showTentative =
      options.showTentative ?? false;
    this.now = options.now ?? nowIso;
    this.nowMs =
      options.nowMs ?? (() => performance.now());
  }

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.committedOffset =
      this.getAvailableStartOffset();
    this.resetAgreementSeries();

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
    this.resetAgreementSeries();

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
      this.resetAgreementSeries();

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
    const sampledMaxRms = computeMaxWindowRms(
      audio,
      ENERGY_HOP_SAMPLES,
    );
    const maxRms =
      trackedMaxRms === null
        ? sampledMaxRms
        : Math.max(
            trackedMaxRms,
            sampledMaxRms,
          );

    if (maxRms < SILENCE_RMS_THRESHOLD) {
      this.committedOffset = Math.max(
        this.committedOffset,
        endOffset - SILENCE_TAIL_SAMPLES,
      );
      this.resetAgreementSeries();
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

    const shouldForceAudioBoundary =
      segment.sampleLength >=
      MAX_SEGMENT_SAMPLES;
    const shouldCommitForSilence =
      hasTrailingSilence(
        this.getEnergyHistory(),
        segment.endOffset,
        TRAILING_SILENCE_SAMPLES,
        SILENCE_RMS_THRESHOLD,
        ENERGY_HOP_SAMPLES,
      );

    let tokens = tokenizeHypothesis(text);

    if (
      this.shouldRejectRepetitionGrowth(
        tokens,
        segment.endOffset,
      )
    ) {
      console.warn(
        "[seg]",
        "discarded repetition growth without corresponding audio growth",
        {
          requestId,
          endOffset: segment.endOffset,
        },
      );

      tokens =
        this.previousHypothesis === null
          ? []
          : [...this.previousHypothesis];
    }

    this.lastHypothesisEndOffset =
      segment.endOffset;

    if (tokens.length > 0) {
      this.latestHypothesis = tokens;
      this.processAgreement(tokens);

      if (
        shouldCommitForSilence ||
        shouldForceAudioBoundary
      ) {
        this.forceAdoptLatest(
          shouldForceAudioBoundary
            ? "maximum-length"
            : "trailing-silence",
          true,
        );
        this.commitSegment(
          segment,
          shouldForceAudioBoundary
            ? "maximum-length"
            : "trailing-silence",
        );
      } else {
        this.forceAgreementIfTimedOut();
        this.emitTentative();
      }
    } else if (
      shouldCommitForSilence ||
      shouldForceAudioBoundary
    ) {
      this.forceAdoptLatest(
        shouldForceAudioBoundary
          ? "maximum-length-empty"
          : "trailing-silence-empty",
        true,
      );
      this.commitSegment(
        segment,
        shouldForceAudioBoundary
          ? "maximum-length-empty"
          : "trailing-silence-empty",
      );
    }

    queueMicrotask(() => {
      this.tick();
    });
  }

  private processAgreement(
    tokens: HypothesisToken[],
  ): void {
    const observedAt = this.nowMs();

    if (this.agreementSeriesStartedAt === null) {
      this.agreementSeriesStartedAt =
        observedAt;
      this.lastAgreementProgressAt =
        observedAt;
    }

    const previous = this.previousHypothesis;
    this.previousHypothesis = tokens;

    if (previous === null) {
      return;
    }

    const agreedCount =
      longestCommonPrefixLength(
        previous.map((token) => token.key),
        tokens.map((token) => token.key),
      );

    if (agreedCount <= this.promotedWordCount) {
      return;
    }

    const newlyCommitted = tokens.slice(
      this.promotedWordCount,
      agreedCount,
    );

    this.promotedWordCount = agreedCount;
    this.lastAgreementProgressAt =
      observedAt;
    this.clauseBuffer.push(
      ...cloneTokens(newlyCommitted),
    );
    this.drainClauseBuffer(false);
  }

  private forceAgreementIfTimedOut(): void {
    if (
      this.latestHypothesis.length === 0 ||
      this.lastAgreementProgressAt === null ||
      this.nowMs() -
        this.lastAgreementProgressAt <
        AGREEMENT_TIMEOUT_MS
    ) {
      return;
    }

    this.forceAdoptLatest(
      "agreement-timeout",
      true,
    );
    this.lastAgreementProgressAt =
      this.nowMs();
  }

  private forceAdoptLatest(
    reason: string,
    flush: boolean,
  ): void {
    if (
      this.latestHypothesis.length >
      this.promotedWordCount
    ) {
      this.clauseBuffer.push(
        ...cloneTokens(
          this.latestHypothesis.slice(
            this.promotedWordCount,
          ),
        ),
      );
      this.promotedWordCount =
        this.latestHypothesis.length;
    }

    this.drainClauseBuffer(flush);

    console.log(
      "[seg]",
      "latest hypothesis force-adopted",
      {
        reason,
        promotedWords:
          this.promotedWordCount,
      },
    );
  }

  private drainClauseBuffer(
    flush: boolean,
  ): void {
    while (this.clauseBuffer.length > 0) {
      const boundary =
        findNextClauseBoundary(
          this.clauseBuffer,
          flush,
        );

      if (boundary === null) {
        return;
      }

      const clauseTokens =
        this.clauseBuffer.splice(
          0,
          boundary,
        );
      const clause =
        joinTokenSurfaces(
          clauseTokens,
        ).trim();

      if (clause === "") {
        continue;
      }

      const id = this.nextLineId;
      this.nextLineId += 1;

      this.onLine({
        id,
        text: clause,
        final: true,
        at: this.now(),
      });

      this.lastTentativeId = null;
      this.lastTentativeText = "";
    }
  }

  private emitTentative(): void {
    if (!this.showTentative) {
      return;
    }

    const unstableTokens =
      this.latestHypothesis.slice(
        this.promotedWordCount,
      );
    const tentative = joinTokenSurfaces([
      ...this.clauseBuffer,
      ...unstableTokens,
    ]).trim();

    if (tentative === "") {
      return;
    }

    const id = this.nextLineId;

    if (
      this.lastTentativeId === id &&
      this.lastTentativeText === tentative
    ) {
      return;
    }

    this.lastTentativeId = id;
    this.lastTentativeText = tentative;

    this.onLine({
      id,
      text: tentative,
      final: false,
      at: this.now(),
    });
  }

  private shouldRejectRepetitionGrowth(
    current: readonly HypothesisToken[],
    endOffset: number,
  ): boolean {
    const previous = this.previousHypothesis;
    const previousEnd =
      this.lastHypothesisEndOffset;

    if (
      previous === null ||
      previousEnd === null ||
      endOffset - previousEnd >
        LOW_AUDIO_GROWTH_SAMPLES ||
      current.length <= previous.length
    ) {
      return false;
    }

    return (
      repeatedNgramExcess(current) >
      repeatedNgramExcess(previous)
    );
  }

  private commitSegment(
    segment: InFlightSegment,
    reason: string,
  ): void {
    this.committedOffset =
      segment.endOffset;
    this.resetAgreementSeries();

    console.log("[seg]", "segment committed", {
      requestId: segment.requestId,
      endOffset: segment.endOffset,
      reason,
    });
  }

  private resetAgreementSeries(): void {
    this.previousHypothesis = null;
    this.latestHypothesis = [];
    this.promotedWordCount = 0;
    this.clauseBuffer = [];
    this.agreementSeriesStartedAt = null;
    this.lastAgreementProgressAt = null;
    this.lastHypothesisEndOffset = null;
    this.lastTentativeId = null;
    this.lastTentativeText = "";
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

  private getAvailableStartOffset(): number {
    return Math.max(
      0,
      this.getWriteOffset() -
        this.getCapacitySamples(),
    );
  }
}

export function normalizeForAgreement(
  text: string,
): string[] {
  return tokenizeHypothesis(text).map(
    (token) => token.key,
  );
}

export function longestCommonPrefixLength(
  left: readonly string[],
  right: readonly string[],
): number {
  const maximum = Math.min(
    left.length,
    right.length,
  );
  let index = 0;

  while (
    index < maximum &&
    left[index] === right[index]
  ) {
    index += 1;
  }

  return index;
}

export function splitEnglishClauses(
  text: string,
): string[] {
  const buffer = tokenizeHypothesis(text);
  const clauses: string[] = [];

  while (buffer.length > 0) {
    const boundary =
      findNextClauseBoundary(
        buffer,
        true,
      );

    if (boundary === null) {
      break;
    }

    const clause = joinTokenSurfaces(
      buffer.splice(0, boundary),
    ).trim();

    if (clause !== "") {
      clauses.push(clause);
    }
  }

  return clauses;
}

function tokenizeHypothesis(
  text: string,
): HypothesisToken[] {
  const rawTokens =
    text.normalize("NFKC").match(/\S+/gu) ?? [];
  const tokens: HypothesisToken[] = [];
  let quoteOpen = false;

  for (const raw of rawTokens) {
    const quoteCount =
      (raw.match(/[“”„‟「」『』"]/gu) ?? [])
        .length;
    const isUrl =
      /^(?:https?:\/\/|www\.)/iu.test(raw);
    const protectedToken =
      isUrl || quoteOpen || quoteCount > 0;
    const key = normalizeTokenKey(raw);

    if (key === "") {
      const previous =
        tokens[tokens.length - 1];

      if (previous !== undefined) {
        previous.surface += raw;
      }

      if (quoteCount % 2 === 1) {
        quoteOpen = !quoteOpen;
      }
      continue;
    }

    tokens.push({
      surface: raw,
      key,
      protected: protectedToken,
    });

    if (quoteCount % 2 === 1) {
      quoteOpen = !quoteOpen;
    }
  }

  return tokens;
}

function normalizeTokenKey(
  token: string,
): string {
  return token
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[’‘`]/gu, "'")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function cloneTokens(
  tokens: readonly HypothesisToken[],
): HypothesisToken[] {
  return tokens.map((token) => ({
    ...token,
  }));
}

function findNextClauseBoundary(
  tokens: readonly HypothesisToken[],
  flush: boolean,
): number | null {
  for (
    let index = 0;
    index < tokens.length;
    index += 1
  ) {
    const token = tokens[index];
    const next = tokens[index + 1];

    if (
      token !== undefined &&
      !token.protected &&
      /[.?!][”"』」）\]]*$/u.test(
        token.surface,
      )
    ) {
      return index + 1;
    }

    if (
      token !== undefined &&
      next !== undefined &&
      !token.protected &&
      /,[”"』」）\]]*$/u.test(
        token.surface,
      ) &&
      COORDINATING_CONJUNCTIONS.has(
        next.key,
      ) &&
      !isProtectedBoundary(
        tokens,
        index + 1,
      )
    ) {
      return index + 1;
    }
  }

  if (tokens.length > MAX_CLAUSE_WORDS) {
    const forced =
      findForcedWordBoundary(tokens);

    if (forced !== null) {
      return forced;
    }
  }

  return flush ? tokens.length : null;
}

function findForcedWordBoundary(
  tokens: readonly HypothesisToken[],
): number | null {
  const preferredMaximum = Math.min(
    MAX_CLAUSE_WORDS,
    tokens.length - 1,
  );

  for (
    let boundary = preferredMaximum;
    boundary >= 5;
    boundary -= 1
  ) {
    const previous = tokens[boundary - 1];
    const next = tokens[boundary];

    if (
      !isProtectedBoundary(
        tokens,
        boundary,
      ) &&
      (
        (
          previous !== undefined &&
          /[,;:][”"』」）\]]*$/u.test(
            previous.surface,
          )
        ) ||
        (
          next !== undefined &&
          COORDINATING_CONJUNCTIONS.has(
            next.key,
          )
        )
      )
    ) {
      return boundary;
    }
  }

  if (
    !isProtectedBoundary(
      tokens,
      preferredMaximum,
    )
  ) {
    return preferredMaximum;
  }

  for (
    let boundary =
      preferredMaximum + 1;
    boundary < tokens.length;
    boundary += 1
  ) {
    if (
      !isProtectedBoundary(
        tokens,
        boundary,
      )
    ) {
      return boundary;
    }
  }

  return null;
}

function isProtectedBoundary(
  tokens: readonly HypothesisToken[],
  boundary: number,
): boolean {
  const left = tokens[boundary - 1];
  const right = tokens[boundary];

  return (
    left !== undefined &&
    right !== undefined &&
    left.protected &&
    right.protected
  );
}

function joinTokenSurfaces(
  tokens: readonly HypothesisToken[],
): string {
  return tokens
    .map((token) => token.surface)
    .join(" ")
    .replace(
      /\s+([,.;:!?%。，、！？：；）\]」』])/gu,
      "$1",
    )
    .replace(
      /([（\[「『“"])\s+/gu,
      "$1",
    );
}

function repeatedNgramExcess(
  tokens: readonly HypothesisToken[],
): number {
  const keys = tokens.map(
    (token) => token.key,
  );
  let excess = 0;

  for (const size of [2, 3]) {
    const counts = new Map<string, number>();

    for (
      let index = 0;
      index + size <= keys.length;
      index += 1
    ) {
      const ngram = keys
        .slice(index, index + size)
        .join("\u0000");
      counts.set(
        ngram,
        (counts.get(ngram) ?? 0) + 1,
      );
    }

    for (const count of counts.values()) {
      excess += Math.max(0, count - 1);
    }
  }

  return excess;
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
        sumSquares /
          Math.max(1, end - start),
      ),
    );
  }

  return maximum;
}
