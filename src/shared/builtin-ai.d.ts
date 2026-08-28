export {};

declare global {
  type BuiltinTranslatorAvailability =
    | "unavailable"
    | "downloadable"
    | "downloading"
    | "available";

  type BuiltinLanguageModelAvailability =
    | "unavailable"
    | "downloadable"
    | "downloading"
    | "available";

  interface BuiltinAiDownloadProgressEvent
    extends Event {
    readonly loaded: number;
    readonly total?: number;
  }

  interface BuiltinAiMonitor {
    addEventListener(
      type: "downloadprogress",
      listener: (
        event:
          BuiltinAiDownloadProgressEvent,
      ) => void,
    ): void;
  }

  interface TranslatorOptions {
    sourceLanguage: string;
    targetLanguage: string;
  }

  interface TranslatorCreateOptions
    extends TranslatorOptions {
    monitor?(
      monitor: BuiltinAiMonitor,
    ): void;
  }

  interface TranslatorInstance {
    translate(input: string): Promise<string>;
    destroy(): void;
  }

  interface TranslatorFactory {
    availability(
      options: TranslatorOptions,
    ): Promise<BuiltinTranslatorAvailability>;

    create(
      options: TranslatorCreateOptions,
    ): Promise<TranslatorInstance>;
  }

  interface LanguageModelPrompt {
    role: "system" | "user" | "assistant";
    content: string;
  }

  interface LanguageModelExpected {
    type: "text";
    languages?: readonly string[];
  }

  interface LanguageModelCreateOptions {
    initialPrompts?: readonly LanguageModelPrompt[];
    expectedOutputs?: readonly LanguageModelExpected[];
  }

  interface LanguageModelSessionOperationOptions {
    signal?: AbortSignal;
  }

  interface LanguageModelSession {
    clone(
      options?:
        LanguageModelSessionOperationOptions,
    ): Promise<LanguageModelSession>;

    prompt(
      input: string,
      options?:
        LanguageModelSessionOperationOptions,
    ): Promise<string>;

    destroy(): void;
  }

  interface LanguageModelFactory {
    availability(): Promise<BuiltinLanguageModelAvailability>;

    create(
      options?: LanguageModelCreateOptions,
    ): Promise<LanguageModelSession>;
  }

  var Translator: TranslatorFactory;
  var LanguageModel: LanguageModelFactory;
}
