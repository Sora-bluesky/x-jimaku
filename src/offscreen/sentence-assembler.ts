import type {
  RecognitionLine,
} from "./segmenter";

export const MAX_SENTENCE_WORDS = 20;
export const SENTENCE_ASSEMBLY_TIMEOUT_MS =
  4_000;

export interface SentenceAssemblerOptions {
  onLine(
    requestId: string,
    line: RecognitionLine,
  ): void;
}

export class SentenceAssembler {
  private readonly onLine:
    SentenceAssemblerOptions["onLine"];
  private activeRequestId:
    | string
    | null = null;
  private readonly bundledLines:
    RecognitionLine[] = [];
  private timerId: ReturnType<typeof globalThis.setTimeout> | null = null;
  private destroyed = false;

  constructor(
    options: SentenceAssemblerOptions,
  ) {
    this.onLine = options.onLine;
  }

  startCapture(requestId: string): void {
    if (
      this.destroyed ||
      this.activeRequestId === requestId
    ) {
      return;
    }

    this.discardBundle();
    this.activeRequestId = requestId;
  }

  accept(
    requestId: string,
    line: RecognitionLine,
  ): void {
    if (this.destroyed) {
      return;
    }

    this.startCapture(requestId);

    if (!line.final) {
      this.onLine(requestId, line);
      return;
    }

    const text = line.text.trim();

    if (text === "") {
      return;
    }

    this.bundledLines.push({
      ...line,
      text,
    });

    const bundledText =
      this.getBundledText();

    if (
      hasSentenceFinalPunctuation(
        bundledText,
      ) ||
      countWords(bundledText) >=
        MAX_SENTENCE_WORDS
    ) {
      this.emitBundle();
      return;
    }

    this.ensureTimer();
  }

  flush(requestId: string): void {
    if (
      this.destroyed ||
      this.activeRequestId !== requestId
    ) {
      return;
    }

    this.emitBundle();
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.discardBundle();
    this.activeRequestId = null;
  }

  private ensureTimer(): void {
    if (this.timerId !== null) {
      return;
    }

    this.timerId =
      globalThis.setTimeout(() => {
        this.timerId = null;
        this.emitBundle();
      }, SENTENCE_ASSEMBLY_TIMEOUT_MS);
  }

  private emitBundle(): void {
    const requestId =
      this.activeRequestId;
    const lastLine =
      this.bundledLines.at(-1);
    const text = this.getBundledText();

    this.cancelTimer();
    this.bundledLines.length = 0;

    if (
      requestId === null ||
      lastLine === undefined ||
      text === ""
    ) {
      return;
    }

    this.onLine(requestId, {
      ...lastLine,
      text,
      final: true,
    });
  }

  private discardBundle(): void {
    this.cancelTimer();
    this.bundledLines.length = 0;
  }

  private cancelTimer(): void {
    if (this.timerId === null) {
      return;
    }

    globalThis.clearTimeout(
      this.timerId,
    );
    this.timerId = null;
  }

  private getBundledText(): string {
    return this.bundledLines
      .map((line) => line.text.trim())
      .filter((text) => text !== "")
      .join(" ");
  }
}

function hasSentenceFinalPunctuation(
  text: string,
): boolean {
  if (/[?!]$/u.test(text)) {
    return true;
  }

  return (
    /\.$/u.test(text) &&
    !/\b[A-Z]\.$/u.test(text)
  );
}

function countWords(text: string): number {
  return text === ""
    ? 0
    : text.split(/\s+/u).length;
}
