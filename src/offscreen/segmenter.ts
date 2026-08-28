import {
  isWhisperWorkerOutputMessage,
  MAX_CONTEXT_TERMS,
  nowIso,
  type WhisperTranscribeMessage,
} from "../shared/messages";
import type { AudioEnergyFrame } from "./audio-capture";

const SAMPLE_RATE = 16_000;
const TICK_INTERVAL_MS = 300;
const MIN_SEGMENT_SAMPLES = SAMPLE_RATE;
const MIN_EOS_FLUSH_SAMPLES =
  Math.round(SAMPLE_RATE * 0.3);
const MAX_SEGMENT_SAMPLES = SAMPLE_RATE * 8;
const SILENCE_TAIL_SAMPLES = SAMPLE_RATE;
const TRAILING_SILENCE_SAMPLES =
  Math.round(SAMPLE_RATE * 0.5);
const ENERGY_HOP_SAMPLES =
  Math.round(SAMPLE_RATE * 0.02);
const LOW_AUDIO_GROWTH_SAMPLES =
  Math.round(SAMPLE_RATE * 0.35);
const MAX_CLAUSE_WORDS = 10;
const MIN_STANDALONE_CLAUSE_WORDS = 4;
const DIAGNOSTIC_LOG_INTERVAL_MS = 5_000;

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

const COMMON_ENGLISH_WORDS =
  new Set([
    "about",
    "after",
    "again",
    "against",
    "also",
    "another",
    "because",
    "before",
    "being",
    "between",
    "both",
    "could",
    "does",
    "doing",
    "during",
    "each",
    "even",
    "every",
    "first",
    "from",
    "going",
    "great",
    "grow",
    "have",
    "having",
    "here",
    "into",
    "just",
    "know",
    "last",
    "like",
    "little",
    "look",
    "made",
    "make",
    "many",
    "more",
    "most",
    "much",
    "need",
    "never",
    "next",
    "only",
    "other",
    "over",
    "people",
    "really",
    "right",
    "same",
    "should",
    "some",
    "something",
    "still",
    "such",
    "take",
    "than",
    "thank",
    "thanks",
    "that",
    "their",
    "them",
    "then",
    "there",
    "these",
    "they",
    "thing",
    "think",
    "this",
    "those",
    "through",
    "today",
    "under",
    "very",
    "want",
    "watching",
    "well",
    "were",
    "what",
    "when",
    "where",
    "which",
    "while",
    "will",
    "with",
    "would",
    "your",
  ]);

