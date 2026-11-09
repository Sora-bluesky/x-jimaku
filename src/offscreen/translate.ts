import type { OffDevLogMessage, RecognitionPayload, TranslationPath, TranslationRung } from "../shared/messages";

export { TRANSLATION_DEADLINE_MS } from "../shared/translation-timing";
export const MAX_PENDING_TRANSLATIONS = 2;
export const TRANSLATION_DRAIN_TIMEOUT_MS = 8_000;

export interface TranslationQueueEntry
  extends RecognitionPayload {
  skipTranslation?: boolean;
}

export interface TranslationEnqueueOptions {
  stopFlush?: boolean;
}

export interface TranslationEngineOptions {
  requestId?: string;
  onTranslated(
    line: RecognitionPayload,
    ja: string,
    rung: TranslationRung,
  ): void;
  onSettled?(ids: number[]): void;
  onPathChanged(path: TranslationPath): void;
  onDevLog?(
    message: OffDevLogMessage,
  ): void | Promise<void>;
}

export interface TranslationEngineContract {
  initialize(): Promise<void>;
  enqueue(line: TranslationQueueEntry, options?: TranslationEnqueueOptions): void;
  getPath(): TranslationPath | null;
  drain(): Promise<boolean>;
  destroy(): void;
  setContextReady?(terms: readonly string[]): void;
}

export function isMostlyJapanese(
  text: string,
): boolean {
  const characters =
    Array.from(text).filter(
      (character) =>
        !/\s/u.test(character),
    );

  if (characters.length === 0) {
    return false;
  }

  let japaneseCharacters = 0;

  for (const character of characters) {
    if (
      /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(
        character,
      )
    ) {
      japaneseCharacters += 1;
    }
  }

  return (
    japaneseCharacters /
      characters.length >
    0.3
  );
}