const HALLUCINATION_PHRASE_BLACKLIST:
  readonly RegExp[] = [
    /^(?:[.\u2026·・]\s*){2,}$/u,
    /^please subscribe(?: to (?:my|our|the) channel)?[.!?。！？]*$/iu,
    /^subscribe(?: to (?:my|our|the) channel)?[.!?。！？]*$/iu,
    /^(?:do not|don't) forget to subscribe(?: to (?:my|our|the) channel)?[.!?。！？]*$/iu,
    /^like and subscribe(?: to (?:my|our|the) channel)?[.!?。！？]*$/iu,
    /^please like,? share,? and subscribe[.!?。！？]*$/iu,
    /^thanks for watching[.!?。！？]*$/iu,
    /^thank you for watching[.!?。！？]*$/iu,
    /^see you in (?:the )?next video[.!?。！？]*$/iu,
    /^see you next time[.!?。！？]*$/iu,
  ];

interface HypothesisToken {
  surface: string;
  key: string;
  protected: boolean;
}

interface ProperNounEntry {
  surface: string;
  key: string;
  mention: boolean;
  maximumDistance: number;
}

interface ProperNounCorrection {
  from: string;
  to: string;
}

interface CorrectedClause {
  text: string;
  corrections: ProperNounCorrection[];
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
  properNouns?: readonly string[];
  showTentative?: boolean;
  now?: () => string;
  nowMs?: () => number;
}

interface InFlightSegment {
  requestId: string;
  startOffset: number;
  endOffset: number;
  sampleLength: number;
  maxRms: number;
  flush: boolean;
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
  private eosPending = false;
  private eosTargetOffset:
    | number
    | null = null;
  private eosCompletedOffset:
    | number
    | null = null;
  private eosTranscriptionIssued = false;

  private previousHypothesis:
    HypothesisToken[] | null = null;
  private latestHypothesis:
    HypothesisToken[] = [];
  private promotedWordCount = 0;
  private clauseBuffer: HypothesisToken[] = [];
  private heldShortClause:
    HypothesisToken[] = [];
  private agreementSeriesStartedAt:
    number | null = null;
  private lastAgreementProgressAt:
    number | null = null;
  private lastHypothesisEndOffset:
    number | null = null;
  private lastTentativeId: number | null = null;
  private lastTentativeText = "";

  private properNouns: ProperNounEntry[] = [];
  private pendingCorrectionLogCount = 0;
  private lastCorrectionLogAt =
    Number.NEGATIVE_INFINITY;
  private pendingHallucinationDropCount = 0;
  private lastHallucinationLogAt =
    Number.NEGATIVE_INFINITY;

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

    this.setProperNounDictionary(
      options.properNouns ?? [],
    );
  }

  setProperNounDictionary(
    terms: readonly string[],
  ): void {
    this.properNouns =
      buildProperNounDictionary(terms);
  }

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.committedOffset =
      this.getAvailableStartOffset();
    this.resetAgreementSeries();
    this.resetEndOfStreamState();

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

    if (this.hasPendingRecognitionText()) {
      this.forceAdoptLatest(
        "stop",
        true,
        true,
        false,
      );
    }

    this.started = false;
    this.busy = false;
    this.inFlight = null;
    this.resetAgreementSeries();
    this.resetEndOfStreamState();

    if (this.tickTimerId !== null) {
      globalThis.clearInterval(
        this.tickTimerId,
      );
      this.tickTimerId = null;
    }

    this.worker.removeEventListener(
      "message",
      this.handleWorkerMessage,
    );
  }

  flushPendingAudio(): void {
    if (!this.started) {
      return;
    }

    const writeOffset = this.getWriteOffset();

    if (
      this.eosPending ||
      (
        this.eosCompletedOffset !== null &&
        writeOffset <=
          this.eosCompletedOffset
      )
    ) {
      return;
    }

    this.eosPending = true;
    this.eosTargetOffset = writeOffset;
    this.eosCompletedOffset = null;
    this.eosTranscriptionIssued = false;

    if (!this.busy) {
      this.processEndOfStreamFlush();
    }
  }

  tick(): void {
    if (!this.started) {
      return;
    }

    const writeOffset = this.getWriteOffset();

    this.resumeAfterEndOfStream(
      writeOffset,
    );

    if (this.eosPending) {
      if (!this.busy) {
        this.processEndOfStreamFlush();
      }
      return;
    }

    this.forceAgreementIfTimedOut();

    if (this.busy) {
      return;
    }

    const capacity = this.getCapacitySamples();
    const availableStart = Math.max(
      0,
      writeOffset - capacity,
    );

    if (this.committedOffset < availableStart) {
      const dropped =
        availableStart - this.committedOffset;

      if (this.hasPendingRecognitionText()) {
        this.forceAdoptLatest(
          "ring-buffer-overflow",
          true,
          true,
          false,
        );
      }

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
      if (this.hasPendingRecognitionText()) {
        this.forceAdoptLatest(
          "low-audio-fade",
          true,
          true,
          true,
        );
      }

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
      maxRms,
      flush: false,
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

    if (segment.flush) {
      this.handleEndOfStreamResult(
        segment,
        text,
      );
      return;
    }

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
    const lowAudioAtCommit =
      shouldCommitForSilence;

    let tokens = tokenizeHypothesis(text);

    if (
      this.shouldRejectRepetitionGrowth(
        tokens,
        segment.endOffset,
      )
    ) {
      console.info(
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
      this.processAgreement(
        tokens,
        lowAudioAtCommit,
      );

      if (
        shouldCommitForSilence ||
        shouldForceAudioBoundary
      ) {
        this.forceAdoptLatest(
          shouldForceAudioBoundary
            ? "maximum-length"
            : "trailing-silence",
          true,
          true,
          lowAudioAtCommit,
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
      const wholePendingWindowSilent =
        segment.maxRms <
        SILENCE_RMS_THRESHOLD;

      if (wholePendingWindowSilent) {
        this.forceAdoptLatest(
          shouldForceAudioBoundary
            ? "maximum-length-empty"
            : "trailing-silence-empty",
          true,
          true,
          true,
        );
        this.commitSegment(
          segment,
          shouldForceAudioBoundary
            ? "maximum-length-empty"
            : "trailing-silence-empty",
        );
      } else {
        this.forceAgreementIfTimedOut();
        this.emitTentative();
      }
    } else {
      this.forceAgreementIfTimedOut();
      this.emitTentative();
    }

    if (this.eosPending) {
      this.continueEndOfStreamAfterResult(
        segment,
      );
    }

    queueMicrotask(() => {
      this.tick();
    });
  }

  private handleEndOfStreamResult(
    segment: InFlightSegment,
    text: string,
  ): void {
    let tokens = tokenizeHypothesis(text);

    if (
      this.shouldRejectRepetitionGrowth(
        tokens,
        segment.endOffset,
      )
    ) {
      console.info(
        "[seg]",
        "discarded repetition growth during end-of-stream flush",
        {
          requestId: segment.requestId,
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

    const lowAudioConfidence =
      segment.maxRms <
      SILENCE_RMS_THRESHOLD;

    if (tokens.length > 0) {
      this.latestHypothesis = tokens;
      this.processAgreement(
        tokens,
        lowAudioConfidence,
      );
    }

    if (this.hasPendingRecognitionText()) {
      this.forceAdoptLatest(
        "end-of-stream",
        true,
        true,
        lowAudioConfidence,
      );
    }

    this.commitSegment(
      segment,
      "end-of-stream",
    );
    this.completeEndOfStreamFlush(
      segment.endOffset,
    );

    queueMicrotask(() => {
      this.tick();
    });
  }

  private continueEndOfStreamAfterResult(
    segment: InFlightSegment,
  ): void {
    const targetOffset =
      this.eosTargetOffset;

    if (
      !this.eosPending ||
      targetOffset === null
    ) {
      return;
    }

    if (
      this.getWriteOffset() >
      targetOffset
    ) {
      this.resetEndOfStreamState();
      return;
    }

    if (
      this.committedOffset <
      segment.endOffset
    ) {
      if (
        this.hasPendingRecognitionText()
      ) {
        this.forceAdoptLatest(
          "end-of-stream-in-flight",
          true,
          true,
          segment.maxRms <
            SILENCE_RMS_THRESHOLD,
        );
      }

      this.commitSegment(
        segment,
        "end-of-stream-in-flight",
      );
    }

    this.processEndOfStreamFlush();
  }

  private processEndOfStreamFlush(): void {
    if (
      !this.started ||
      !this.eosPending ||
      this.busy
    ) {
      return;
    }

    const targetOffset =
      this.eosTargetOffset;

    if (targetOffset === null) {
      this.resetEndOfStreamState();
      return;
    }

    if (
      this.getWriteOffset() >
      targetOffset
    ) {
      this.resetEndOfStreamState();
      return;
    }

    const availableStart =
      this.getAvailableStartOffset();

    if (
      this.committedOffset <
      availableStart
    ) {
      if (
        this.hasPendingRecognitionText()
      ) {
        this.forceAdoptLatest(
          "end-of-stream-ring-buffer-overflow",
          true,
          true,
          false,
        );
      }

      this.committedOffset =
        availableStart;
      this.resetAgreementSeries();
    }

    const startOffset =
      this.committedOffset;
    const sampleLength =
      targetOffset - startOffset;

    if (
      sampleLength <
      MIN_EOS_FLUSH_SAMPLES
    ) {
      if (
        this.hasPendingRecognitionText()
      ) {
        this.forceAdoptLatest(
          "end-of-stream-short-audio",
          true,
          true,
          false,
        );
      }

      this.committedOffset = Math.max(
        this.committedOffset,
        targetOffset,
      );
      this.resetAgreementSeries();
      this.completeEndOfStreamFlush(
        targetOffset,
      );
      return;
    }

    if (this.eosTranscriptionIssued) {
      this.completeEndOfStreamFlush(
        targetOffset,
      );
      return;
    }

    const audio = this.copySamples(
      startOffset,
      targetOffset,
    );
    const history = this.getEnergyHistory();
    const trackedMaxRms = maxRmsForRange(
      history,
      startOffset,
      targetOffset,
    );
    const sampledMaxRms =
      computeMaxWindowRms(
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
    const requestId =
      `seg:${this.nextRequestSequence}`;

    this.nextRequestSequence += 1;
    this.eosTranscriptionIssued = true;
    this.inFlight = {
      requestId,
      startOffset,
      endOffset: targetOffset,
      sampleLength,
      maxRms,
      flush: true,
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

  private completeEndOfStreamFlush(
    completedOffset: number,
  ): void {
    this.eosPending = false;
    this.eosTargetOffset = null;
    this.eosCompletedOffset =
      completedOffset;
    this.eosTranscriptionIssued = false;
  }

  private resumeAfterEndOfStream(
    writeOffset: number,
  ): void {
    const boundary =
      this.eosTargetOffset ??
      this.eosCompletedOffset;

    if (
      boundary !== null &&
      writeOffset > boundary
    ) {
      this.resetEndOfStreamState();
    }
  }

  private resetEndOfStreamState(): void {
    this.eosPending = false;
    this.eosTargetOffset = null;
    this.eosCompletedOffset = null;
    this.eosTranscriptionIssued = false;
  }

  private processAgreement(
    tokens: HypothesisToken[],
    lowAudioConfidence: boolean,
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
    this.drainClauseBuffer(
      false,
      false,
      lowAudioConfidence,
    );
  }

  private forceAgreementIfTimedOut(): void {
    const timeoutStartedAt =
      this.lastAgreementProgressAt ??
      this.agreementSeriesStartedAt;
    const hasUnflushedText =
      this.latestHypothesis.length >
        this.promotedWordCount ||
      this.clauseBuffer.length > 0 ||
      this.heldShortClause.length > 0;
    const observedAt = this.nowMs();

    if (
      !hasUnflushedText ||
      timeoutStartedAt === null ||
      observedAt - timeoutStartedAt <
        AGREEMENT_TIMEOUT_MS
    ) {
      return;
    }

    this.forceAdoptLatest(
      "agreement-timeout",
      true,
      true,
      false,
    );
    this.lastAgreementProgressAt =
      observedAt;
  }

  private forceAdoptLatest(
    reason: string,
    flush: boolean,
    flushShortClause: boolean,
    lowAudioConfidence: boolean,
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

    this.drainClauseBuffer(
      flush,
      flushShortClause,
      lowAudioConfidence,
    );

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
    flushShortClause: boolean,
    lowAudioConfidence: boolean,
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

      if (clauseTokens.length === 0) {
        continue;
      }

      if (this.heldShortClause.length > 0) {
        const merged = [
          ...this.heldShortClause,
          ...clauseTokens,
        ];

        this.heldShortClause = [];
        this.emitCommittedClause(
          merged,
          lowAudioConfidence,
        );
        continue;
      }

      if (
        clauseTokens.length <
        MIN_STANDALONE_CLAUSE_WORDS
      ) {
        if (this.clauseBuffer.length > 0) {
          this.heldShortClause =
            cloneTokens(clauseTokens);
          continue;
        }

        if (!flushShortClause) {
          this.heldShortClause =
            cloneTokens(clauseTokens);
          return;
        }
      }

      this.emitCommittedClause(
        clauseTokens,
        lowAudioConfidence,
      );
    }

    if (
      flushShortClause &&
      this.heldShortClause.length > 0
    ) {
      const held =
        this.heldShortClause;
      this.heldShortClause = [];

      this.emitCommittedClause(
        held,
        lowAudioConfidence,
      );
    }
  }

  private emitCommittedClause(
    clauseTokens: readonly HypothesisToken[],
    lowAudioConfidence: boolean,
  ): void {
    const clause =
      joinTokenSurfaces(clauseTokens)
        .replace(/\s+/gu, " ")
        .trim();

    if (clause === "") {
      return;
    }

    if (
      lowAudioConfidence &&
      isBlacklistedHallucination(clause)
    ) {
      this.logHallucinationDrop(clause);
      this.clearTentativeState();
      return;
    }

    const corrected =
      correctProperNouns(
        clause,
        this.properNouns,
      );

    if (corrected.corrections.length > 0) {
      this.logProperNounCorrections(
        corrected.corrections,
      );
    }

    const id = this.nextLineId;
    this.nextLineId += 1;

    this.onLine({
      id,
      text: corrected.text,
      final: true,
      at: this.now(),
    });

    this.clearTentativeState();
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
      ...this.heldShortClause,
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
      maxRms: segment.maxRms,
      reason,
    });
  }

  private resetAgreementSeries(): void {
    this.previousHypothesis = null;
    this.latestHypothesis = [];
    this.promotedWordCount = 0;
    this.clauseBuffer = [];
    this.heldShortClause = [];
    this.agreementSeriesStartedAt = null;
    this.lastAgreementProgressAt = null;
    this.lastHypothesisEndOffset = null;
    this.clearTentativeState();
  }

  private clearTentativeState(): void {
    this.lastTentativeId = null;
    this.lastTentativeText = "";
  }

  private hasPendingRecognitionText(): boolean {
    return (
      this.latestHypothesis.length > 0 ||
      this.clauseBuffer.length > 0 ||
      this.heldShortClause.length > 0
    );
  }

  private logProperNounCorrections(
    corrections:
      readonly ProperNounCorrection[],
  ): void {
    this.pendingCorrectionLogCount +=
      corrections.length;

    const observedAt = this.nowMs();

    if (
      observedAt -
        this.lastCorrectionLogAt <
      DIAGNOSTIC_LOG_INTERVAL_MS
    ) {
      return;
    }

    console.info(
      "[seg]",
      "proper-noun corrections applied",
      {
        count:
          this.pendingCorrectionLogCount,
        examples: corrections.slice(0, 3),
      },
    );

    this.pendingCorrectionLogCount = 0;
    this.lastCorrectionLogAt = observedAt;
  }

  private logHallucinationDrop(
    clause: string,
  ): void {
    this.pendingHallucinationDropCount += 1;

    const observedAt = this.nowMs();

    if (
      observedAt -
        this.lastHallucinationLogAt <
      DIAGNOSTIC_LOG_INTERVAL_MS
    ) {
      return;
    }

    console.info(
      "[seg]",
      "low-audio hallucination clause dropped",
      {
        count:
          this.pendingHallucinationDropCount,
        clause,
      },
    );

    this.pendingHallucinationDropCount = 0;
    this.lastHallucinationLogAt =
      observedAt;
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

    if (segment.flush) {
      if (
        this.hasPendingRecognitionText()
      ) {
        this.forceAdoptLatest(
          "end-of-stream-error",
          true,
          true,
          false,
        );
      }

      this.committedOffset = Math.max(
        this.committedOffset,
        segment.endOffset,
      );
      this.resetAgreementSeries();
      this.completeEndOfStreamFlush(
        segment.endOffset,
      );
    } else {
      this.forceAgreementIfTimedOut();
    }

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
  let heldShortClause:
    HypothesisToken[] = [];

  while (buffer.length > 0) {
    const boundary =
      findNextClauseBoundary(
        buffer,
        true,
      );

    if (boundary === null) {
      break;
    }

    const clauseTokens =
      buffer.splice(0, boundary);

    if (heldShortClause.length > 0) {
      const clause = joinTokenSurfaces([
        ...heldShortClause,
        ...clauseTokens,
      ]).trim();

      heldShortClause = [];

      if (clause !== "") {
        clauses.push(clause);
      }
      continue;
    }

    if (
      clauseTokens.length <
        MIN_STANDALONE_CLAUSE_WORDS &&
      buffer.length > 0
    ) {
      heldShortClause =
        cloneTokens(clauseTokens);
      continue;
    }

    const clause =
      joinTokenSurfaces(
        clauseTokens,
      ).trim();

    if (clause !== "") {
      clauses.push(clause);
    }
  }

  if (heldShortClause.length > 0) {
    const clause =
      joinTokenSurfaces(
        heldShortClause,
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

function buildProperNounDictionary(
  terms: readonly string[],
): ProperNounEntry[] {
  const entries: ProperNounEntry[] = [];
  const seen = new Set<string>();

  for (const rawTerm of terms) {
    if (entries.length >= MAX_CONTEXT_TERMS) {
      break;
    }

    const surface = rawTerm
      .normalize("NFKC")
      .trim()
      .replace(/\s+/gu, " ");

    if (
      Array.from(surface).length < 4 ||
      /\s/u.test(surface) ||
      !/^@?[\p{L}\p{N}][\p{L}\p{M}\p{N}'’._-]*$/u.test(
        surface,
      ) ||
      !isCapitalizedDictionaryTerm(surface)
    ) {
      continue;
    }

    const mention = surface.startsWith("@");
    const comparisonSurface = mention
      ? surface.slice(1)
      : surface;
    const key = normalizeTokenKey(
      comparisonSurface,
    );

    if (
      key.length === 0 ||
      seen.has(key) ||
      COMMON_ENGLISH_WORDS.has(key)
    ) {
      continue;
    }

    seen.add(key);
    entries.push({
      surface,
      key,
      mention,
      maximumDistance:
        mention || key.length <= 5 ? 1 : 2,
    });
  }

  return entries;
}

function correctProperNouns(
  clause: string,
  dictionary: readonly ProperNounEntry[],
): CorrectedClause {
  if (dictionary.length === 0) {
    return {
      text: clause,
      corrections: [],
    };
  }

  const tokens = tokenizeHypothesis(clause);
  const corrections:
    ProperNounCorrection[] = [];

  for (const token of tokens) {
    if (
      token.protected ||
      token.key.length < 4
    ) {
      continue;
    }

    const hypothesisCapitalized =
      isCapitalizedTokenSurface(
        token.surface,
      );

    let bestEntry:
      | ProperNounEntry
      | null = null;
    let bestDistance =
      Number.POSITIVE_INFINITY;
    let ambiguous = false;

    for (const entry of dictionary) {
      if (
        (
          !hypothesisCapitalized &&
          !entry.mention
        ) ||
        Math.abs(
          token.key.length -
            entry.key.length,
        ) > entry.maximumDistance
      ) {
        continue;
      }

      const distance =
        levenshteinDistanceWithin(
          token.key,
          entry.key,
          entry.maximumDistance,
        );

      if (distance === null) {
        continue;
      }

      if (distance < bestDistance) {
        bestEntry = entry;
        bestDistance = distance;
        ambiguous = false;
        continue;
      }

      if (
        distance === bestDistance &&
        bestEntry !== null &&
        entry.key !== bestEntry.key
      ) {
        ambiguous = true;
      }
    }

    if (
      bestEntry === null ||
      ambiguous ||
      COMMON_ENGLISH_WORDS.has(token.key)
    ) {
      continue;
    }

    const replacement =
      replaceTokenCore(
        token.surface,
        bestEntry.surface,
      );

    if (
      replacement === null ||
      replacement === token.surface
    ) {
      continue;
    }

    corrections.push({
      from: token.surface,
      to: replacement,
    });
    token.surface = replacement;
    token.key = bestEntry.key;
  }

  return {
    text: joinTokenSurfaces(tokens).trim(),
    corrections,
  };
}

function isCapitalizedDictionaryTerm(
  term: string,
): boolean {
  return (
    term.startsWith("@") ||
    /^\p{Lu}/u.test(term)
  );
}

function isCapitalizedTokenSurface(
  surface: string,
): boolean {
  const core = surface.replace(
    /^[^\p{L}\p{N}@]+/u,
    "",
  );
  const comparisonSurface =
    core.startsWith("@")
      ? core.slice(1)
      : core;

  return /^\p{Lu}/u.test(
    comparisonSurface,
  );
}

function replaceTokenCore(
  surface: string,
  replacement: string,
): string | null {
  const match = surface.match(
    /^([^\p{L}\p{N}@]*)(@?[\p{L}\p{N}][\p{L}\p{M}\p{N}'’._-]*)([^\p{L}\p{N}]*)$/u,
  );

  if (match === null) {
    return null;
  }

  // A possessive on the recognized token ("OpenAI's") survives the
  // replacement — unless the dictionary surface already carries one
  // ("OpenAI's" + "'s" would double up).
  const possessive =
    /['’]s$/iu.test(replacement)
      ? ""
      : (match[2] ?? "").match(/['’]s$/iu)?.[0] ??
        "";

  return (
    (match[1] ?? "") +
    replacement +
    possessive +
    (match[3] ?? "")
  );
}

function levenshteinDistanceWithin(
  left: string,
  right: string,
  maximum: number,
): number | null {
  if (
    Math.abs(left.length - right.length) >
    maximum
  ) {
    return null;
  }

  let previous =
    Array.from(
      { length: right.length + 1 },
      (_unused, index) => index,
    );

  for (
    let leftIndex = 1;
    leftIndex <= left.length;
    leftIndex += 1
  ) {
    const current = [leftIndex];
    let rowMinimum = leftIndex;

    for (
      let rightIndex = 1;
      rightIndex <= right.length;
      rightIndex += 1
    ) {
      const substitutionCost =
        left[leftIndex - 1] ===
        right[rightIndex - 1]
          ? 0
          : 1;
      const value = Math.min(
        (previous[rightIndex] ?? 0) + 1,
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) +
          substitutionCost,
      );

      current.push(value);
      rowMinimum = Math.min(
        rowMinimum,
        value,
      );
    }

    if (rowMinimum > maximum) {
      return null;
    }

    previous = current;
  }

  const distance =
    previous[right.length] ??
    Number.POSITIVE_INFINITY;

  return distance <= maximum
    ? distance
    : null;
}

function isBlacklistedHallucination(
  clause: string,
): boolean {
  const normalized = clause
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();

  return HALLUCINATION_PHRASE_BLACKLIST
    .some((pattern) =>
      pattern.test(normalized),
    );
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
